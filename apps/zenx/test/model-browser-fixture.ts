import {
  ToolEnvironment,
  type ToolInvocation,
  type ToolExecutionResult,
} from "../../../src/tool.js";
import {
  trustedModelReferenceBindings,
  type ModelReferenceBinding,
} from "../../../src/model-references.js";
import { ZenXHostToolBundle } from "../src/main/capability-tool-executor.js";
import {
  PluginRuntimeSupervisor,
  bundledPackageRegistration,
} from "../src/main/plugin-runtime.js";
import {
  attachBrowserModelRoute,
  attachBrowserSidebarTargets,
  readBrowserModelTargets,
} from "../src/main/capabilities/model-browser-metadata.js";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";
import type { BrowserConnectionSnapshot } from "../src/main/chrome-extension-bridge.js";
import type { ZenXCapabilityPackage } from "../src/main/capabilities/types.js";
import type { ToolTraceCapture } from "../../../src/trace-tool.js";
export const LITERAL =
  "User UUID d7f5f6b1-44d2-4b36-9c49-1171700cc9b3 /tmp/unchanged.txt referenceBindings";
export function browserBackend(count = 90) {
  let sequence = 0,
    failInspect = false;
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const summary = (sessionId: string) => ({
    sessionId,
    tabId: "RAW-native-tab",
    title: "Same title",
    url: "https://example.test/",
    loading: false,
  });
  const backend: ZenXBrowserBackend = {
    listTabs: async (s) => [summary(s)],
    open: async (s) => summary(s),
    inspect: async (s) => {
      calls.push({ name: "inspect", args: [s] });
      if (failInspect) throw Error(LITERAL);
      const observationId = `RAW-observation-${++sequence}`;
      return {
        ...summary(s),
        observationId,
        documentVersion: 1,
        visibleText: LITERAL,
        targets: Array.from({ length: count }, (_, i) => ({
          targetId: `RAW-native-node-${i}`,
          role: "button",
          name: i ? "Save" : LITERAL,
          actions: ["click" as const, "type" as const],
        })),
        screenshot: {
          observationId,
          artifactPath: "/literal/unchanged.png",
          status: "fallback",
          width: 1,
          height: 1,
          bytes: 0,
          expiresAt: "2030-01-01",
        },
      };
    },
    click: async (...args) => {
      calls.push({ name: "click", args });
      return summary(args[0]);
    },
    type: async (...args) => {
      calls.push({ name: "type", args });
      return summary(args[0]);
    },
    navigate: async (...args) => {
      calls.push({ name: "navigate", args });
      return summary(args[0]);
    },
    closeTab: async (...args) => {
      calls.push({ name: "close", args });
    },
    closeSession: async () => 1,
    close: async () => {},
  };
  return {
    backend,
    calls,
    failInspect: () => {
      failInspect = true;
    },
  };
}
export async function browserBridge(
  service: ZenXCapabilityPackage,
  connections?: BrowserConnectionSnapshot[],
  history: ModelReferenceBinding[] = [],
  owner = "RAW-owner",
) {
  const supervisor = new PluginRuntimeSupervisor(new ToolEnvironment());
  await supervisor.start(
    bundledPackageRegistration({ package: service, source: "bundled" }),
  );
  const definitions = service.manifest.tools.map(
      ({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }),
    ),
    token = supervisor.captureHostGeneration(definitions.map((t) => t.name));
  const native: ToolInvocation[] = [],
    trace: unknown[] = [];
  const bundle = new ZenXHostToolBundle({
    capabilities: {
      definitions,
      generationToken: token,
      ...(connections ? { browserConnections: connections } : {}),
      plugins: [
        {
          id: service.manifest.id,
          name: "Browser",
          status: "enabled",
          mainDocument: "",
          description: "",
          tools: definitions,
        },
      ],
    },
    send(event) {
      if (event.type !== "capability/invoke") return;
      const invocation = {
        ...event.invocation,
        signal: new AbortController().signal,
      };
      if (event.browserModelRoute)
        attachBrowserModelRoute(invocation, event.browserModelRoute);
      if (event.browserSidebarTargets)
        attachBrowserSidebarTargets(invocation, event.browserSidebarTargets);
      native.push(invocation);
      void supervisor.invokeHostGeneration(token, invocation).then(
        (result) =>
          bundle.handleResult({
            type: "capability/result",
            invocationId: event.invocationId,
            generationToken: token,
            ...result,
            browserModelTargets: readBrowserModelTargets(result),
          }),
        (error) =>
          bundle.handleResult({
            type: "capability/result",
            invocationId: event.invocationId,
            generationToken: token,
            error: String(error.message),
          }),
      );
    },
  });
  const capture: ToolTraceCapture = {
    recordInvocation: async (v) => {
      trace.push(v);
    },
    recordReferenceBindings: async (v) => {
      trace.push(v);
    },
    recordResult: async (value, layer) => {
      trace.push({ layer, value: structuredClone(value) });
      return {
        durability: "degraded",
        error: "synthetic sink, not a durable trace",
      };
    },
    recordAcceptedResult: async () => {},
    write: async () => {},
    end: async () => {},
    flush: async () => {},
    hasObservedResult: () => true,
    hasAcceptedResult: () => false,
  };
  const invocation = (
    name: string,
    args: Record<string, unknown>,
  ): ToolInvocation => ({
    name,
    arguments: args,
    callId: `call-${native.length}`,
    threadId: owner,
    cwd: "/synthetic",
    signal: new AbortController().signal,
    modelReferences: structuredClone(history),
    traceOutput: capture,
  });
  return {
    bundle,
    native,
    trace,
    history,
    invocation,
    async receipt(
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolExecutionResult> {
      const tool = bundle.tools.find((t) => t.name === name)!;
      let input = invocation(name, args);
      if (tool.approvalScope)
        input = { ...input, approvalScope: await tool.approvalScope(input) };
      tool.resourceClaims?.(input);
      const result = await tool.execute(input);
      history.push(...(trustedModelReferenceBindings(result) ?? []));
      return result;
    },
    async call(name: string, args: Record<string, unknown>): Promise<any> {
      return JSON.parse((await this.receipt(name, args)).output);
    },
    async close() {
      bundle.close();
      await supervisor.close();
    },
  };
}
export async function workspaceFixture(count = 90) {
  const backend = browserBackend(count),
    service = new BrowserBackendRegistry(backend.backend);
  return { ...backend, service, bridge: await browserBridge(service) };
}
