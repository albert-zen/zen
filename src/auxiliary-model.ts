import type { AttachmentStore } from "./attachment.js";
import { prepareSampleImages } from "./image-preparation.js";
import { randomUUID } from "node:crypto";
import { textFromUserInput, type JsonValue } from "./item.js";
import {
  compileItemList,
  decodeContextItem,
  type ContextItem,
} from "./item-list.js";
import type { FileItemListStore } from "./item-list-store.js";
import {
  modelUserContent,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
  type ModelTool,
} from "./model.js";
import { estimateModelMessageInputTokens } from "./model-usage.js";
import { observeModelWithTrace } from "./trace-model.js";
import type { RuntimeTrace } from "./trace.js";

export interface AuxiliaryModelOptions {
  attachments?: Pick<AttachmentStore, "read" | "importBytes">;
  supportsImageDetailOriginal?: boolean | null;
  adapter: ModelAdapter;
  trace: RuntimeTrace;
  itemListStore: Pick<FileItemListStore, "create">;
  purpose: "title" | "image-probe" | "compaction";
  /** Already-compiled input may already include the adapter declaration. */
  instructionsMaterialized?: boolean;
  messages: readonly ModelMessage[];
  tools: readonly ModelTool[];
  model: string;
  reasoningEffort: string | null;
  signal: AbortSignal;
  maxOutputTokens?: number;
  /** Frozen model window, checked against the durable compiled compaction input. */
  contextWindow?: number | null;
  assertDispatchAllowed?: () => void;
  configuration?: Record<string, unknown>;
  selection?: { providerProfileId: string; modelId: string };
  inputModalities?: readonly string[] | null;
  onPrepared?: (sample: {
    ownerId: string;
    sampleId: string;
    selectedItemIds: readonly string[];
    messages: ModelMessage[];
    tools: ModelTool[];
  }) => void | Promise<void>;
}

/** One frozen sample, not a Thread. Source facts must be durable before dispatch. */
export function streamAuxiliaryModel(
  options: AuxiliaryModelOptions,
): AsyncIterable<ModelEvent> {
  const {
    adapter,
    trace,
    itemListStore,
    signal,
    assertDispatchAllowed,
    onPrepared,
  } = options;
  const frozen = structuredClone({
    purpose: options.purpose,
    messages: options.messages,
    tools: options.tools,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    maxOutputTokens: options.maxOutputTokens,
    contextWindow: options.contextWindow,
    configuration: options.configuration,
    selection: options.selection,
    inputModalities: options.inputModalities,
    supportsImageDetailOriginal: options.supportsImageDetailOriginal,
  });
  const ownerId = `auxiliary-${randomUUID()}`;
  const sampleId = randomUUID();
  const messages = [...frozen.messages];
  if (
    !options.instructionsMaterialized &&
    adapter.contextInstructions !== undefined
  )
    messages.unshift({ role: "system", text: adapter.contextInstructions });
  const items = materializeAuxiliaryInputs(
    ownerId,
    messages,
    frozen.tools,
    frozen.selection,
  );
  return (async function* () {
    if (options.attachments !== undefined)
      items.push(
        ...(await prepareSampleImages({
          threadId: ownerId,
          sampleId,
          itemList: items,
          selection: frozen.selection ?? {
            providerProfileId: adapter.provider,
            modelId: frozen.model,
          },
          inputModalities: frozen.inputModalities ?? null,
          supportsImageDetailOriginal:
            frozen.supportsImageDetailOriginal ?? null,
          attachments: options.attachments,
          id: randomUUID,
          now: () => new Date().toISOString(),
        })),
      );
    for (const item of items) {
      const receipt = await trace.record({
        threadId: ownerId,
        sampleId,
        type: "context_source",
        data: { item, origin: "auxiliary-input", purpose: frozen.purpose },
      });
      if (receipt.durability !== "durable")
        throw new Error(
          `Auxiliary context source was not durable: ${receipt.error}`,
        );
    }
    await itemListStore.create(ownerId, items);
    const compiled = compileItemList(items, {
      sampleId,
      ...(frozen.selection === undefined
        ? {}
        : { selection: frozen.selection }),
      ...(frozen.inputModalities === undefined
        ? {}
        : { inputModalities: frozen.inputModalities }),
    });
    if (
      frozen.purpose === "compaction" &&
      frozen.contextWindow !== undefined &&
      (frozen.contextWindow === null ||
        estimateModelMessageInputTokens(compiled.messages) >
          frozen.contextWindow)
    )
      throw new CompactionBudgetExceededError();
    await onPrepared?.({
      ownerId,
      sampleId,
      ...structuredClone(compiled),
    });
    const request: ModelRequest = {
      model: frozen.model,
      reasoningEffort: frozen.reasoningEffort,
      ...(frozen.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: frozen.maxOutputTokens }),
      ...compiled,
      signal,
      ...(assertDispatchAllowed === undefined ? {} : { assertDispatchAllowed }),
      debugContext: {
        threadId: ownerId,
        turnId: null,
        purpose: frozen.purpose,
        sampleId,
        sampleAttempt: 1,
        contextBoundaryItemId: items.at(-1)!.id,
        selectedItemIds: compiled.selectedItemIds,
        ...(frozen.configuration === undefined
          ? {}
          : { configuration: frozen.configuration }),
      },
    };
    yield* observeModelWithTrace(adapter, trace).stream(request);
  })();
}

