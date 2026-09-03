import type { ModelTool } from "../src/model.js";
import {
  type ToolBundle,
  type ToolBundleIdentity,
  type ToolExecutionMode,
  type ToolExecutionResult,
  type ToolInvocation,
  type ToolRuntime,
} from "../src/tool.js";

export function testToolRuntime(options: {
  name: string;
  description?: string;
  inputSchema?: ModelTool["inputSchema"];
  executionMode?: ToolExecutionMode;
  execute(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}): ToolRuntime {
  return {
    name: options.name,
    specification: {
      name: options.name,
      description: options.description ?? "Fixture tool.",
      inputSchema: options.inputSchema ?? { type: "object" },
    },
    ...(options.executionMode === undefined
      ? {}
      : { executionMode: options.executionMode }),
    execute: options.execute,
  };
}

export function testToolBundle(
  identity: ToolBundleIdentity,
  tools: readonly ToolRuntime[],
  retainPreparedInvocation?: () => () => void,
): ToolBundle {
  return {
    identity,
    tools,
    ...(retainPreparedInvocation === undefined
      ? {}
      : { retainPreparedInvocation }),
  };
}
