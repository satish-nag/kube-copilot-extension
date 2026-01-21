import * as vscode from "vscode";
import * as k8s from "@kubernetes/client-node";

export type ToolName =
  | "listNamespaces"
  | "listNamespacedPod"
  | "listNamespacedEvent"
  | "listNamespacedDeployment"
  | "listNamespacedService"
  | "getService"
  | "listNamespacedConfigMap"
  | "getConfigMap"
  | "listIstioObject"
  | "getIstioObject"
  | "getNamespace"
  | "createNamespace"
  | "createPod"
  | "createDeployment"
  | "updateDeployment"
  | "updateDeploymentImage"
  | "createIstioObject"
  | "updateIstioObject"
  | "createConfigMap"
  | "updateConfigMap"
  | "createService"
  | "updateService"
  | "deleteDeployment"
  | "scaleDeployment"
  | "getDeploymentStatus";

export type ToolCall = {
  tool: ToolName;
  args: Record<string, any>;
};

export type ToolResult = {
  tool: ToolName;
  args: Record<string, any>;
  ok: boolean;
  result: any;
};

type OkOptions = {
  summarizeList?: boolean;
  kindHint?: string;
};

export function loadKubeConfig(stream: vscode.ChatResponseStream): k8s.KubeConfig | null {
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromDefault();
    return kc;
  } catch (e: any) {
    stream.markdown(`❌ Failed to load kubeconfig: \`${e.message}\``);
    return null;
  }
}

export function isMutating(tool: ToolName): boolean {
  return tool === "createNamespace" ||
    tool === "createPod" ||
    tool === "createDeployment" ||
    tool === "updateDeployment" ||
    tool === "updateDeploymentImage" ||
    tool === "createIstioObject" ||
    tool === "updateIstioObject" ||
    tool === "createConfigMap" ||
    tool === "updateConfigMap" ||
    tool === "createService" ||
    tool === "updateService" ||
    tool === "deleteDeployment" ||
    tool === "scaleDeployment";
}

