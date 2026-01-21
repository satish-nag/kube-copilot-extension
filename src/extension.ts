import * as vscode from "vscode";
import { executeTool, isMutating, loadKubeConfig, ToolCall, ToolResult } from "./kubernetes";
import { jsonrepair } from "jsonrepair";

/* =========================================================
 * Types
 * ========================================================= */

type Plan = {
  summary: string;
  toolCalls: ToolCall[];
  done: boolean; // Indicates if the agent has completed the task
};

type PendingAction = {
  originalUserText: string;
  plan: Plan;
  pendingToolCalls: ToolCall[];
  priorResults: ToolResult[];
};

/* =========================================================
 * In-memory state (POC-safe)
 * ========================================================= */

const pendingBySession = new Map<string, PendingAction>();

function getSessionKey(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "no-workspace";
}

/* =========================================================
 * Extension activate
 * ========================================================= */

export function activate(context: vscode.ExtensionContext) {
  console.log("Kube extension activated. vscode.lm ===", (vscode as any).lm);

  const participant = vscode.chat.createChatParticipant(
    "kubeCopilot.kube",
    async (request, _chatContext, stream, token) => {
      await handleChatRequest(request, stream, token);
    }
  );

  context.subscriptions.push(participant);
  vscode.commands.registerCommand('kubeCopilot.kube.confirm', async () => {
    vscode.commands.executeCommand('workbench.action.chat.open', '@kube confirm')
  });
  vscode.commands.registerCommand('kubeCopilot.kube.cancel', async () => {
    vscode.commands.executeCommand('workbench.action.chat.open', '@kube cancel')
  });
}


export function deactivate() { }

type ExtensionConfig = {
  defaultNamespace: string;
  allowedNamespaces: Set<string>;
  maxReplicas: number;
  allowedImages: string[];
};

async function handleChatRequest(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  const userText = (request.prompt ?? "").trim();
  if (!userText) {
    stream.markdown(helpText());
    return;
  }

  const cfg = getExtensionConfig();
  const kc = loadKubeConfig(stream);
  if (!kc) return;

  const sessionKey = getSessionKey();
  const pending = pendingBySession.get(sessionKey);

  if (pending) {
    const handled = await handlePendingAction(
      userText,
      pending,
      sessionKey,
      kc,
      cfg,
      stream,
      request.model.family,
      token
    );
    if (handled) return;
  }

  await runAgentLoop(
    userText,
    kc,
    cfg,
    sessionKey,
    stream,
    token,
    request.model.family
  );
}

function getExtensionConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("kubeCopilot");
  return {
    defaultNamespace: cfg.get<string>("namespace") ?? "dev",
    allowedNamespaces: new Set(cfg.get<string[]>("allowNamespaces") ?? ["dev"]),
    maxReplicas: cfg.get<number>("maxReplicas") ?? 20,
    allowedImages: cfg.get<string[]>("allowedImages") ?? []
  };
}

async function handlePendingAction(
  userText: string,
  pending: PendingAction,
  sessionKey: string,
  kc: import("@kubernetes/client-node").KubeConfig,
  cfg: ExtensionConfig,
  stream: vscode.ChatResponseStream,
  modelFamily: string,
  token: vscode.CancellationToken
): Promise<boolean> {
  if (/^(confirm|yes|proceed|ok)$/i.test(userText)) {
    stream.markdown("✅ Confirmed. Executing changes…");

    const results: ToolResult[] = [...pending.priorResults];
    for (const call of pending.pendingToolCalls) {
      results.push(await executeTool(kc, call, cfg.allowedNamespaces, cfg.allowedImages, cfg.maxReplicas));
    }

    pendingBySession.delete(sessionKey);
    if (!pending.plan.done) {
      await runAgentLoop(
        pending.originalUserText,
        kc,
        cfg,
        sessionKey,
        stream,
        token,
        modelFamily,
        results
      );
      return true;
    }

    await formatWithLm(pending.originalUserText, pending.plan.summary, results, stream, modelFamily);
    return true;
  }

  if (/^(cancel|no|stop)$/i.test(userText)) {
    pendingBySession.delete(sessionKey);
    stream.markdown("❌ Cancelled. No changes were made.");
    return true;
  }

  return false;
}

