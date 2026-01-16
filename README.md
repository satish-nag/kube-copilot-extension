# Kube Copilot VS Code Extension

Operate your Kubernetes clusters directly from VS Code using natural language.
Kube Copilot integrates with the GitHub Copilot Chat UI to **plan**, **simulate**, and (optionally) **execute** Kubernetes operations with explicit user confirmation.

Main extension entrypoint: `activate` in `src/extension.ts`.

---

## Features

- Chat-based Kubernetes assistant available as a **Copilot Chat participant** (`kubeCopilot.kube`).
- Iterative **planning agent**:
  - Plans operations using the VS Code Language Model API (`vscode.lm`).
  - Executes **read-only** calls automatically.
  - Requires **explicit confirmation** before any mutating action.
- Supported Kubernetes operations (via `@kubernetes/client-node`):
  - `listNamespaces`
  - `listNamespacedPod`
  - `listNamespacedEvent`
  - `getNamespace`
  - `createNamespace`
  - `createPod`
  - `scaleDeployment`
  - `getDeploymentStatus`
- Safety controls:
  - Namespace allowlist.
  - Optional image allowlist.
  - Optional max replica limit for scaling.

Planning and tool execution logic lives in `src/extension.ts`.

---

## Prerequisites

- **VS Code**: `>= 1.96.2`
- **GitHub Copilot Chat** extension (dependency: `github.copilot-chat`).
- **Node.js**: Current LTS (recommended).
- A working **Kubernetes cluster** and local **kubeconfig**:
  - The extension calls `kc.loadFromDefault()` from `@kubernetes/client-node`, so it uses your standard kubeconfig search path (e.g. `~/.kube/config`).

---

## Installation & Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Build the extension**

   ```bash
   npm run compile
   ```

3. **Open in VS Code**

   - Open this folder in VS Code.
   - Press `F5` to launch the **Extension Development Host** (see `.vscode/launch.json` if you customize it).

4. **Proposed API**

   This extension uses `languageModelProxy` proposal (see `enabledApiProposals` in `package.json`). When running via the provided launch configuration, VS Code passes the appropriate flags for you.

---

## Using Kube Copilot

1. In the Extension Development Host, open **GitHub Copilot Chat**.
2. Select the **Kube Copilot** participant (`kube`) from the participant picker.
3. Ask natural language questions or commands, for example:
   - "What namespaces exist?"
   - "List pods in the `dev` namespace."
   - "Deploy an nginx pod in the `dev` namespace."
   - "Scale the `payments-api` deployment to 3 replicas."
   - "What events are associated with pod `my-app-123` in `dev`?"

### Confirmation Flow

- **Read-only** operations (e.g. listing namespaces/pods, getting deployment status) are executed directly.
- **Mutating** operations (`createNamespace`, `createPod`, `scaleDeployment`) are:
  - Planned in a human-readable summary.
  - Displayed with a list of tool calls.
  - Only executed after you reply with **`confirm`**.
  - Cancelled if you reply with **`cancel`**, `no`, or `stop`.

The state for pending actions is kept in memory and keyed per session using `getSessionKey()` in `src/extension.ts`.

---

## Configuration

User / workspace settings are read under the `kubeCopilot` namespace and declared in `package.json` under `contributes.configuration`.

Available settings:

- `kubeCopilot.context` (`string`):
  - Optional kube context name to use.
  - If empty, the extension uses the current context from kubeconfig (as resolved by `@kubernetes/client-node`).
- `kubeCopilot.namespace` (`string`, default `"dev"`):
  - Default namespace used when a request does not specify one.
- `kubeCopilot.allowNamespaces` (`string[]`, default `["dev", "qa"]`):
  - Allowlist of namespaces for operations.

Additional configuration keys honored in code (but not yet in the schema):

- `kubeCopilot.maxReplicas` (`number`, default `20` in code):
  - Upper bound on replicas for `scaleDeployment`.
- `kubeCopilot.allowedImages` (`string[]`, default `[]`):
  - If non-empty, only images whose names start with any entry in this list are allowed for `createPod`.