export async function executeTool(
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
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        const labelSelector = call.args.labelSelector;
        const fieldSelector = call.args.fieldSelector;
        const limit = call.args.limit ?? 50;
        const continueToken = call.args.continueToken;

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const res = await core.listNamespacedPod(
          namespace,
          undefined,
          undefined,
          continueToken,
          fieldSelector,
          labelSelector,
          limit
        );
        console.log("res: " + JSON.stringify(res))
        return ok(call, res.body, { summarizeList: true, kindHint: "Pod" });
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

      case "listNamespacedDeployment": {
        const namespace = call.args.namespace;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        const labelSelector = call.args.labelSelector;
        const fieldSelector = call.args.fieldSelector;
        const limit = call.args.limit ?? 50;
        const continueToken = call.args.continueToken;

        const apps = kc.makeApiClient(k8s.AppsV1Api);
        const res = await apps.listNamespacedDeployment(
          namespace,
          undefined,
          undefined,
          continueToken,
          fieldSelector,
          labelSelector,
          limit
        );
        return ok(call, res.body, { summarizeList: true, kindHint: "Deployment" });
      }

      case "listNamespacedService": {
        const namespace = call.args.namespace;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        const labelSelector = call.args.labelSelector;
        const fieldSelector = call.args.fieldSelector;
        const limit = call.args.limit ?? 50;
        const continueToken = call.args.continueToken;

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const res = await core.listNamespacedService(
          namespace,
          undefined,
          undefined,
          continueToken,
          fieldSelector,
          labelSelector,
          limit
        );
        return ok(call, res.body, { summarizeList: true, kindHint: "Service" });
      }

      case "getService": {
        const { namespace, name } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const res = await core.readNamespacedService(name, namespace);
        return ok(call, res.body);
      }

      case "listNamespacedConfigMap": {
        const namespace = call.args.namespace;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        const labelSelector = call.args.labelSelector;
        const fieldSelector = call.args.fieldSelector;
        const limit = call.args.limit ?? 50;
        const continueToken = call.args.continueToken;

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const res = await core.listNamespacedConfigMap(
          namespace,
          undefined,
          undefined,
          continueToken,
          fieldSelector,
          labelSelector,
          limit
        );
        return ok(call, res.body, { summarizeList: true, kindHint: "ConfigMap" });
      }

      case "getConfigMap": {
        const { namespace, name } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const res = await core.readNamespacedConfigMap(name, namespace);
        return ok(call, res.body);
      }

      case "listIstioObject": {
        const { namespace, kind } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        const labelSelector = call.args.labelSelector;
        const fieldSelector = call.args.fieldSelector;
        const limit = call.args.limit ?? 50;
        const continueToken = call.args.continueToken;

        const { group, version, plural } = getIstioResource(kind);
        const custom = kc.makeApiClient(k8s.CustomObjectsApi);
        const res = await custom.listNamespacedCustomObject(
          group,
          version,
          namespace,
          plural,
          undefined,
          undefined,
          continueToken??null,
          fieldSelector??null,
          labelSelector??null,
          limit??null
        );
        console.log("res: " + JSON.stringify(res))
        return ok(call, res.body, { summarizeList: true, kindHint: kind });
      }

      case "getIstioObject": {
        const { namespace, kind, name } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");

        const { group, version, plural } = getIstioResource(kind);
        const custom = kc.makeApiClient(k8s.CustomObjectsApi);
        const res = await custom.getNamespacedCustomObject(group, version, namespace, plural, name);
        console.log("res istio object: " + JSON.stringify(res))
        return ok(call, res.body);
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
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        // if (allowedImages.length && !allowedImages.some(p => image.startsWith(p)))
          // throw new Error("Image not allowed");

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

      case "createDeployment": {
        const { namespace, name, image } = call.args;
        const replicas = call.args.replicas ?? 1;
        const port = call.args.port;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        // if (allowedImages.length && !allowedImages.some(p => image.startsWith(p)))
          // throw new Error("Image not allowed");
        // if (replicas > maxReplicas) throw new Error("Replicas exceed max allowed");
        const apps = kc.makeApiClient(k8s.AppsV1Api);
        const deployment: k8s.V1Deployment = {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name },
          spec: {
            replicas,
            selector: { matchLabels: { app: name } },
            template: {
              metadata: { labels: { app: name } },
              spec: {
                containers: [
                  {
                    name: "app",
                    image,
                    ports: port ? [{ containerPort: port }] : undefined
                  }
                ]
              }
            }
          }
        };
        const res = await apps.createNamespacedDeployment(namespace, deployment);
        return ok(call, { name: res.body.metadata?.name });
      }

      case "updateDeployment": {
        const { namespace, name, patch } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        if (!patch || typeof patch !== "object") throw new Error("Patch must be an object");

        const images = extractImagesFromDeploymentPatch(patch);
        if (allowedImages.length && images.some(img => !allowedImages.some(p => img.startsWith(p)))) {
          throw new Error("Image not allowed");
        }

        const apps = kc.makeApiClient(k8s.AppsV1Api);
        const res = await apps.patchNamespacedDeployment(
          name,
          namespace,
          patch,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
        );
        return ok(call, { name: res.body.metadata?.name });
      }

      case "createIstioObject": {
        const { namespace, kind, manifest } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        if (!manifest || typeof manifest !== "object") throw new Error("Manifest must be an object");

        const { group, version, plural } = getIstioResource(kind);
        const custom = kc.makeApiClient(k8s.CustomObjectsApi);
        const res = await custom.createNamespacedCustomObject(group, version, namespace, plural, manifest);
        return ok(call, res.body);
      }

      case "updateIstioObject": {
        const { namespace, kind, name, patch } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        if (!patch || typeof patch !== "object") throw new Error("Patch must be an object");

        const { group, version, plural } = getIstioResource(kind);
        const custom = kc.makeApiClient(k8s.CustomObjectsApi);
        const res = await custom.patchNamespacedCustomObject(
          group,
          version,
          namespace,
          plural,
          name,
          patch,
          undefined,
          undefined,
          undefined,
          { headers: { "Content-Type": "application/merge-patch+json" } }
        );
        return ok(call, res.body);
      }

      case "createService": {
        const { namespace, name, selector, port, targetPort, type } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const service: k8s.V1Service = {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name },
          spec: {
            type: type ?? "ClusterIP",
            selector,
            ports: [
              {
                port,
                targetPort: targetPort ?? port
              }
            ]
          }
        };
        const res = await core.createNamespacedService(namespace, service);
        return ok(call, { name: res.body.metadata?.name });
      }

      case "createConfigMap": {
        const { namespace, name, data, binaryData } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const cm: k8s.V1ConfigMap = {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name },
          data,
          binaryData
        };
        const res = await core.createNamespacedConfigMap(namespace, cm);
        return ok(call, { name: res.body.metadata?.name });
      }

      case "updateConfigMap": {
        const { namespace, name, data, binaryData } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        if (!data && !binaryData) throw new Error("No ConfigMap data to update");

        const core = kc.makeApiClient(k8s.CoreV1Api);
        const current = await core.readNamespacedConfigMap(name, namespace);
        const cm = current.body;
        cm.data = { ...(cm.data ?? {}), ...(data ?? {}) };
        cm.binaryData = { ...(cm.binaryData ?? {}), ...(binaryData ?? {}) };
        const updated = await core.replaceNamespacedConfigMap(name, namespace, cm);
        return ok(call, { name: updated.body.metadata?.name });
      }

      case "updateService": {
        const { namespace, name, selector, port, targetPort, type } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        if (!selector && !port && !targetPort && !type) throw new Error("No service fields to update");

        const core = kc.makeApiClient(k8s.CoreV1Api);

        const current = await core.readNamespacedService(name, namespace);
        const service = current.body;

        if (!service.spec) {
          service.spec = {} as k8s.V1ServiceSpec;
        }
        if (type) service.spec.type = type;
        if (selector) service.spec.selector = selector;
        if (port || targetPort) {
          service.spec.ports = [
            {
              port: port ?? 80,
              targetPort: targetPort ?? port ?? 80
            }
          ];
        }

        const updated = await core.replaceNamespacedService(name, namespace, service);
        return ok(call, { name: updated.body.metadata?.name });
      }

      case "updateDeploymentImage": {
        const { namespace, name, image } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        // if (allowedImages.length && !allowedImages.some(p => image.startsWith(p)))
        //   throw new Error("Image not allowed");

        const apps = kc.makeApiClient(k8s.AppsV1Api);
        const res = await apps.readNamespacedDeployment(name, namespace);
        const deployment = res.body;
        const containers = deployment.spec?.template?.spec?.containers ?? [];
        if (!containers.length) throw new Error("No containers found to update");
        containers[0].image = image;
        // Ensure spec/template/spec are initialized with correct types to avoid undefined access
        if (!deployment.spec) {
          deployment.spec = {} as k8s.V1DeploymentSpec;
        }
        if (!deployment.spec.template) {
          deployment.spec.template = {} as k8s.V1PodTemplateSpec;
        }
        if (!deployment.spec.template.spec) {
          deployment.spec.template.spec = {} as k8s.V1PodSpec;
        }
        deployment.spec.template.spec.containers = containers;

        const updated = await apps.replaceNamespacedDeployment(name, namespace, deployment);
        return ok(call, { name: updated.body.metadata?.name });
      }

      case "deleteDeployment": {
        const { namespace, name } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");

        const apps = kc.makeApiClient(k8s.AppsV1Api);
        const res = await apps.deleteNamespacedDeployment(name, namespace);
        return ok(call, { status: res.body?.status, details: res.body?.details });
      }

      case "scaleDeployment": {
        const { namespace, name, replicas } = call.args;
        // if (!allowedNamespaces.has(namespace)) throw new Error("Namespace not allowed");
        // if (replicas > maxReplicas) throw new Error("Replicas exceed max allowed");

        const apps = kc.makeApiClient(k8s.AppsV1Api);
        const current = await apps.readNamespacedDeployment(name, namespace);
        const deployment = current.body;

        if (!deployment.spec) {
          deployment.spec = {} as k8s.V1DeploymentSpec;
        }
        deployment.spec.replicas = replicas;

        const updated = await apps.replaceNamespacedDeployment(name, namespace, deployment);
        console.log("res: " + JSON.stringify(updated))
        return ok(call, { name: updated.body.metadata?.name, replicas: updated.body.spec?.replicas });
      }

      case "getDeploymentStatus": {
        const apps = kc.makeApiClient(k8s.AppsV1Api);
        const res = await apps.readNamespacedDeployment(call.args.name, call.args.namespace);
        return ok(call, res.body.status);
      }
    }
  } catch (e: any) {
    console.log("error: " + JSON.stringify(e))
    return { tool: call.tool, args: call.args, ok: false, result: e.message };
  }
}