async function runAgentLoop(
  userText: string,
  kc: import("@kubernetes/client-node").KubeConfig,
  cfg: ExtensionConfig,
  sessionKey: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  modelFamily: string,
  initialResults?: ToolResult[]
): Promise<void> {
  const MAX_ITERATIONS = 10;
  const allResults: ToolResult[] = initialResults ? [...initialResults] : [];
  let currentSummary = "";
  let iterationCount = 0;

  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;
    console.log(`\n=== Iteration ${iterationCount} ===`);

    let plan: Plan;
    try {
      plan = await planWithLm(
        userText,
        {
          defaultNamespace: cfg.defaultNamespace,
          allowedNamespaces: [...cfg.allowedNamespaces],
          maxReplicas: cfg.maxReplicas,
          allowedImages: cfg.allowedImages
        },
        allResults,
        token,
        modelFamily
      );
    } catch (e: any) {
      stream.markdown(`❌ Failed to plan request: \`${e.message}\``);
      return;
    }

    console.log(`Plan (iteration ${iterationCount}):`, JSON.stringify(plan));
    currentSummary = plan.summary;

    if (plan.toolCalls.length === 0 && plan.done) {
      console.log("Agent marked as done with no tool calls");
      break;
    }

    const { readonlyCalls, mutatingCalls } = splitToolCalls(plan.toolCalls);
    console.log("readonlyCalls:", JSON.stringify(readonlyCalls));
    console.log("mutatingCalls:", JSON.stringify(mutatingCalls));

    await executeReadonlyCalls(kc, readonlyCalls, cfg, allResults);
    console.log("Current results:", JSON.stringify(allResults));

    if (mutatingCalls.length > 0) {
      queuePendingActions(sessionKey, userText, plan, mutatingCalls, allResults);
      promptForConfirmation(stream, plan, mutatingCalls);
      return;
    }

    if (plan.done) {
      console.log("Agent marked as done");
      break;
    }
  }

  if (iterationCount >= MAX_ITERATIONS) {
    stream.markdown(`⚠️ Reached maximum iterations (${MAX_ITERATIONS}). Stopping.\n\n`);
  }

  await formatWithLm(userText, currentSummary, allResults, stream, modelFamily);
}

function splitToolCalls(toolCalls: ToolCall[]): { readonlyCalls: ToolCall[]; mutatingCalls: ToolCall[] } {
  return {
    readonlyCalls: toolCalls.filter(c => !isMutating(c.tool)),
    mutatingCalls: toolCalls.filter(c => isMutating(c.tool))
  };
}

async function executeReadonlyCalls(
  kc: import("@kubernetes/client-node").KubeConfig,
  calls: ToolCall[],
  cfg: ExtensionConfig,
  allResults: ToolResult[]
): Promise<void> {
  for (const call of calls) {
    const result = await executeTool(kc, call, cfg.allowedNamespaces, cfg.allowedImages, cfg.maxReplicas);
    allResults.push(result);
  }
}

function queuePendingActions(
  sessionKey: string,
  userText: string,
  plan: Plan,
  mutatingCalls: ToolCall[],
  priorResults: ToolResult[]
): void {
  pendingBySession.set(sessionKey, {
    originalUserText: userText,
    plan,
    pendingToolCalls: mutatingCalls,
    priorResults
  });
}

function promptForConfirmation(
  stream: vscode.ChatResponseStream,
  plan: Plan,
  mutatingCalls: ToolCall[]
): void {
  stream.markdown(
    `### Planned changes\n` +
    `**${plan.summary}**\n\n` +
    mutatingCalls.map(c => `- **${c.tool}** ${JSON.stringify(c.args)} \n Behaviour: ${c.args.note || ""}`).join("\n") +
    `\n\nClick **confirm** to proceed or **cancel** to stop.`
  );
  stream.button({
    command: 'kubeCopilot.kube.confirm',
    title: vscode.l10n.t('Confirm')
  });
  stream.button({
    command: 'kubeCopilot.kube.cancel',
    title: vscode.l10n.t('Cancel')
  });
}


/* =========================================================
 * Planner (Copilot LLM)
 * ========================================================= */

