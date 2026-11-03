import {
  resolveToolResultPresentation,
  toolResultFallbackText,
  toolResultPresentationKey,
  type ToolResultPresentationContext,
} from "./tool-result-presentation.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { RootContent } from "mdast";
import type { TriggerHistoryEntry } from "../../main/trigger-types.js";
import {
  findInputWakeup,
  hostMessageSummary,
  triggerMessagePresentation,
} from "./trigger-message-presentation.js";
import type { ThreadItem, Turn } from "../../protocol-client/index.js";
import type { TurnCanonicalPresentation } from "./turn-canonical-presentation.js";
import {
  normalizeInlineReferences,
  parseSentReferenceContent,
} from "./reference-draft.js";
import { disclosureKey } from "./thread-reading-state.js";
import { projectTurn } from "./turn-projection.js";

const fallbackContext: ToolResultPresentationContext = {
  snapshot: null,
  registry: null,
};

export interface TranscriptFindEntry {
  turnId: string;
  itemId: string;
  field:
    | "body"
    | "command"
    | "output"
    | "host-summary"
    | "host-original"
    | "tool-structured";
  /** Separate rendered blocks: a result never bridges unrelated paragraphs/cells. */
  blocks: readonly string[];
  disclosures: readonly string[];
}
export interface TranscriptFindMatch {
  entry: TranscriptFindEntry;
  occurrence: number;
}
export function transcriptFindMatchId(match: TranscriptFindMatch): string {
  return JSON.stringify([
    match.entry.itemId,
    match.entry.field,
    match.occurrence,
  ]);
}
export const normalizeFindText = (value: string) =>
  value.replace(/\s+/gu, " ").trim();

/** CommonMark + GFM text, using the same parser family as ReactMarkdown. No DOM/history mount. */
export function markdownFindBlocks(source: string): string[] {
  const root = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const blocks: string[] = [];
  const footnotes = new Map<
    string,
    Extract<RootContent, { type: "footnoteDefinition" }>
  >();
  for (const node of root.children)
    if (node.type === "footnoteDefinition" && !footnotes.has(node.identifier))
      footnotes.set(node.identifier, node);
  const referenced: string[] = [];
  const inline = (node: RootContent): string => {
    if (node.type === "footnoteReference") {
      if (
        footnotes.has(node.identifier) &&
        !referenced.includes(node.identifier)
      )
        referenced.push(node.identifier);
      return "\u0000";
    }
    if (node.type === "image" || node.type === "imageReference")
      return "\u0000";
    if (node.type === "definition" || node.type === "footnoteDefinition")
      return "";
    if (node.type === "break") return " ";
    if ("value" in node) return String(node.value);
    return "children" in node
      ? node.children.map((child) => inline(child as RootContent)).join("")
      : "";
  };
  const visit = (node: RootContent) => {
    if (
      ["paragraph", "heading", "code", "tableCell", "html"].includes(node.type)
    ) {
      for (const part of inline(node).split("\u0000")) {
        const text = normalizeFindText(part);
        if (text) blocks.push(text);
      }
    } else if ("children" in node && node.type !== "footnoteDefinition") {
      node.children.forEach((child) => visit(child as RootContent));
    }
  };
  root.children.forEach(visit);
  // ReactMarkdown places only referenced footnote bodies at the end, in first-reference order.
  for (let index = 0; index < referenced.length; index++)
    footnotes.get(referenced[index]!)?.children.forEach(visit);
  return blocks;
}

function inputBlocks(
  item: Extract<ThreadItem, { type: "userMessage" | "threadMessage" }>,
  canonical: TurnCanonicalPresentation | undefined,
  parse: typeof markdownFindBlocks = markdownFindBlocks,
): string[] {
  const input = canonical?.inputs.get(item.id);
  const parts = input
    ? input.text !== undefined
      ? [input.text]
      : input.content.flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        )
    : item.content.map((part) => part.text);
  if (item.type === "threadMessage") return parse(parts.join("\n"));
  const parsed = parts.map((part) =>
    parseSentReferenceContent(part, input?.clientId ?? item.clientId),
  );
  if (parsed.every((part) => part.references.length === 0))
    return parse(parsed.map((part) => part.text).join("\n"));
  return parsed.flatMap((part) => {
    const normalized = normalizeInlineReferences(part.text, part.references);
    let prefix = "\uE000ZENXFIND";
    while (normalized.text.includes(prefix)) prefix += "X";
    let previous = 0;
    let source = "";
    normalized.references.forEach((reference, index) => {
      source +=
        normalized.text.slice(previous, reference.position!) +
        `${prefix}${index}\uE001`;
      previous = reference.position! + 1;
    });
    source += normalized.text.slice(previous);
    return parse(source).map((block) =>
      normalizeFindText(
        normalized.references.reduce(
          (text, reference, index) =>
            text
              .split(`${prefix}${index}\uE001`)
              .join(
                reference.kind === "message" || reference.kind === "text"
                  ? reference.excerpt
                  : reference.name,
              ),
          block,
        ),
      ),
    );
  });
}

