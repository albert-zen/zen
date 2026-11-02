import type { CanonicalItem } from "../../../../../src/item.js";
import type { Turn } from "../../protocol-client/index.js";
import type { ZenXThreadAttachmentProjection } from "../../thread-attachment-projection.js";
import type { ToolActionTarget } from "./tool-action-targets.js";

type UserMessage = Extract<CanonicalItem, { type: "user_message" }>;
export interface TurnCanonicalPresentation {
  inputs: ReadonlyMap<string, UserMessage>;
  quoteItems: ReadonlyMap<string, readonly CanonicalItem[]>;
  forkItems: ReadonlyMap<string, string | undefined>;
  attachments: ZenXThreadAttachmentProjection;
  toolTargets: ReadonlyMap<string, ToolActionTarget>;
}
export interface TurnCanonicalPresentationIndex {
  scope: string;
  turns: ReadonlyMap<string, TurnCanonicalPresentation>;
}

function sameEntries<T>(
  previous: ReadonlyMap<string, T>,
  entries: readonly (readonly [string, T])[],
  equal: (a: T, b: T) => boolean = Object.is,
): boolean {
  return (
    previous.size === entries.length &&
    entries.every(
      ([key, value]) => previous.has(key) && equal(previous.get(key)!, value),
    )
  );
}
function sameAttachments(
  previous: ZenXThreadAttachmentProjection,
  entries: readonly (readonly [
    string,
    ZenXThreadAttachmentProjection[string],
  ])[],
): boolean {
  return (
    Object.keys(previous).length === entries.length &&
    entries.every(([key, value]) => {
      const before = previous[key];
      return (
        before !== undefined &&
        before.length === value.length &&
        before.every((attachment, index) => attachment === value[index])
      );
    })
  );
}
// Tool targets are small deterministic projection values, not callable authority.
// Re-evaluate the whole trusted-binding projection before comparing; later
// backfills and recovery may change a formerly unavailable destination.
function sameTarget(a: ToolActionTarget, b: ToolActionTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A disposable immutable per-Turn view. Never mutates its committed predecessor. */
export function indexTurnCanonicalPresentation(
  scope: string,
  turns: readonly Turn[],
  inputs: ReadonlyMap<string, UserMessage>,
  forkItems: ReadonlyMap<string, string | undefined>,
  attachments: ZenXThreadAttachmentProjection,
  toolTargets: ReadonlyMap<string, ToolActionTarget>,
  previous?: TurnCanonicalPresentationIndex,
  quoteItems: ReadonlyMap<string, readonly CanonicalItem[]> = new Map(),
): TurnCanonicalPresentationIndex {
  const before = previous?.scope === scope ? previous.turns : undefined;
  const next = new Map<string, TurnCanonicalPresentation>();
  for (const turn of turns) {
    const inputEntries: [string, UserMessage][] = [];
    const quoteEntries: [string, readonly CanonicalItem[]][] = [];
    const forkEntries: [string, string | undefined][] = [];
    const attachmentEntries: [
      string,
      ZenXThreadAttachmentProjection[string],
    ][] = [];
    const targetEntries: [string, ToolActionTarget][] = [];
    // Item IDs, not text or current turn status, select canonical metadata.
    // This preserves imported history and late canonical backfills.
    for (const item of turn.items) {
      const quotes = quoteItems.get(item.id);
      if (quotes !== undefined) quoteEntries.push([item.id, quotes]);
      const input = inputs.get(item.id);
      if (input !== undefined) inputEntries.push([item.id, input]);
      if (forkItems.has(item.id))
        forkEntries.push([item.id, forkItems.get(item.id)]);
      const media = attachments[item.id];
      if (media !== undefined) attachmentEntries.push([item.id, media]);
      const target = toolTargets.get(item.id);
      if (target !== undefined) targetEntries.push([item.id, target]);
    }
    const old = before?.get(turn.id);
    if (
      old !== undefined &&
      sameEntries(old.inputs, inputEntries) &&
      sameEntries(
        old.quoteItems,
        quoteEntries,
        (a, b) =>
          a.length === b.length && a.every((item, index) => item === b[index]),
      ) &&
      sameEntries(old.forkItems, forkEntries) &&
      sameAttachments(old.attachments, attachmentEntries) &&
      sameEntries(old.toolTargets, targetEntries, sameTarget)
    ) {
      next.set(turn.id, old);
    } else {
      next.set(turn.id, {
        inputs: new Map(inputEntries),
        quoteItems: new Map(quoteEntries),
        forkItems: new Map(forkEntries),
        attachments: Object.fromEntries(attachmentEntries),
        toolTargets: new Map(targetEntries),
      });
    }
  }
  return { scope, turns: next };
}

/** Preserve complete call/result quote ownership before per-Turn partitioning. */
export function indexCanonicalQuoteItems(
  items: readonly CanonicalItem[],
): ReadonlyMap<string, readonly CanonicalItem[]> {
  const index = new Map<string, CanonicalItem[]>();
  const calls = new Map<string, string>();
  for (const item of items) {
    index.set(item.id, [item]);
    if (item.type === "tool_call")
      calls.set(JSON.stringify([item.turnId, item.callId]), item.id);
  }
  for (const item of items) {
    if (item.type !== "tool_result") continue;
    const callId = calls.get(JSON.stringify([item.turnId, item.callId]));
    if (callId) index.get(callId)?.push(item);
  }
  return index;
}
