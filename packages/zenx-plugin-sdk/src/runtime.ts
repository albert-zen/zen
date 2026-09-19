import readline from "node:readline";

import type {
  JsonValue,
  PluginRuntimeRequest,
  PluginRuntimeResponse,
} from "./types.js";

export interface ProcessPluginDefinition {
  pluginId: string;
  packageVersion: string;
  tools: Readonly<
    Record<
      string,
      (
        input: Readonly<Record<string, unknown>>,
        invocation: ProcessPluginInvocationContext,
      ) =>
        | {
            output: string;
            exitCode?: number;
            contentType?: string;
            structuredContent?: JsonValue;
          }
        | Promise<{
            output: string;
            exitCode?: number;
            contentType?: string;
            structuredContent?: JsonValue;
          }>
    >
  >;
}

export interface ProcessPluginInvocationContext {
  readonly id: string;
  readonly tool: string;
  readonly context: Readonly<{
    callId: string;
    cwd: string;
    threadId?: string;
  }>;
  readonly signal: AbortSignal;
  readonly ui: { readonly panels: { open(panelId: string): Promise<void> } };
}

export function runProcessPlugin(definition: ProcessPluginDefinition): void {
  const input = readline.createInterface({ input: process.stdin });
  const active = new Map<string, AbortController>();
  let closing = false;
  let nextRequest = 0;
  const pending = new Map<
    string,
    { invocationId: string; resolve(): void; reject(error: Error): void }
  >();
  const rejectPending = (invocationId: string, message: string) => {
    for (const [id, request] of pending)
      if (request.invocationId === invocationId) {
        pending.delete(id);
        request.reject(new Error(message));
      }
  };
  write({
    version: 1,
    type: "ready",
    pluginId: definition.pluginId,
    packageVersion: definition.packageVersion,
  });
  const handle = async (request: PluginRuntimeRequest): Promise<void> => {
    if (request.type === "host_result") {
      const waiter = pending.get(request.id);
      if (!waiter || waiter.invocationId !== request.invocationId) return;
      pending.delete(request.id);
      if (request.error !== undefined) waiter.reject(new Error(request.error));
      else waiter.resolve();
      return;
    }
    if (request.type === "close") {
      closing = true;
      for (const [id, controller] of active) {
        rejectPending(id, "Plugin runtime is closing");
        controller.abort(
          new DOMException("Plugin runtime is closing", "AbortError"),
        );
      }
      input.close();
      process.stdin.destroy();
      return;
    }
    if (request.type === "cancel") {
      rejectPending(request.id, "Plugin invocation cancelled");
      active
        .get(request.id)
        ?.abort(new DOMException("Plugin invocation cancelled", "AbortError"));
      return;
    }
    if (request.type !== "invoke") return;
    if (closing) return;
    const tool = definition.tools[request.tool];
    if (tool === undefined) {
      write({
        version: 1,
        type: "error",
        id: request.id,
        message: `Unsupported tool: ${request.tool}`,
      });
      return;
    }
    const controller = new AbortController();
    active.set(request.id, controller);
    try {
      const result = await tool(
        request.arguments,
        Object.freeze({
          id: request.id,
          tool: request.tool,
          context: Object.freeze({ ...request.context }),
          signal: controller.signal,
          ui: Object.freeze({
            panels: Object.freeze({
              open: async (panelId: string) => {
                if (
                  controller.signal.aborted ||
                  closing ||
                  !active.has(request.id)
                )
                  throw new Error("Plugin invocation is no longer active");
                if (!request.context.threadId)
                  throw new Error(
                    "Opening a panel requires a Thread invocation",
                  );
                if (!panelId || panelId.length > 256)
                  throw new Error("Invalid panel id");
                if (pending.size >= 32)
                  throw new Error("Too many pending panel requests");
                const id = `panel-${++nextRequest}`;
                await new Promise<void>((resolve, reject) => {
                  pending.set(id, {
                    invocationId: request.id,
                    resolve,
                    reject,
                  });
                  write({
                    version: 1,
                    hostSdkVersion: 1,
                    type: "host_request",
                    id,
                    invocationId: request.id,
                    request: {
                      operation: "ui.panels.open",
                      panelId,
                      threadId: request.context.threadId!,
                    },
                  });
                });
              },
            }),
          }),
        }),
      );
      if (controller.signal.aborted || closing) return;
      write({
        version: 1,
        type: "result",
        id: request.id,
        result: { ...result, exitCode: result.exitCode ?? 0 },
      });
    } catch (error) {
      if (controller.signal.aborted || closing) return;
      write({
        version: 1,
        type: "error",
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      rejectPending(request.id, "Plugin invocation completed");
      if (active.get(request.id) === controller) active.delete(request.id);
    }
  };
  input.on("line", (line) => {
    void handle(JSON.parse(line) as PluginRuntimeRequest);
  });
}

function write(message: PluginRuntimeResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
