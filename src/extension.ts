import * as vscode from "vscode";
import * as k8s from "@kubernetes/client-node";

/* =========================================================
 * Types
 * ========================================================= */

type ToolName =
  | "listNamespaces"
  | "listNamespacedPod"
  | "listNamespacedEvent"
  | "getNamespace"
  | "createNamespace"
  | "createPod"
  | "scaleDeployment"
  | "getDeploymentStatus";

type ToolCall = {
  tool: ToolName;
  args: Record<string, any>;
};

type Plan = {
  summary: string;
  toolCalls: ToolCall[];
  done: boolean; // Indicates if the agent has completed the task
};

type ToolResult = {
  tool: ToolName;
  args: Record<string, any>;
  ok: boolean;
  result: any;
};

type PendingAction = {
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
      const userText = (request.prompt ?? "").trim();
      if (!userText) {
        stream.markdown(helpText());
        return;
      }

      const cfg = vscode.workspace.getConfiguration("kubeCopilot");
      const defaultNamespace = cfg.get<string>("namespace") ?? "dev";
      const allowedNamespaces = new Set(cfg.get<string[]>("allowNamespaces") ?? ["dev"]);
      const maxReplicas = cfg.get<number>("maxReplicas") ?? 20;
      const allowedImages = cfg.get<string[]>("allowedImages") ?? [];

      /* ---------------------------------------------
       * Load kubeconfig
       * --------------------------------------------- */
      const kc = new k8s.KubeConfig();
      try {
        kc.loadFromDefault();
      } catch (e: any) {
        stream.markdown(`❌ Failed to load kubeconfig: \`${e.message}\``);
        return;
      }

      const sessionKey = getSessionKey();

      /* ---------------------------------------------
       * Handle confirm / cancel
       * --------------------------------------------- */
      const pending = pendingBySession.get(sessionKey);
      if (pending && /^(confirm|yes|proceed|ok)$/i.test(userText)) {
        stream.markdown("✅ Confirmed. Executing changes…");

        const results: ToolResult[] = [...pending.priorResults];
        for (const call of pending.pendingToolCalls) {
          results.push(await executeTool(kc, call, allowedNamespaces, allowedImages, maxReplicas));
        }

        pendingBySession.delete(sessionKey);
        const formatted = await formatWithLm(userText, pending.plan.summary, results, stream,request.model.family);
        return;
      }

      if (pending && /^(cancel|no|stop)$/i.test(userText)) {
        pendingBySession.delete(sessionKey);
        stream.markdown("❌ Cancelled. No changes were made.");
        return;
      }

      /* ---------------------------------------------
       * Iterative Agent Loop
       * --------------------------------------------- */
      const MAX_ITERATIONS = 5;
      const allResults: ToolResult[] = [];
      let currentSummary = "";
      let iterationCount = 0;

      while (iterationCount < MAX_ITERATIONS) {
        iterationCount++;
        console.log(`\n=== Iteration ${iterationCount} ===`);

        /* ---------------------------------------------
         * Plan with Copilot LLM
         * --------------------------------------------- */
        let plan: Plan;
        try {
          plan = await planWithLm(
            userText,
            {
              defaultNamespace,
              allowedNamespaces: [...allowedNamespaces],
              maxReplicas,
              allowedImages
            },
            allResults, // Pass previous results
            token,
            request.model.family
          );
        } catch (e: any) {
          stream.markdown(`❌ Failed to plan request: \`${e.message}\``);
          return;
        }

        console.log(`Plan (iteration ${iterationCount}):`, JSON.stringify(plan));
        currentSummary = plan.summary;

        // If no tool calls and done, break
        if (plan.toolCalls.length === 0 && plan.done) {
          console.log("Agent marked as done with no tool calls");
          break;
        }

        /* ---------------------------------------------
         * Execute read-only tools
         * --------------------------------------------- */
        const readonlyCalls = plan.toolCalls.filter(c => !isMutating(c.tool));
        const mutatingCalls = plan.toolCalls.filter(c => isMutating(c.tool));

        console.log("readonlyCalls:", JSON.stringify(readonlyCalls));
        console.log("mutatingCalls:", JSON.stringify(mutatingCalls));

        for (const call of readonlyCalls) {
          const result = await executeTool(kc, call, allowedNamespaces, allowedImages, maxReplicas);
          allResults.push(result);
        }

        console.log("Current results:", JSON.stringify(allResults));

        /* ---------------------------------------------
         * Ask for confirmation if needed
         * --------------------------------------------- */
        if (mutatingCalls.length > 0) {
          pendingBySession.set(sessionKey, {
            plan,
            pendingToolCalls: mutatingCalls,
            priorResults: allResults
          });

          stream.markdown(
            `### Planned changes\n` +
            `**${plan.summary}**\n\n` +
            mutatingCalls.map(c => `- **${c.tool}** ${JSON.stringify(c.args)}`).join("\n") +
            `\n\nReply **confirm** to proceed or **cancel** to stop.`
          );
          return;
        }

        /* ---------------------------------------------
         * Check if agent is done
         * --------------------------------------------- */
        if (plan.done) {
          console.log("Agent marked as done");
          break;
        }
      }

      if (iterationCount >= MAX_ITERATIONS) {
        stream.markdown(`⚠️ Reached maximum iterations (${MAX_ITERATIONS}). Stopping.\n\n`);
      }

      /* ---------------------------------------------
       * Format final response
       * --------------------------------------------- */
      const formatted = await formatWithLm(userText, currentSummary, allResults, stream, request.model.family);
    }
  );

  context.subscriptions.push(participant);
}

