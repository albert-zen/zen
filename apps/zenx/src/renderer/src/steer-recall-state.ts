import type { CanonicalItem, SteerRecallTarget } from "../../../../../src/item.js";
import {
  pendingSteerMessages,
  recoverSteerRecall,
  sameSteerRecallTargets,
  type RecoveredSteerRecall,
} from "../../../../../src/steer-recall.js";
import type {
  NativeSteerRecallParams,
  NativeSteerRecallResult,
} from "../../../../../src/protocol/native/wire.js";
import type { ComposerDraft, ComposerState } from "./composer-state.js";
import { queuedInputDraft } from "./queue-edit-draft.js";
import { parseSkillDraft, withSkillDraft } from "./skill-draft.js";
import { normalizeInlineReferences } from "./reference-draft.js";

export function recallTargets(items: readonly CanonicalItem[]): SteerRecallTarget[] {
  return pendingSteerMessages(items).map((item) => ({
    queuedItemId: item.id,
    clientId: item.clientId,
    expectedRevision: item.revision,
  }));
}

/** Decode each original client-bound reference envelope before combining bodies. */
export function recalledDrafts(result: RecoveredSteerRecall): ComposerDraft[] | null {
  const drafts: ComposerDraft[] = [];
  for (const message of result.messages) {
    const draft = queuedInputDraft(message.input, message.id, message.clientId);
    if (draft === null) return null;
    drafts.push(draft);
  }
  return drafts;
}

/** Ordered visible bodies; exactly one draft envelope and UTF-16 reference offsets. */
export function mergeComposerDrafts(drafts: readonly ComposerDraft[]): ComposerDraft {
  let text = "";
  const skills: ReturnType<typeof parseSkillDraft>["skills"] = [];
  const references: ReturnType<typeof parseSkillDraft>["references"] = [];
  const images: ComposerDraft["images"][number][] = [];
  for (const draft of drafts) {
    const parsed = parseSkillDraft(draft.text);
    const normalized = normalizeInlineReferences(parsed.text, parsed.references);
    const separator = text.length > 0 && normalized.text.length > 0 ? "\n\n" : "";
    const offset = text.length + separator.length;
    text += separator + normalized.text;
    skills.push(...parsed.skills);
    references.push(...normalized.references.map((reference) => ({
      ...reference,
      position: reference.position! + offset,
    })));
    images.push(...draft.images);
  }
  return { text: withSkillDraft(text, skills, references), images };
}

/** Synchronous latest-state reducer: never restore into a submitting Composer. */
export function restoreRecalledComposer(
  state: ComposerState,
  result: RecoveredSteerRecall,
  createId: () => string,
): ComposerState {
  if (state.submission?.status === "pending") return state;
  const drafts = recalledDrafts(result);
  if (drafts === null) return state;
  const recovered = drafts.map((draft) => ({
    ...draft,
    images: draft.images.map((image) => ({ ...image, id: createId() })),
  }));
  return {
    ...state,
    draftRevision: state.draftRevision + 1,
    confirmedAdmission: undefined,
    draft: mergeComposerDrafts([...recovered, state.draft]),
    // Keep old failed-send recovery evidence; changed revision forbids ID reuse.
    submission: state.submission,
  };
}

export interface RecallSession {
  request: NativeSteerRecallParams;
  owner: symbol;
  phase: "pending" | "unknown" | "failed" | "ready";
  result?: RecoveredSteerRecall;
  error?: string;
}
export function createSteerRecallStore() {
  let snapshot: {
    sessions: Readonly<Record<string, RecallSession>>;
    applied: ReadonlySet<string>;
  } = { sessions: {}, applied: new Set() };
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(threadId: string, session: RecallSession) {
      snapshot = {
        ...snapshot,
        sessions: { ...snapshot.sessions, [threadId]: session },
      };
      publish();
    },
    applied(receiptId: string) {
      snapshot = {
        ...snapshot,
        applied: new Set([...snapshot.applied, receiptId]),
      };
      publish();
    },
  };
}
export type SteerRecallStore = ReturnType<typeof createSteerRecallStore>;

export type RecallReadResult =
  | { state: "recalled"; result: RecoveredSteerRecall }
  | { state: "conflict" }
  | { state: "unknown" };

export function resolveRecallRead(
  request: NativeSteerRecallParams,
  items: readonly CanonicalItem[],
): RecallReadResult {
  const result = recoverSteerRecall(items, request.threadId, request.recallId);
  if (result !== undefined) {
    return sameSteerRecallTargets(result.receipt.targets, request.targets)
      ? { state: "recalled", result }
      : { state: "conflict" };
  }
  const pending = new Map(
    pendingSteerMessages(items)
      .filter((item) => item.threadId === request.threadId)
      .map((item) => [item.id, item]),
  );
  if (request.targets.some((target) => {
    const current = pending.get(target.queuedItemId);
    return current === undefined ||
      current.clientId !== target.clientId ||
      current.revision !== target.expectedRevision;
  })) return { state: "conflict" };
  return { state: "unknown" };
}

export function validateRecallReply(
  request: NativeSteerRecallParams,
  result: NativeSteerRecallResult,
): RecoveredSteerRecall {
  if (
    result.receipt.threadId !== request.threadId ||
    result.receipt.recallId !== request.recallId ||
    !sameSteerRecallTargets(result.receipt.targets, request.targets) ||
    !sameSteerRecallTargets(
      result.messages.map((message) => ({
        queuedItemId: message.id,
        clientId: message.clientId,
        expectedRevision: message.revision,
      })),
      request.targets,
    )
  ) throw new Error("Mismatched recall receipt");
  return result;
}
