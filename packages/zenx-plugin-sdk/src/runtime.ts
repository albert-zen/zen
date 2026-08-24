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
      (input: Readonly<Record<string, unknown>>) =>
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

export function runProcessPlugin(definition: ProcessPluginDefinition): void {
  const input = readline.createInterface({ input: process.stdin });
  write({
    version: 1,
    type: "ready",
    pluginId: definition.pluginId,
    packageVersion: definition.packageVersion,
  });
  const handle = async (request: PluginRuntimeRequest): Promise<void> => {
    if (request.type === "close") {
      input.close();
      return;
    }
    if (request.type !== "invoke") return;
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
    try {
      const result = await tool(request.arguments);
      write({
        version: 1,
        type: "result",
        id: request.id,
        result: { ...result, exitCode: result.exitCode ?? 0 },
      });
    } catch (error) {
      write({
        version: 1,
        type: "error",
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  input.on("line", (line) => {
    void handle(JSON.parse(line) as PluginRuntimeRequest);
  });
}

function write(message: PluginRuntimeResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