### Example Settings

```jsonc
{
  "kubeCopilot.context": "dev-cluster",
  "kubeCopilot.namespace": "dev",
  "kubeCopilot.allowNamespaces": ["dev", "qa"],
  "kubeCopilot.maxReplicas": 10,
  "kubeCopilot.allowedImages": [
    "registry.internal.company.com/",
    "nginx:"
  ]
}
```

---

## How It Works (Architecture)

High-level flow in `src/extension.ts`:

1. **Chat Participant Registration**

   - `activate` registers a participant via `vscode.chat.createChatParticipant("kubeCopilot.kube", handler)`.
   - Activation event is `onChatParticipant:kubeCopilot.kube` (see `activationEvents` in `package.json`).

2. **Planning Loop**

   - User input is processed by `planWithLm(...)`.
   - The planner:
     - Uses `vscode.lm` to select a Copilot chat model.
     - Instructs the model to return **strict JSON** with:
       - `summary: string`
       - `toolCalls: { tool: ToolName; args: Record<string, any> }[]`
     - If the model output is invalid or empty, `fallbackPlan(...)` provides a deterministic plan for common intents (list namespaces, deploy nginx, scale deployment).

3. **Tool Execution**

   - Implemented in `executeTool(...)`.
   - Uses `@kubernetes/client-node` clients:
     - `CoreV1Api` for namespaces, pods, events.
     - `AppsV1Api` for deployments and scaling.
   - Enforces:
     - Namespace allowlist (`allowedNamespaces`).
     - Image allowlist (`allowedImages`) on `createPod`.
     - Any replica bounds enforced via planner logic.

4. **Response Formatting**

   - `formatWithLm(...)` uses `vscode.lm` to format a concise markdown answer summarizing:
     - What was attempted.
     - What succeeded.
     - What failed.

---

## Development

### Build

```bash
npm run compile
```

- Compiles TypeScript from `src` using `tsconfig.json` into `out/`.

### Watch Mode

```bash
npm run watch
```

- Continuous compilation while editing.

### Lint

```bash
npm run lint
```

- Uses ESLint with config in `eslint.config.mjs`.

### Tests

1. Build + lint (pretest hook):

   ```bash
   npm test
   ```

2. Test configuration:
   - Test runner entry: `.vscode-test.mjs`.
   - Test files: TypeScript under `src/test/extension.test.ts` (compiled to `out/test/**/*.test.js`).

---

## Packaging & Distribution

To create a `.vsix` package:

```bash
npm run package
```

- Uses `@vscode/vsce` with ignore rules in `.vscodeignore` to exclude dev-only files.

The resulting `.vsix` can be installed via:

```bash
code --install-extension kube-0.0.1.vsix
```

(or whatever filename `vsce` outputs).

---

## Security & Safety Notes

- The extension uses your existing kubeconfig and runs with **your** Kubernetes permissions.
- Mutating operations are **never** executed without explicit confirmation.
- Use `kubeCopilot.allowNamespaces`, `kubeCopilot.maxReplicas`, and `kubeCopilot.allowedImages` to constrain behavior in shared / production clusters.
- Logs (including Kubernetes API responses) may appear in the VS Code debug console when running in development.

---

## Repository Structure

- `src/extension.ts` – main extension logic (chat participant, planning, tools, formatting).
- `src/extension_new.ts` – alternate/experimental entry file.
- `src/test/extension.test.ts` – sample test suite.
- `CHANGELOG.md` – change log.
- `vsc-extension-quickstart.md` – initial VS Code extension template notes.
- `.vscode/` – dev configuration (launch, tasks, recommended extensions).

---

## Known Limitations / Future Work

- Configuration schema in `package.json` does not yet declare `maxReplicas` or `allowedImages`, though the code reads them if present.
- No UI for surfacing detailed tool traces; logs are primarily in the debug console.
- Planner currently relies on a specific JSON contract; non-conforming model outputs fall back to `fallbackPlan(...)`.

Contributions and improvements to planning logic, validation, and test coverage are welcome.