export function deactivate() { }

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

You MUST ALWAYS return valid JSON.
You MUST NEVER return an empty response.
You MUST NOT explain anything.

Output ONLY this JSON format:

{
  "summary": string,
  "toolCalls": [
    { "tool": "...", "args": { ... } }
  ],
  "done": boolean
}

Allowed tools:
listNamespaces, listNamespacedPod, listNamespacedEvent, getNamespace, createNamespace, createPod, scaleDeployment, getDeploymentStatus

IMPORTANT MULTI-STEP LOGIC:
- If you need information from one tool before calling another, plan ONE step at a time
- Set "done": false if you need to call more tools in the next iteration
- Set "done": true when you have all the information needed to answer the user
- Example: To list all pods in all namespaces:
  * First iteration: Call listNamespaces, set done=false
  * Second iteration: Use the namespace results to call listNamespacedPod for each namespace, set done=true

Previous tool results will be provided to help you plan the next step.

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
    return JSON.parse(rawText);
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
 * Tool execution
 * ========================================================= */

function isMutating(tool: ToolName): boolean {
  return tool === "createNamespace" || tool === "createPod" || tool === "scaleDeployment";
}

async function executeTool(
  kc: k8s.KubeConfig,
  call: ToolCall,
  allowedNamespaces: Set<string>,
  allowedImages: string[],
  maxReplicas: number
): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case "listNamespaces": {
        const core = kc.makeApiClient(k8s.CoreV1Api);
        const res = await core.listNamespace();
        console.log("res: " + JSON.stringify(res))
        return ok(call, res.body.items.map(i => i.metadata?.name).filter(Boolean));
      }

      case "listNamespacedPod": {
        const namespace = call.args.namespace;
        if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const res = await core.listNamespacedPod(namespace);
        console.log("res: " + JSON.stringify(res))
        return ok(call, res.body.items);
      }

      case "listNamespacedEvent": {
        const namespace = call.args.namespace || "default";
        const podName = call.args.podName;

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const res = await core.listNamespacedEvent(namespace, undefined, undefined, undefined, `involvedObject.namespace=${namespace}`);
        console.log("res: " + JSON.stringify(res))
        return ok(call, res.body.items.map(i => {
          return {
            "name": i.metadata?.name,
            "message": i?.message,
            "namespace": i.metadata?.namespace
          }
        }));
      }

      case "getNamespace": {
        const core = kc.makeApiClient(k8s.CoreV1Api);
        const res = await core.readNamespace(call.args.name);
        console.log("res: " + JSON.stringify(res))
        return ok(call, { name: res.body.metadata?.name });
      }

      case "createNamespace": {
        const name = call.args.name;
        const core = kc.makeApiClient(k8s.CoreV1Api);
        const res = await core.createNamespace({ metadata: { name } } as any);
        console.log("res: " + JSON.stringify(res))
        return ok(call, { name: res.body.metadata?.name });
      }

      case "createPod": {
        const { namespace, name, image } = call.args;
        if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        if (allowedImages.length && !allowedImages.some(p => image.startsWith(p)))
          throw new Error("Image not allowed");

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const pod: k8s.V1Pod = {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name },
          spec: {
            restartPolicy: "Never",
            containers: [{ name: "main", image }]
          }
        };
        const res = await core.createNamespacedPod(namespace, pod);
        return ok(call, { name: res.body.metadata?.name });
      }

      case "scaleDeployment": {
        const { namespace, name, replicas } = call.args;

        const apps = kc.makeApiClient(k8s.AppsV1Api);

        const res = await apps.replaceNamespacedDeploymentScale(
          name,
          namespace,
          {
            apiVersion: "autoscaling/v1",
            kind: "Scale",
            spec: { replicas }
          } as any
        );

        return ok(call, res.body);
      }

      case "getDeploymentStatus": {
        const apps = kc.makeApiClient(k8s.AppsV1Api);
        const res = await apps.readNamespacedDeployment(call.args.name, call.args.namespace);
        return ok(call, res.body.status);
      }
    }
  } catch (e: any) {
    return { tool: call.tool, args: call.args, ok: false, result: e.message };
  }
}

function ok(call: ToolCall, result: any): ToolResult {
  return { tool: call.tool, args: call.args, ok: true, result };
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
- Scale payments service to 3 replicas
- What namespaces exist?
- Is my-app healthy?

You will be asked to **confirm** before any changes are made.
`;
}