/** Loaded product text only. Opaque plugin surfaces and unrelated UI metadata are not indexed. */
export function indexTurnFindText(
  turn: Turn,
  canonical?: TurnCanonicalPresentation,
  readFields: typeof itemFindFields = itemFindFields,
): TranscriptFindEntry[] {
  const projection = projectTurn(turn);
  const trace = new Map<string, string>();
  for (const node of projection.history) {
    if (node.kind === "traceItem") trace.set(node.item.id, node.id);
    else if (node.kind === "traceGroup")
      for (const item of node.items) trace.set(item.id, node.id);
  }
  const entries: TranscriptFindEntry[] = [];
  const displayedItems = [
    ...projection.inputItems,
    ...projection.history.flatMap((node): ThreadItem[] =>
      node.kind === "traceGroup" ? node.items : [node.item],
    ),
    ...(projection.finalItem ? [projection.finalItem] : []),
  ];
  for (const item of displayedItems) {
    const disclosures: string[] = [];
    if (
      !["userMessage", "threadMessage", "hostMessage"].includes(item.type) &&
      item.id !== projection.finalItem?.id
    )
      disclosures.push(disclosureKey("turn", turn.id));
    const group = trace.get(item.id);
    if (group)
      disclosures.push(
        disclosureKey("trace", turn.id, group),
        disclosureKey("item", turn.id, item.id),
      );
    const add = (field: TranscriptFindEntry["field"], blocks: string[]) => {
      if (blocks.length)
        entries.push({
          turnId: turn.id,
          itemId: item.id,
          field,
          blocks,
          disclosures:
            field === "host-original"
              ? [...disclosures, disclosureKey("host", item.id)]
              : disclosures,
        });
    };
    for (const field of readFields(item, canonical))
      add(field.field, field.blocks);
  }
  return entries;
}

type FindField = Pick<TranscriptFindEntry, "field"> & { blocks: string[] };
function itemFindFields(
  item: ThreadItem,
  canonical?: TurnCanonicalPresentation,
  parse: typeof markdownFindBlocks = markdownFindBlocks,
  wakeup?: TriggerHistoryEntry,
  tools: ToolResultPresentationContext = fallbackContext,
): FindField[] {
  if (
    (item.type === "userMessage" && wakeup) ||
    (item.type === "hostMessage" && item.source === "trigger")
  ) {
    const text =
      item.type === "userMessage"
        ? item.content.map((part) => part.text).join("\n")
        : item.text;
    const sourceId =
      item.type === "userMessage" ? wakeup!.triggerId : item.sourceId;
    return [
      {
        field: "body",
        blocks: parse(triggerMessagePresentation(text, sourceId).text),
      },
    ];
  }
  if (item.type === "hostMessage") {
    const welcome =
      item.source === "bootstrap" &&
      !item.text.startsWith("[ZenX trigger wakeup]");
    const summary = welcome
      ? ""
      : hostMessageSummary(item.text, wakeup?.prompt);
    return [
      ...(welcome
        ? [{ field: "body" as const, blocks: parse(item.text) }]
        : summary
          ? [
              {
                field: "host-summary" as const,
                blocks: [normalizeFindText(summary)],
              },
            ]
          : []),
      { field: "host-original", blocks: [normalizeFindText(item.text)] },
    ];
  }
  if (item.type === "agentMessage")
    return [{ field: "body", blocks: parse(item.text) }];
  if (item.type === "userMessage" || item.type === "threadMessage")
    return [{ field: "body", blocks: inputBlocks(item, canonical, parse) }];
  if (item.type === "reasoning")
    return [{ field: "body", blocks: parse(item.content.join("\n")) }];
  if (item.type === "commandExecution") {
    const fields: FindField[] = [
      { field: "command", blocks: [normalizeFindText(item.command)] },
    ];
    // Resolve first: an opaque plugin branch is never serialized or mounted for Find.
    if (
      resolveToolResultPresentation(item, tools.snapshot, tools.registry)
        .kind === "fallback"
    ) {
      const text = toolResultFallbackText(item);
      if (text.structured)
        fields.push({
          field: "tool-structured",
          blocks: [normalizeFindText(text.structured)],
        });
      if (text.output)
        fields.push({
          field: "output",
          blocks: [normalizeFindText(text.output)],
        });
    }
    return fields;
  }
  return [];
}

