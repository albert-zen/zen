import { AppServer, type AppServerOptions } from "./app-server.js";
import type { ModelContext, ModelEvent, ModelGateway } from "../kernel/index.js";
import type {
  ThreadRuntime,
  ThreadRuntimeFactory,
  ToolRuntime
} from "./thread-manager.js";
import type { ToolRuntimeEvent } from "../kernel/index.js";

export type DemoAppServerOptions = {
  readonly appServerOptions?: AppServerOptions;
};

export function createDemoAppServer(
  options: DemoAppServerOptions = {}
): AppServer {
  return new AppServer({
    ...options.appServerOptions,
    threadManagerOptions: {
      ...options.appServerOptions?.threadManagerOptions,
      runtimeFactory: createDemoThreadRuntime
    }
  });
}

export const createDemoThreadRuntime: ThreadRuntimeFactory = (): ThreadRuntime => ({
  model: new DemoModelGateway(),
  toolRuntime: new DemoToolRuntime()
});

class DemoModelGateway implements ModelGateway {
  async *generate(context: ModelContext): AsyncIterable<ModelEvent> {
    const latestUser = readLatestUserInput(context);
    const toolResult = readToolResultAfterLatestUser(context);

    if (toolResult) {
      yield {
        type: "message.completed",
        content: `Demo tool returned: ${stringify(toolResult.content)}`
      };
      return;
    }

    if (latestUser.toLowerCase().includes("tool")) {
      yield {
        type: "text.delta",
        text: "Using demo tool..."
      };
      yield {
        type: "message.completed",
        content: "I will call the demo lookup tool.",
        toolCalls: [
          {
            id: `demo-tool-${Date.now()}`,
            name: "demo.lookup",
            input: { query: latestUser }
          }
        ]
      };
      return;
    }

    yield {
      type: "text.delta",
      text: "Thinking..."
    };
    yield {
      type: "message.completed",
      content: `Zen demo response: ${latestUser || "ready"}`
    };
  }
}

class DemoToolRuntime implements ToolRuntime {
  async *execute(call: {
    readonly id: string;
    readonly name: string;
    readonly input?: unknown;
  }): AsyncIterable<ToolRuntimeEvent> {
    if (call.name !== "demo.lookup") {
      yield {
        type: "error",
        error: new Error(`Unknown demo tool: ${call.name}`)
      };
      return;
    }

    yield {
      type: "output.delta",
      delta: { status: "running", toolName: call.name }
    };
    yield {
      type: "result.completed",
      content: `lookup(${stringify(call.input)})`
    };
  }
}

function readLatestUserInput(context: ModelContext): string {
  const latestUser = [...context.parts]
    .reverse()
    .find((part) => part.type === "message" && part.role === "user");

  return latestUser ? stringify(latestUser.content) : "";
}

function readToolResultAfterLatestUser(
  context: ModelContext
): { readonly content: unknown } | undefined {
  const latestUserIndex = findLastIndex(
    context.parts,
    (part) => part.type === "message" && part.role === "user"
  );

  if (latestUserIndex < 0) {
    return undefined;
  }

  const toolResult = context.parts
    .slice(latestUserIndex + 1)
    .find((part) => part.type === "toolResult");

  return toolResult ? { content: toolResult.content } : undefined;
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T) => boolean
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index] as T)) {
      return index;
    }
  }

  return -1;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  return JSON.stringify(value);
}