async function planWithLm(
  userText: string,
  ctx: any,
  priorResults: ToolResult[],
  token: vscode.CancellationToken,
  modelFamily: string
): Promise<Plan> {
  const lm = vscode.lm;
  if (!lm) throw new Error("Language Model API not available");

  // Prefer the UI-selected model, fall back to Copilot vendor
  const models = (await lm.selectChatModels({ family: modelFamily }));
  if (!models) throw new Error("No Copilot model available");
  console.log("Using model:", models);
  console.log("ctx:", ctx);
  const model = models[0];
  const system = `
You are a Kubernetes planning engine for a VS Code extension.

Output MUST be a single valid JSON object and NOTHING else.
- Do not wrap in Markdown fences.
- Do not add comments, trailing commas, or extra keys.
- Do not echo the user request.
- Do not include explanations.

Your response must match this schema:

schema:
{
  "summary": string,
  "toolCalls": [
    { "tool": "...", "args": { ... }  }
  ],
  "done": boolean
}

IMPORTANT ABOUT THE FIELDS:
- ALL RESPONSES MUST OBEY THE SCHEMA ABOVE
- All information about the user's request,solution,analysis and everything must be captured in the "summary" field.
- If any tool call is mutating (create/update/scale/delete), provide a detailed description about the behaviour of that operation after the change is applied for EACH mutating call and append it to summary.

Allowed tools:
listNamespaces, listNamespacedPod, listNamespacedEvent, listNamespacedDeployment, listNamespacedService, getService, listIstioObject, getIstioObject, getNamespace, createNamespace, createPod, createDeployment, updateDeployment, updateDeploymentImage, createIstioObject, updateIstioObject, createService, updateService, deleteDeployment, scaleDeployment, getDeploymentStatus

createPod args: { namespace: string, name: string, image: string }
createDeployment args: { namespace: string, name: string, image: string, replicas?: number, port?: number }
updateDeployment args: { namespace: string, name: string, patch: object } // patch is a strategic merge patch object for the deployment with updated fields
updateDeploymentImage args: { namespace: string, name: string, image: string }
deleteDeployment args: { namespace: string, name: string }
createService args: { namespace: string, name: string, selector: object, port: number, targetPort?: number, type?: string }
updateService args: { namespace: string, name: string, selector?: object, port?: number, targetPort?: number, type?: string }
createIstioObject args: { namespace: string, kind: string, manifest: object }
updateIstioObject args: { namespace: string, kind: string, name: string, patch: object }
scaleDeployment args: { namespace: string, name: string, replicas: number }
listNamespacedPod args: { namespace: string, labelSelector?: string, fieldSelector?: string, limit?: number, continueToken?: string }
listNamespacedEvent args: { namespace: string, podName?: string }
listNamespacedDeployment args: { namespace: string, labelSelector?: string, fieldSelector?: string, limit?: number, continueToken?: string }
listNamespacedService args: { namespace: string, labelSelector?: string, fieldSelector?: string, limit?: number, continueToken?: string }
listIstioObject args: { namespace: string, kind: string, labelSelector?: string, fieldSelector?: string, limit?: number, continueToken?: string } // kind can be VirtualService, DestinationRule, Gateway, etc.
getIstioObject args: { namespace: string, kind: string, name: string }
getService args: { namespace: string, name: string }
getNamespace args: { name: string }
createNamespace args: { name: string }
getDeploymentStatus args: { namespace: string, name: string }

IMPORTANT MULTI-STEP LOGIC:
- If you need information from one tool before calling another, plan ONE step at a time
- If mutating tool calls depend on each other, plan ONLY the prerequisite mutating tool calls first and set "done": false so the next iteration can plan the dependent calls
- If multiple mutating tools are required and they do NOT depend on each other, include all of them in the same plan so they can be confirmed together
- Set "done": false if you need to call more tools in the next iteration
- Set "done": true when you have all the information needed to answer the user
- Always look at events from listNamespacedEvent to determine pod health,failure reasons, etc.
- Example: To list all pods in all namespaces:
  * First iteration: Call listNamespaces, set done=false
  * Second iteration: Use the namespace results to call listNamespacedPod for each namespace, set done=true
- Always include istio resources when analyzing services, deployments, pods.
Previous tool results will be provided to help you plan the next step.
- For list calls, always include limit (e.g., 50) and prefer labelSelector/fieldSelector when possible. Use continueToken to paginate.”

If the request is simple (like listing namespaces), still return JSON with done=true.
If unsure, choose the safest read-only tool.
`;

  const messages = [
    vscode.LanguageModelChatMessage.User(`User request: ${userText}`),
    vscode.LanguageModelChatMessage.Assistant(`Context: ${system}`)
  ];

  // Include previous results if available
  if (priorResults.length > 0) {
    messages.push(
      vscode.LanguageModelChatMessage.User(
        `Previous tool results:\n${JSON.stringify(priorResults, null, 2)}\n\nBased on these results, what should be the next step? Set done=true if you have enough information.`
      )
    );
  }

  const resp = await model.sendRequest(messages, undefined, token);
  let rawText = "";
  for await (const chunk of resp.text) {
    rawText += chunk;
  }
  console.log("LM full response:", rawText);

  if (!rawText) {
    console.warn("Copilot returned empty response, using fallback planner");
    return fallbackPlan(userText, ctx.defaultNamespace, priorResults);
  }

  try {
    const cleanedJson = jsonrepair(rawText.replace("```json", "").replace("```", ""));
    console.log("Cleaned JSON:", cleanedJson);
    const parsedJson = JSON.parse(cleanedJson);
    // if cleanedJson is type of array
    if (Array.isArray(parsedJson)) {
      // return the element that is json and contains summary, toolCalls, done
      for (const element of parsedJson) {
        // element may be object or a JSON string; normalize to object
        console.log("Element type:", typeof element, element);
        const elementJson = typeof element === "string" && element.trim().startsWith("{") ? JSON.parse(element) : element;
        if (
          elementJson &&
          typeof elementJson === "object" &&
          "summary" in elementJson &&
          "toolCalls" in elementJson &&
          "done" in elementJson &&
          typeof (elementJson as any).done === "boolean"
        ) {
          return elementJson as Plan;
        }
      }
    }
    return parsedJson as Plan;
  } catch (err) {
    console.warn("Invalid JSON from Copilot, using fallback planner", err);
    return fallbackPlan(userText, ctx.defaultNamespace, priorResults);
  }
}

