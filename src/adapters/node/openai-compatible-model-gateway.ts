import type {
  ModelContext,
  ModelContextPart
} from "../../kernel/index.js";
import type { ModelEvent, ModelGateway, ModelOptions } from "../../kernel/index.js";

type ToolDefinition = Readonly<Record<string, unknown>>;

export type OpenAiCompatibleModelGatewayOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly defaultParams?: Readonly<Record<string, unknown>>;
  readonly tools?: readonly ToolDefinition[];
};

export class OpenAiCompatibleModelGateway implements ModelGateway {
  private readonly endpoint: string;

  constructor(private readonly options: OpenAiCompatibleModelGatewayOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  async *generate(
    context: ModelContext,
    options?: ModelOptions,
    signal?: AbortSignal
  ): AsyncIterable<ModelEvent> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: toMessages(context.parts),
        tools: this.options.tools,
        tool_choice: this.options.tools?.length ? "auto" : undefined,
        stream: true,
        ...this.options.defaultParams,
        ...options
      })
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `Model request failed: ${response.status} ${await response.text()}`
      );
    }

    yield* parseStreamingResponse(response.body);
  }
}

async function* parseStreamingResponse(
  body: ReadableStream<Uint8Array>
): AsyncIterable<ModelEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let content = "";
  const toolCalls = new Map<
    number,
    { id?: string; name?: string; arguments: string }
  >();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }

      const data = line.slice("data:".length).trim();

      if (data === "[DONE]") {
        continue;
      }

      const delta = readDelta(JSON.parse(data));
      const text = typeof delta.content === "string" ? delta.content : "";

      if (text) {
        content += text;
        yield { type: "text.delta", text };
      }

      if (Array.isArray(delta.tool_calls)) {
        mergeToolCalls(toolCalls, delta.tool_calls);
      }
    }
  }

  yield {
    type: "message.completed",
    content,
    toolCalls: [...toolCalls.values()].flatMap((call) => {
      if (!call.id || !call.name) {
        return [];
      }

      return [
        {
          id: call.id,
          name: call.name,
          input: parseArguments(call.arguments)
        }
      ];
    })
  };
}

function readDelta(chunk: unknown): Readonly<Record<string, unknown>> {
  if (typeof chunk !== "object" || chunk === null) {
    return {};
  }

  const choices = (chunk as { readonly choices?: unknown }).choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return {};
  }

  const first = choices[0] as { readonly delta?: unknown };

  return typeof first.delta === "object" && first.delta !== null
    ? (first.delta as Readonly<Record<string, unknown>>)
    : {};
}

function mergeToolCalls(
  toolCalls: Map<number, { id?: string; name?: string; arguments: string }>,
  deltas: readonly unknown[]
): void {
  for (const entry of deltas) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const delta = entry as {
      readonly index?: unknown;
      readonly id?: unknown;
      readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
    };
    const index = typeof delta.index === "number" ? delta.index : 0;
    const current = toolCalls.get(index) ?? { arguments: "" };

    toolCalls.set(index, {
      id:
        typeof delta.id === "string" && delta.id.length > 0
          ? delta.id
          : current.id,
      name:
        typeof delta.function?.name === "string" &&
        delta.function.name.length > 0
          ? delta.function.name
          : current.name,
      arguments:
        current.arguments +
        (typeof delta.function?.arguments === "string"
          ? delta.function.arguments
          : "")
    });
  }
}

function parseArguments(value: string): unknown {
  if (!value.trim()) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function toMessages(parts: readonly ModelContextPart[]): readonly unknown[] {
  return parts.flatMap((part): unknown[] => {
    if (part.type === "message") {
      const message: Record<string, unknown> = {
        role: part.role,
        content: stringify(part.content)
      };

      if (part.role === "assistant" && part.toolCalls?.length) {
        message.tool_calls = part.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: stringify(call.input ?? {})
          }
        }));
      }

      return [message];
    }

    return [
      {
        role: "tool",
        tool_call_id: part.toolCallId,
        name: part.toolName,
        content: stringify(part.content)
      }
    ];
  });
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
