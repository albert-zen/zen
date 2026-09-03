import type { ModelTool } from "../src/model.js";
import {
  ToolEnvironment,
  type CompositeToolRuntime,
  type NestedToolInvocationPort,
  type ToolBundle,
  type ToolBundleIdentity,
  type ToolExecutionMode,
  type ToolExecutionResult,
  type ToolInvocation,
  type ToolPolicyStore,
  type ToolRuntime,
} from "../src/tool.js";

export interface TestToolProvider {
  readonly identity: ToolBundleIdentity;
  readonly definitions: readonly ModelTool[];
  readonly executionModes?: Readonly<Record<string, ToolExecutionMode>>;
  execute(invocation: ToolInvocation): Promise<ToolExecutionResult>;
  executeComposite?(
    invocation: ToolInvocation,
    nested: NestedToolInvocationPort,
  ): Promise<ToolExecutionResult>;
  retainPreparedInvocation?(): () => void;
}

export interface TestToolExecutor {
  readonly definitions: readonly ModelTool[];
  execute(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}

export type TestToolSource = TestToolProvider | ToolRuntime | ToolBundle;

export function testToolEnvironment(
  options: {
    providers?: readonly TestToolSource[];
    policyStore?: ToolPolicyStore;
    approvedTools?: Set<string>;
    deniedTools?: Set<string>;
  } = {},
): ToolEnvironment {
  return new ToolEnvironment({
    bundles: (options.providers ?? []).map(testToolBundle),
    ...(options.policyStore === undefined
      ? {}
      : { policyStore: options.policyStore }),
    ...(options.approvedTools === undefined
      ? {}
      : { approvedTools: options.approvedTools }),
    ...(options.deniedTools === undefined
      ? {}
      : { deniedTools: options.deniedTools }),
  });
}

export function testExecutorEnvironment(
  executor: TestToolExecutor,
): ToolEnvironment {
  return testToolEnvironment({
    providers: [
      {
        identity: { kind: "external", id: "test-executor" },
        ...executor,
      },
    ],
  });
}

export function testToolBundle(source: TestToolSource): ToolBundle {
  if ("tools" in source) return source;
  if ("specification" in source) {
    return {
      identity: inferredIdentity(source),
      tools: [source],
    };
  }
  return {
    identity: source.identity,
    tools: source.definitions.map((definition): ToolRuntime => {
      const base: ToolRuntime = {
        name: definition.name,
        specification: structuredClone(definition),
        ...(source.executionModes?.[definition.name] === undefined
          ? {}
          : { executionMode: source.executionModes[definition.name] }),
        execute: async (invocation) => await source.execute(invocation),
      };
      if (source.executeComposite === undefined) return base;
      const composite: CompositeToolRuntime = {
        ...base,
        executeComposite: async (invocation, nested) =>
          await source.executeComposite!(invocation, nested),
      };
      return composite;
    }),
    ...(source.retainPreparedInvocation === undefined
      ? {}
      : {
          retainPreparedInvocation: () => source.retainPreparedInvocation!(),
        }),
  };
}

function inferredIdentity(runtime: ToolRuntime): ToolBundleIdentity {
  if (runtime.name === "shell") return { kind: "builtin", id: "shell" };
  if (runtime.name === "run_code") return { kind: "builtin", id: "run-code" };
  return { kind: "external", id: `test-${runtime.name}` };
}