function extractTextFromLmResponse(resp: any): string {
  if (!resp) return "";

  // Preferred: structured content
  if (Array.isArray(resp.content)) {
    return resp.content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("")
      .trim();
  }

  // Fallbacks
  if (typeof resp.text === "string") return resp.text.trim();
  if (typeof resp.content === "string") return resp.content.trim();

  return "";
}

function fallbackPlan(userText: string, defaultNamespace: string, priorResults: ToolResult[]): Plan {
  const text = userText.toLowerCase();

  // If we already have namespace results, list pods in those namespaces
  if (priorResults.length > 0 && priorResults[0].tool === "listNamespaces") {
    const namespaces = priorResults[0].result as string[];
    if (text.includes("pod") && text.includes("all")) {
      return {
        summary: "List pods in all namespaces",
        toolCalls: namespaces.map(ns => ({
          tool: "listNamespacedPod",
          args: { namespace: ns }
        })),
        done: true
      };
    }
  }

  // List namespaces
  if (text.includes("namespace") && (text.includes("list") || text.includes("what"))) {
    return {
      summary: "List all namespaces",
      toolCalls: [{ tool: "listNamespaces", args: {} }],
      done: true
    };
  }

  // List all pods in all namespaces (first step)
  if (text.includes("pod") && text.includes("all")) {
    return {
      summary: "List all namespaces first",
      toolCalls: [{ tool: "listNamespaces", args: {} }],
      done: false // Need to list pods after getting namespaces
    };
  }

  // Deploy nginx pod
  if (text.includes("deploy") && text.includes("nginx")) {
    return {
      summary: "Deploy nginx pod",
      toolCalls: [
        { tool: "getNamespace", args: { name: defaultNamespace } },
        {
          tool: "createPod",
          args: {
            namespace: defaultNamespace,
            name: "nginx",
            image: "nginx:latest"
          }
        }
      ],
      done: true
    };
  }

  // Create deployment
  const createDepMatch = text.match(/(?:create|deploy)\s+deployment\s+(\S+)/);
  if (createDepMatch) {
    return {
      summary: `Create deployment ${createDepMatch[1]}`,
      toolCalls: [
        {
          tool: "createDeployment",
          args: {
            namespace: defaultNamespace,
            name: createDepMatch[1],
            image: "nginx:latest"
          }
        }
      ],
      done: true
    };
  }

  // Update deployment image
  const updateImageMatch = text.match(/update\s+deployment\s+(\S+).*image\s+(\S+)/);
  if (updateImageMatch) {
    return {
      summary: `Update deployment ${updateImageMatch[1]} image`,
      toolCalls: [
        {
          tool: "updateDeploymentImage",
          args: {
            namespace: defaultNamespace,
            name: updateImageMatch[1],
            image: updateImageMatch[2]
          }
        }
      ],
      done: true
    };
  }

  // Delete deployment
  const deleteDepMatch = text.match(/(?:delete|remove)\s+deployment\s+(\S+)/);
  if (deleteDepMatch) {
    return {
      summary: `Delete deployment ${deleteDepMatch[1]}`,
      toolCalls: [
        {
          tool: "deleteDeployment",
          args: {
            namespace: defaultNamespace,
            name: deleteDepMatch[1]
          }
        }
      ],
      done: true
    };
  }

  // List deployments
  if (text.includes("deployment") && (text.includes("list") || text.includes("show"))) {
    return {
      summary: "List deployments",
      toolCalls: [{ tool: "listNamespacedDeployment", args: { namespace: defaultNamespace } }],
      done: true
    };
  }

  // Create service
  const createSvcMatch = text.match(/(?:create|expose)\s+service\s+(\S+)/);
  if (createSvcMatch) {
    return {
      summary: `Create service ${createSvcMatch[1]}`,
      toolCalls: [
        {
          tool: "createService",
          args: {
            namespace: defaultNamespace,
            name: createSvcMatch[1],
            selector: { app: createSvcMatch[1] },
            port: 80
          }
        }
      ],
      done: true
    };
  }

  // Update service
  const updateSvcMatch = text.match(/update\s+service\s+(\S+)/);
  if (updateSvcMatch) {
    return {
      summary: `Update service ${updateSvcMatch[1]}`,
      toolCalls: [
        {
          tool: "updateService",
          args: {
            namespace: defaultNamespace,
            name: updateSvcMatch[1],
            port: 80
          }
        }
      ],
      done: true
    };
  }

  // Get service
  const getSvcMatch = text.match(/(?:get|describe)\s+service\s+(\S+)/);
  if (getSvcMatch) {
    return {
      summary: `Get service ${getSvcMatch[1]}`,
      toolCalls: [
        {
          tool: "getService",
          args: {
            namespace: defaultNamespace,
            name: getSvcMatch[1]
          }
        }
      ],
      done: true
    };
  }

  // List services
  if (text.includes("service") && (text.includes("list") || text.includes("show"))) {
    return {
      summary: "List services",
      toolCalls: [{ tool: "listNamespacedService", args: { namespace: defaultNamespace } }],
      done: true
    };
  }

  // Scale deployment
  const scaleMatch = text.match(/scale\s+(\S+)\s+to\s+(\d+)/);
  if (scaleMatch) {
    return {
      summary: `Scale deployment ${scaleMatch[1]} to ${scaleMatch[2]}`,
      toolCalls: [
        {
          tool: "scaleDeployment",
          args: {
            name: scaleMatch[1],
            namespace: defaultNamespace,
            replicas: Number(scaleMatch[2])
          }
        }
      ],
      done: true
    };
  }

  throw new Error("Unable to understand request");
}

