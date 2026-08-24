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
  readonly context: Readonly<{ callId: string; cwd: string }>;
  readonly signal: AbortSignal;
}

export function runProcessPlugin(definition: ProcessPluginDefinition): void {
  const input = readline.createInterface({ input: process.stdin });
  const active = new Map<string, AbortController>();
  let closing = false;
  write({
    version: 1,
    type: "ready",
    pluginId: definition.pluginId,
    packageVersion: definition.packageVersion,
  });
  const handle = async (request: PluginRuntimeRequest): Promise<void> => {
    if (request.type === "close") {
      closing = true;
      for (const controller of active.values()) {
        controller.abort(
          new DOMException("Plugin runtime is closing", "AbortError"),
        );
      }
      input.close();
      process.stdin.destroy();
      return;
    }
    if (request.type === "cancel") {
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
