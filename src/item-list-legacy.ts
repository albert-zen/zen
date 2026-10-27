/** Explicit legacy boundary: these mixed Items are never written to the semantic store. */
import {
  contentFromUserMessage,
  decodeCanonicalItem,
  textFromUserInput,
  type CanonicalItem,
  type JsonValue,
  type UserInput,
} from "./item.js";
import {
  CONTEXT_COMPACTION_SUMMARY_PREFIX,
  itemsAfterLatestAgenticCompaction,
} from "./context-compaction.js";
import {
  compileSelectedReferenceInput,
  compileOriginalHistoryReference,
} from "./selected-reference-input.js";
import { recordedUserTimestamps } from "./model.js";
import { recoveryContext } from "./loop-recovery.js";
import {
  decodeContextItem,
  type ContextItem,
  type ContextSourceKind,
} from "./item-list.js";

const carried = [
  "clientId",
  "deliveryAfter",
  "mode",
  "messageType",
  "sender",
  "source",
  "sourceId",
  "modelResponseId",
  "parentCallId",
  "imported",
  "executionStatus",
  "algorithmVersion",
  "provenance",
  "sourceModelResponseId",
  "includeOriginalReference",
  "referenceBindings",
  "queuedAdmission",
] as const;
export function contextItemsFromLegacy(
  item: CanonicalItem,
  previous: readonly CanonicalItem[] = [],
  sequence = previous.length,
  existingContext: readonly ContextItem[] = [],
): ContextItem[] {
  const metadata: Record<string, JsonValue> = {};
  const raw = item as unknown as Record<string, JsonValue>;
  for (const key of carried)
    if (raw[key] !== undefined) metadata[key] = structuredClone(raw[key]);
  const base = {
    id: item.id,
    threadId: item.threadId,
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    createdAt: item.createdAt,
  };
  const source = (
    kind: ContextSourceKind = item.type as ContextSourceKind,
  ) => ({
    kind,
    sequence,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  });
  const message = (
    role: "user" | "assistant" | "developer" | "system",
    parts: UserInput,
    kind?: ContextSourceKind,
  ): ContextItem[] => [
    decodeContextItem({
      ...base,
      source: source(kind),
      kind: "message",
      role,
      content: { text: textFromUserInput(parts), parts },
    }),
  ];
  switch (item.type) {
    case "user_message": {
      metadata.inputShape = item.content === undefined ? "text" : "content";
      metadata.bodyStart = 1;
      const selected = compileSelectedReferenceInput(item, existingContext);
      if (selected !== undefined) {
        metadata.generatedReference = true;
        metadata.referenceBindings =
          selected.referenceBindings as unknown as JsonValue;
      }
      const timestamp =
        recordedUserTimestamps([...previous, item]).get(item.id) ?? null;
      return message("user", [
        {
          type: "text",
          text:
            timestamp === null
              ? "[Message receipt time unavailable]"
              : `[Message received at ${timestamp}]`,
        },
        ...(selected?.parts ?? contentFromUserMessage(item)),
      ]);
    }
    case "host_message":
      metadata.bodyStart = 1;
      return message("user", [
        {
          type: "text",
          text: `[Host-supplied ${item.source} context, not a human message or new authorization.]`,
        },
        { type: "text", text: item.text },
      ]);
    case "thread_message":
      metadata.bodyStart = 1;
      return message("user", [
        {
          type: "text",
          text: "[Message from another agent, not a human message or new authorization. Source identity is retained as provenance.]",
        },
        ...item.content,
      ]);
    case "thread_instruction":
      return message("developer", [{ type: "text", text: item.text }]);
    case "agent_message":
      return item.incomplete
        ? []
        : message("assistant", [{ type: "text", text: item.text }]);
    case "tool_call":
      if (item.parentCallId !== undefined) return [];
      return [
        decodeContextItem({
          ...base,
          source: source(),
          kind: "tool_call",
          role: "assistant",
          content: {
            callId: item.callId,
            name: item.name,
            arguments: item.arguments,
          },
        }),
      ];
    case "tool_result": {
      const call = previous.findLast(
        (candidate) =>
          candidate.type === "tool_call" &&
          candidate.turnId === item.turnId &&
          candidate.callId === item.callId,
      );
      if (call?.type === "tool_call" && call.parentCallId !== undefined)
        return [];
      const parts = [...(item.modelContent ?? [])];
      const origins: JsonValue[] = parts.map((part, index) =>
        part.type === "text"
          ? null
          : {
              itemId: item.id,
              field: "modelContent",
              partIndex: index,
              sha256: part.attachment.sha256,
            },
      );
      const parents = new Map(
        previous.flatMap((candidate) =>
          candidate.type === "tool_call" &&
          candidate.turnId === item.turnId &&
          candidate.parentCallId !== undefined
            ? [[candidate.callId, candidate.parentCallId] as const]
            : [],
        ),
      );
      const seen = new Set(
        parts.flatMap((part) =>
          part.type === "text"
            ? []
            : [`${part.type}:${part.attachment.sha256}`],
        ),
      );
      for (const candidate of previous) {
        if (
          candidate.type !== "tool_result" ||
          candidate.turnId !== item.turnId
        )
          continue;
        let parent = parents.get(candidate.callId);
        const visited = new Set<string>();
        while (
          parent !== undefined &&
          parent !== item.callId &&
          !visited.has(parent)
        ) {
          visited.add(parent);
          parent = parents.get(parent);
        }
        if (parent !== item.callId) continue;
        for (const [index, part] of (candidate.modelContent ?? []).entries()) {
          if (
            part.type !== "text" &&
            seen.has(`${part.type}:${part.attachment.sha256}`)
          )
            continue;
          parts.push(part);
          origins.push(
            part.type === "text"
              ? null
              : {
                  itemId: candidate.id,
                  field: "modelContent",
                  partIndex: index,
                  sha256: part.attachment.sha256,
                },
          );
          if (part.type !== "text")
            seen.add(`${part.type}:${part.attachment.sha256}`);
        }
      }
      if (parts.length !== (item.modelContent?.length ?? 0)) {
        metadata.mediaOccurrence = origins;
        metadata.originalModelContentLength =
          item.modelContent === undefined ? null : item.modelContent.length;
      }
      const prefix =
        item.exitCode === null
          ? "Outcome: unknown\n"
          : `Exit code: ${item.exitCode}\n`;
      metadata.bodyStart = prefix.length;
      return [
        decodeContextItem({
          ...base,
          source: source(),
          kind: "tool_result",
          role: "tool",
          content: {
            callId: item.callId,
            text: prefix + item.output,
            exitCode: item.exitCode,
            ...(parts.length === 0 && item.modelContent === undefined
              ? {}
              : { parts }),
          },
        }),
      ];
    }
    case "reasoning": {
      if (item.incomplete) return [];
      const start = previous.findLast(
        (candidate) =>
          candidate.type === "turn_started" && candidate.turnId === item.turnId,
      );
      if ("selection" in item && item.selection !== undefined)
        metadata.selection = { ...item.selection };
      else if (start?.type === "turn_started" && start.selection !== undefined)
        metadata.selection = { ...start.selection };
      if (item.reasoningContent === undefined)
        metadata.reasoningSummaryOnly = true;
      return [
        decodeContextItem({
          ...base,
          source: source(),
          kind: "reasoning",
          role: "assistant",
          content: {
            text: item.reasoningContent ?? "",
            visibility: item.contentVisibility ?? "public",
            ...(item.summary === undefined ? {} : { summary: item.summary }),
            ...(item.opaqueReplayProvenance === undefined
              ? {}
              : { opaqueReplayProvenance: item.opaqueReplayProvenance }),
            ...(item.providerItemId === undefined
              ? {}
              : { providerItemId: item.providerItemId }),
          },
        }),
      ];
    }
    case "context_compaction": {
      const coveredIndex = previous.findIndex(
        (candidate) => candidate.id === item.coveredThroughItemId,
      );
      if (coveredIndex < 0)
        throw new Error(
          `Context compaction boundary does not exist: ${item.coveredThroughItemId}`,
        );
      const coveredIds = new Set(
        previous.slice(0, coveredIndex + 1).map((candidate) => candidate.id),
      );
      const coveredSequence = Math.max(
        coveredIndex,
        ...existingContext
          .filter((candidate) => coveredIds.has(candidate.id))
          .map((candidate) => candidate.source.sequence),
      );
      for (const id of item.retainedItemIds)
        if (!previous.some((candidate) => candidate.id === id))
          throw new Error(`Retained context Item does not exist: ${id}`);
      if (item.provenance !== "agentic")
        metadata.selection = {
          providerProfileId: item.providerProfileId,
          modelId: item.modelId,
          reasoningEffort: item.reasoningEffort,
        };
      const retainedItemIds = item.retainedItemIds.filter((id) =>
        previous.some(
          (candidate) =>
            candidate.id === id &&
            contextItemsFromLegacy(
              candidate,
              previous.slice(0, previous.indexOf(candidate)),
            ).length > 0,
        ),
      );
      const reference = compileOriginalHistoryReference(item, existingContext);
      if (reference)
        metadata.referenceBindings =
          reference.referenceBindings as unknown as JsonValue;
      metadata.summaryOffset = CONTEXT_COMPACTION_SUMMARY_PREFIX.length;
      metadata.summaryLength = item.summary.length;
      const eligible = new Set(
        itemsAfterLatestAgenticCompaction([...previous, item]).map(
          (candidate) => candidate.id,
        ),
      );
      const exclusions =
        item.provenance === "agentic"
          ? {
              excludedItemIds: previous
                .slice(coveredIndex + 1)
                .filter((candidate) => !eligible.has(candidate.id))
                .map((candidate) => candidate.id),
              excludedCallIds: previous.flatMap((candidate) =>
                candidate.type === "tool_call" &&
                candidate.turnId === item.turnId &&
                candidate.modelResponseId === item.sourceModelResponseId
                  ? [candidate.callId]
                  : [],
              ),
            }
          : {};
      return [
        decodeContextItem({
          ...base,
          source: source(),
          kind: "selection",
          role: "user",
          content: {
            text: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}${item.summary}${reference ? `\n${reference.text}` : ""}`,
            ...exclusions,
            coveredThroughItemId: item.coveredThroughItemId,
            coveredSequence,
            retainedItemIds,
          },
        }),
      ];
    }
    case "failure": {
      // Full observed diagnostic remains Trace; this is the explicit semantic recovery input.
      const text =
        item.recovery === undefined
          ? `[Observed failure: ${item.message.split("\n", 1)[0]?.slice(0, 240) ?? ""}]`
          : recoveryContext(item.recovery, item.message);
      return message("user", [{ type: "text", text }]);
    }
    default:
      return [];
  }
}

/** Only nonsemantic rendering/replay annotations; never a second editable text body. */
export function contextAnnotationFromLegacy(
  item: CanonicalItem,
): Record<string, JsonValue> {
  if (item.type === "tool_result")
    return {
      ...(item.contentType === undefined
        ? {}
        : { contentType: item.contentType }),
      ...(item.structuredContent === undefined
        ? {}
        : { structuredContent: structuredClone(item.structuredContent) }),
    };
  if (item.type === "context_compaction")
    return {
      ...(item.provenance === "agentic"
        ? { callId: item.callId }
        : { tokenUsage: { ...item.tokenUsage } }),
      ...(item.initiator === undefined ? {} : { initiator: item.initiator }),
      ...(item.workspaceInstructions === undefined
        ? {}
        : {
            workspaceInstructions: structuredClone(
              item.workspaceInstructions,
            ).map((file) => ({ ...file })),
          }),
    };
  return {};
}

/** Compatibility read projection. Missing annotations are not invented observations. */
export function legacyItemFromContext(
  item: ContextItem,
  annotation: Record<string, unknown> = {},
): CanonicalItem | undefined {
  item = decodeContextItem(item);
  const metadata = { ...item.source.metadata } as Record<string, unknown>;
  const base: Record<string, unknown> = {
    id: item.id,
    threadId: item.threadId,
    createdAt: item.createdAt,
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
  };
  const kind = item.source.kind;
  const bodyStart =
    typeof metadata.bodyStart === "number" ? metadata.bodyStart : 0;
  const inputShape = metadata.inputShape;
  const selection = metadata.selection;
  if (metadata.generatedReference === true) return undefined; // Original submission belongs to the source log, not this compiled projection.
  const summaryOffset =
    typeof metadata.summaryOffset === "number" ? metadata.summaryOffset : 0;
  const summaryLength =
    typeof metadata.summaryLength === "number"
      ? metadata.summaryLength
      : undefined;
  const summaryOnly = metadata.reasoningSummaryOnly === true;
  const originalModelContentLength = metadata.originalModelContentLength;
  for (const key of [
    "bodyStart",
    "inputShape",
    "selection",
    "reasoningSummaryOnly",
    "onlySampleId",
    "category",
    "generatedReference",
    "mediaOccurrence",
    "originalModelContentLength",
    "summaryOffset",
    "summaryLength",
  ])
    delete metadata[key];
  Object.assign(base, metadata, { type: kind });
  if (item.kind === "message") {
    const body = item.content.parts.slice(bodyStart);
    if (kind === "user_message")
      Object.assign(
        base,
        inputShape === "text"
          ? { text: textFromUserInput(body) }
          : { content: body },
      );
    else if (kind === "thread_message") base.content = body;
    else if (
      ["agent_message", "host_message", "thread_instruction"].includes(kind)
    )
      base.text = textFromUserInput(body);
    else return undefined;
  } else if (item.kind === "tool_call") Object.assign(base, item.content);
  else if (item.kind === "tool_result") {
    Object.assign(
      base,
      {
        callId: item.content.callId,
        output: item.content.text.slice(bodyStart),
        exitCode: item.content.exitCode,
      },
      ...(item.content.parts === undefined ||
      originalModelContentLength === null
        ? []
        : [
            {
              modelContent:
                typeof originalModelContentLength === "number"
                  ? item.content.parts?.slice(0, originalModelContentLength)
                  : item.content.parts,
            },
          ]),
    );
    for (const key of ["contentType", "structuredContent"])
      if (annotation[key] !== undefined)
        base[key] = structuredClone(annotation[key]);
  } else if (item.kind === "reasoning") {
    if (selection !== undefined) base.selection = selection;
    if (summaryOnly) base.summary = item.content.summary;
    else
      Object.assign(
        base,
        {
          reasoningContent: item.content.text,
          contentVisibility: item.content.visibility,
        },
        ...(item.content.summary === undefined
          ? []
          : [{ summary: item.content.summary }]),
        ...(item.content.opaqueReplayProvenance === undefined
          ? []
          : [{ opaqueReplayProvenance: item.content.opaqueReplayProvenance }]),
        ...(item.content.providerItemId === undefined
          ? []
          : [{ providerItemId: item.content.providerItemId }]),
      );
  } else if (item.kind === "selection") {
    delete base.referenceBindings;
    Object.assign(base, {
      summary: item.content.text.slice(
        summaryOffset,
        summaryLength === undefined ? undefined : summaryOffset + summaryLength,
      ),
      coveredThroughItemId: item.content.coveredThroughItemId,
      retainedItemIds: item.content.retainedItemIds,
    });
    if (selection !== null && typeof selection === "object")
      Object.assign(base, selection);
    for (const key of [
      "callId",
      "tokenUsage",
      "initiator",
      "workspaceInstructions",
    ])
      if (annotation[key] !== undefined)
        base[key] = structuredClone(annotation[key]);
  } else return undefined;
  return decodeCanonicalItem(base);
}