export function materializeAuxiliaryInputs(
  ownerId: string,
  messages: readonly ModelMessage[],
  tools: readonly ModelTool[],
  selection?: AuxiliaryModelOptions["selection"],
): ContextItem[] {
  const items: ContextItem[] = [];
  const base = (
    kind: ContextItem["source"]["kind"],
    metadata?: Record<string, JsonValue>,
  ) => ({
    id: randomUUID(),
    threadId: ownerId,
    createdAt: new Date().toISOString(),
    source: {
      kind,
      sequence: items.length,
      ...(metadata === undefined ? {} : { metadata }),
    },
  });
  for (const message of messages) {
    if (message.role === "tool_discovery") {
      const { role: _role, ...content } = message;
      items.push({
        ...base("tool_discovery"),
        kind: "tool_discovery",
        role: "assistant",
        content,
      });
    } else if (message.role === "reasoning") {
      items.push({
        ...base(
          "reasoning",
          selection === undefined ? undefined : { selection },
        ),
        kind: "reasoning",
        role: "assistant",
        content: {
          text: message.reasoningContent,
          visibility: message.contentVisibility,
          ...(message.summary === undefined
            ? {}
            : { summary: message.summary }),
          ...(message.providerItemId === undefined
            ? {}
            : { providerItemId: message.providerItemId }),
          ...(message.opaqueReplayProvenance === undefined
            ? {}
            : { opaqueReplayProvenance: message.opaqueReplayProvenance }),
        },
      });
    } else if (message.role === "tool") {
      items.push({
        ...base("tool_result"),
        kind: "tool_result",
        role: "tool",
        content: {
          callId: message.callId,
          text: message.text,
          exitCode: message.exitCode,
          ...(message.modelContent === undefined
            ? {}
            : { parts: message.modelContent }),
        },
      });
    } else {
      if (
        message.role !== "assistant" ||
        !("toolCalls" in message) ||
        message.text !== undefined
      ) {
        const parts =
          message.role === "user"
            ? modelUserContent(message)
            : [{ type: "text" as const, text: message.text! }];
        items.push({
          ...base("auxiliary_input"),
          kind: "message",
          role: message.role,
          content: { text: textFromUserInput(parts), parts },
        });
      }
      if (message.role === "assistant" && "toolCalls" in message)
        for (const call of message.toolCalls) {
          const { imported, ...content } = call;
          items.push({
            ...base(
              "tool_call",
              imported === undefined
                ? undefined
                : { imported: imported as unknown as JsonValue },
            ),
            kind: "tool_call",
            role: "assistant",
            content,
          });
        }
    }
  }
  items.push({
    ...base("tool_definitions"),
    kind: "tools",
    role: "developer",
    content: { tools: [...tools] },
  });
  return items.map(decodeContextItem);
}

export class CompactionBudgetExceededError extends Error {
  readonly code = "compaction_budget_exceeded";
  constructor() {
    super("Prepared context compaction request exceeds the model window");
    this.name = "CompactionBudgetExceededError";
  }
}