/* =========================================================
 * Response formatting
 * ========================================================= */

async function formatWithLm(userText: string, summary: string, results: ToolResult[], stream: vscode.ChatResponseStream, modelFamily: string): Promise<string> {
  const lm = vscode.lm;
  if (!lm) return JSON.stringify(results, null, 2);

  // Prefer the UI-selected model, fall back to Copilot vendor
  const model = (await lm.selectChatModels({ family: modelFamily }))[0];
  if (!model) return JSON.stringify(results, null, 2);

  const messages = [
    vscode.LanguageModelChatMessage.User(`Request: ${userText}\nSummary: ${summary}\nResults: ${JSON.stringify(results)}`),
    vscode.LanguageModelChatMessage.Assistant(`Format a concise markdown response. Explain what happened, successes, and any failures.`)
  ]

  const resp = await model.sendRequest(
    messages
  );

  let responseText = "";
  for await (const chunk of resp.text) {
    responseText += chunk;
    stream.markdown(chunk)
  }
  return responseText;
}

/* =========================================================
 * Help
 * ========================================================= */

function helpText(): string {
  return `
Ask Kubernetes questions in natural language.

Examples:
- Deploy nginx pod in test namespace
- Create deployment web in dev namespace
- Create service web in dev namespace
- Scale payments service to 3 replicas
- What namespaces exist?
- Is my-app healthy?

You will be asked to **confirm** before any changes are made.
`;
}