/** Cold work runs only when invoked by open Find. Immutable items and completed turns reuse parsed text. */
export function createTranscriptFindIndexer(
  parse: typeof markdownFindBlocks = markdownFindBlocks,
) {
  const items = new WeakMap<
    ThreadItem,
    { input: unknown; wakeupKey: string; toolKey: string; fields: FindField[] }
  >();
  let currentWakeups: readonly TriggerHistoryEntry[] = [];
  let currentTools = fallbackContext;
  const turns = new WeakMap<
    Turn,
    {
      canonical: TurnCanonicalPresentation | undefined;
      entries: TranscriptFindEntry[];
      wakeupKey: string;
      toolKey: string;
    }
  >();
  const fields = (item: ThreadItem, canonical?: TurnCanonicalPresentation) => {
    const input = canonical?.inputs.get(item.id);
    const wakeup =
      item.type === "userMessage" ||
      item.type === "threadMessage" ||
      item.type === "hostMessage"
        ? findInputWakeup(item, currentWakeups)
        : undefined;
    const wakeupKey = JSON.stringify([wakeup?.triggerId, wakeup?.prompt]);
    const toolKey =
      item.type === "commandExecution"
        ? JSON.stringify(
            resolveToolResultPresentation(
              item,
              currentTools.snapshot,
              currentTools.registry,
            ),
          )
        : "";
    const before = items.get(item);
    if (
      before &&
      before.input === input &&
      before.wakeupKey === wakeupKey &&
      before.toolKey === toolKey
    )
      return before.fields;
    const fields = itemFindFields(item, canonical, parse, wakeup, currentTools);
    items.set(item, { input, wakeupKey, toolKey, fields });
    return fields;
  };
  return (
    source: readonly Turn[],
    canonical: ReadonlyMap<string, TurnCanonicalPresentation>,
    wakeups: readonly TriggerHistoryEntry[] = [],
    tools: ToolResultPresentationContext = fallbackContext,
  ): TranscriptFindEntry[] => {
    currentWakeups = wakeups;
    currentTools = tools;
    const toolKey = toolResultPresentationKey(tools.snapshot, tools.registry);
    const wakeupKey = JSON.stringify(
      wakeups.map((entry) => [
        entry.clientUserMessageId,
        entry.triggerId,
        entry.prompt,
        entry.sourceRoomId,
      ]),
    );
    return source.flatMap((turn) => {
      const presentation = canonical.get(turn.id);
      const before = turns.get(turn);
      if (
        before &&
        before.canonical === presentation &&
        before.wakeupKey === wakeupKey &&
        before.toolKey === toolKey
      )
        return before.entries;
      const entries = indexTurnFindText(turn, presentation, fields);
      turns.set(turn, { canonical: presentation, entries, wakeupKey, toolKey });
      return entries;
    });
  };
}

export function findTextOccurrences(text: string, query: string): number[] {
  if (!query) return [];
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    "giu",
  );
  return [...text.matchAll(pattern)].map((match) => match.index);
}
export function searchTranscript(
  entries: readonly TranscriptFindEntry[],
  query: string,
): TranscriptFindMatch[] {
  const needle = normalizeFindText(query);
  if (!needle) return [];
  return entries.flatMap((entry) => {
    let occurrence = 0;
    return entry.blocks.flatMap((block) =>
      findTextOccurrences(block, needle).map(() => ({
        entry,
        occurrence: occurrence++,
      })),
    );
  });
}
export function stepTranscriptFind(
  index: number,
  total: number,
  direction: -1 | 1,
): number {
  return total ? (index + direction + total) % total : 0;
}