function ok(call: ToolCall, result: any, options?: OkOptions): ToolResult {
  if (options?.summarizeList && result && Array.isArray(result.items)) {
    const continueToken = result.metadata?.continue ?? result.metadata?._continue;
    const items = summarizeK8sList(result.items, options.kindHint);
    return {
      tool: call.tool,
      args: call.args,
      ok: true,
      result: { items, continueToken }
    };
  }

  return { tool: call.tool, args: call.args, ok: true, result };
}

function extractImagesFromDeploymentPatch(patch: any): string[] {
  const containers = patch?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers)) return [];
  return containers.map((c: any) => c?.image).filter((img: any) => typeof img === "string");
}

function summarizeK8sList(items: any[], kindHint?: string): any[] {
  return items.map(item => summarizeK8sItem(item, kindHint));
}

function summarizeK8sItem(item: any, kindHint?: string): Record<string, any> {
  const kind = kindHint ?? item?.kind;
  const meta = item?.metadata ?? {};
  const name = meta?.name;
  const namespace = meta?.namespace;
  const labels = meta?.labels;

  if (kindHint === "Pod" || kind === "Pod") {
    const status = item?.status ?? {};
    const containers = item?.spec?.containers ?? [];
    return {
      kind: "Pod",
      name,
      namespace,
      phase: status.phase,
      nodeName: status.nodeName,
      podIP: status.podIP,
      containers: containers.map((c: any) => ({ name: c?.name, image: c?.image })),
      labels
    };
  }

  if (kindHint === "Deployment" || kind === "Deployment") {
    const spec = item?.spec ?? {};
    const status = item?.status ?? {};
    return {
      kind: "Deployment",
      name,
      namespace,
      replicas: spec.replicas,
      availableReplicas: status.availableReplicas,
      updatedReplicas: status.updatedReplicas,
      strategy: spec?.strategy?.type,
      labels
    };
  }

  if (kindHint === "Service" || kind === "Service") {
    const spec = item?.spec ?? {};
    return {
      kind: "Service",
      name,
      namespace,
      type: spec.type,
      clusterIP: spec.clusterIP,
      ports: spec.ports?.map((p: any) => ({ port: p?.port, targetPort: p?.targetPort, protocol: p?.protocol })),
      selector: spec.selector,
      labels
    };
  }

  if (kindHint === "ConfigMap" || kind === "ConfigMap") {
    const data = item?.data ?? {};
    const binaryData = item?.binaryData ?? {};
    return {
      kind: "ConfigMap",
      name,
      namespace,
      dataKeys: Object.keys(data),
      binaryDataKeys: Object.keys(binaryData),
      labels
    };
  }

  const spec = item?.spec ?? {};
  const istioSummary: Record<string, any> = {
    kind: kindHint ?? kind,
    name,
    namespace,
    labels
  };
  if (Array.isArray(spec.hosts)) istioSummary.hosts = spec.hosts;
  if (Array.isArray(spec.gateways)) istioSummary.gateways = spec.gateways;
  if (spec.selector) istioSummary.selector = spec.selector;
  if (Array.isArray(spec.ports)) istioSummary.ports = spec.ports;
  if (Array.isArray(spec.servers)) istioSummary.servers = spec.servers;
  console.log("istioSummary: " + JSON.stringify(istioSummary))
  return istioSummary;
}

function getIstioResource(kind: string): { group: string; version: string; plural: string } {
  const normalized = String(kind || "").toLowerCase();
  switch (normalized) {
    case "virtualservice":
      return { group: "networking.istio.io", version: "v1beta1", plural: "virtualservices" };
    case "destinationrule":
      return { group: "networking.istio.io", version: "v1beta1", plural: "destinationrules" };
    case "gateway":
      return { group: "networking.istio.io", version: "v1beta1", plural: "gateways" };
    case "serviceentry":
      return { group: "networking.istio.io", version: "v1beta1", plural: "serviceentries" };
    case "authorizationpolicy":
      return { group: "security.istio.io", version: "v1beta1", plural: "authorizationpolicies" };
    case "peerauthentication":
      return { group: "security.istio.io", version: "v1beta1", plural: "peerauthentications" };
    case "requestauthentication":
      return { group: "security.istio.io", version: "v1beta1", plural: "requestauthentications" };
    default:
      throw new Error(`Unsupported Istio kind: ${kind}`);
  }
}
