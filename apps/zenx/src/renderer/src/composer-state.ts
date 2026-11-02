import { parseSkillDraft, withSkillDraft } from "./skill-draft.js";
import { normalizeInlineReferences } from "./reference-draft.js";
import type { ClientSendObservation } from "../../../../../src/client-observation.js";
export type ComposerIntent =
  "start" | "batch-next" | "queue" | "steer" | "replace";

import type { ZenXImageDraft } from "../../main/image-attachments.js";
import type { CanonicalItem } from "../../../../../src/item.js";

export type ComposerDraftImage = ZenXImageDraft;

export interface ComposerDraft {
  text: string;
  images: readonly ComposerDraftImage[];
}

export interface ComposerSubmission {
  immediateFeedback?: true;
  clientObservation?: ClientSendObservation;
  clientTimezone?: string;
  intent: ComposerIntent;
  expectedTurnId: string | null;
  clientUserMessageId: string;
  draftRevision: number;
  draftAtSubmit: ComposerDraft;
  text: string;
  images: readonly ComposerDraftImage[];
  status: "pending" | "failed";
  error: string | null;
}

/** Renderer-only recovery text; never a durable admission or execution record. */
export interface PendingSendPresentation {
  clientId: string;
  intent: ComposerIntent;
  draft: ComposerDraft;
  status: "sending" | "admitted" | "unconfirmed" | "notSent";
  error: string | null;
  recovered?: boolean;
}

export interface ComposerState {
  pendingSends?: readonly PendingSendPresentation[];
  /** Local draft identity: editing away and back never restores clear authority. */
  draftRevision: number;
  /** Ephemeral UI acknowledgement of an uncertain admission, not an execution record. */
  confirmedAdmission?: {
    clientId: string;
    stage: "queued" | "delivered" | "completed" | "ended";
  };
  /** Local explicit-request identity is independent of live status presentation. */
  compactionRequest?: {
    token: object;
    operationId?: string;
    observedCommitItemId?: string;
  };
  /** Current connection watermark for compaction feedback, never durable. */
  compactionObservation?: { processEpoch: string; watermark: number };
  /** Transient command feedback; never a message or durable execution state. */
  compaction?: {
    operationId?: string;
    coveredThroughItemId?: string;
    startedAfterItemId?: string;
    compactionItemId?: string;
    outcomeUnknown?: boolean;
    status: "pending" | "succeeded" | "failed";
    message: string;
    detail?: string;
  };
  draft: ComposerDraft;
  submission: ComposerSubmission | null;
}

export function emptyComposerState(): ComposerState {
  return {
    draftRevision: 0,
    draft: { text: "", images: [] },
    submission: null,
  };
}

/** Invalidate old submission clear authority when the global send mode changes. */
export function advanceComposerDraftRevision(
  state: ComposerState,
): ComposerState {
  return {
    ...state,
    draftRevision: state.draftRevision + 1,
    confirmedAdmission: undefined,
  };
}

export type ComposerSendMode = "batch" | "queue" | "soft" | "hard";
export function defaultComposerIntent(
  active: boolean,
  mode: ComposerSendMode = "soft",
  alternate = false,
): ComposerIntent {
  if (!active) return "start";
  if (alternate)
    return mode === "queue" || mode === "batch" ? "steer" : "batch-next";
  return mode === "batch"
    ? "batch-next"
    : mode === "queue"
      ? "queue"
      : mode === "soft"
        ? "steer"
        : "replace";
}

export function editComposer(
  state: ComposerState,
  text: string,
): ComposerState {
  return {
    ...state,
    draftRevision: state.draftRevision + (text !== state.draft.text ? 1 : 0),
    draft: { ...state.draft, text },
    // Retain a failed old operation's ID for canonical reconciliation; its
    // error belongs to that operation, not to the newly edited draft.
    ...(text !== state.draft.text ? { confirmedAdmission: undefined } : {}),
  };
}

export function addComposerImages(
  state: ComposerState,
  images: readonly ComposerDraftImage[],
): ComposerState {
  if (images.length === 0) return state;
  return {
    ...state,
    draftRevision: state.draftRevision + 1,
    confirmedAdmission: undefined,
    draft: { ...state.draft, images: [...state.draft.images, ...images] },
  };
}

export function removeComposerImage(
  state: ComposerState,
  imageId: string,
): ComposerState {
  const images = state.draft.images.filter((image) => image.id !== imageId);
  if (images.length === state.draft.images.length) return state;
  return {
    ...state,
    draftRevision: state.draftRevision + 1,
    confirmedAdmission: undefined,
    draft: { ...state.draft, images },
  };
}

export function composerDraftHasContent(draft: ComposerDraft): boolean {
  return draft.text.trim().length > 0 || draft.images.length > 0;
}

/** OS/browser-reported zone only; unavailable metadata is left to Host fallback. */
export function clientTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function beginComposerSubmission(
  state: ComposerState,
  intent: ComposerIntent,
  expectedTurnId: string | null,
  createId: () => string,
  clientObservation?: ClientSendObservation,
  timezone: () => string | undefined = clientTimeZone,
): ComposerState {
  if (
    state.submission?.status === "pending" ||
    state.compaction?.status === "pending"
  )
    return state;
  const text = state.draft.text.trim();
  if (!composerDraftHasContent(state.draft)) return state;
  const retry =
    state.submission?.status === "failed" &&
    state.submission.intent === intent &&
    state.submission.expectedTurnId === expectedTurnId &&
    state.submission.draftRevision === state.draftRevision &&
    sameDraft(state.submission.draftAtSubmit, state.draft);
  const clientTimezone = retry ? state.submission!.clientTimezone : timezone();
  return {
    ...state,
    confirmedAdmission: undefined,
    submission: {
      ...(clientObservation === undefined ? {} : { clientObservation }),
      ...(clientTimezone === undefined ? {} : { clientTimezone }),
      intent,
      expectedTurnId,
      draftRevision: state.draftRevision,
      clientUserMessageId: retry
        ? state.submission!.clientUserMessageId
        : createId(),
      draftAtSubmit: cloneDraft(state.draft),
      text,
      images: [...state.draft.images],
      status: "pending",
      error: null,
    },
  };
}

/**
 * Ordinary existing-thread Send transfers the draft to an explicitly local row.
 * The original submission still owns admission and the pending-send guard.
 */
export function beginImmediateComposerSubmission(
  state: ComposerState,
  intent: ComposerIntent,
  expectedTurnId: string | null,
  createId: () => string,
  clientObservation?: ClientSendObservation,
  timezone: () => string | undefined = clientTimeZone,
): ComposerState {
  const next = beginComposerSubmission(
    state, intent, expectedTurnId, createId, clientObservation, timezone,
  );
  if (next === state || next.submission === null) return next;
  const submission = next.submission;
  return {
    ...next,
    submission: { ...submission, immediateFeedback: true },
    draftRevision: next.draftRevision + 1,
    draft: { text: "", images: [] },
    pendingSends: [
      ...(state.pendingSends ?? []).filter(
        (entry) => entry.clientId !== submission.clientUserMessageId,
      ),
      {
        clientId: submission.clientUserMessageId,
        intent,
        draft: cloneDraft(submission.draftAtSubmit),
        status: "sending",
        error: null,
      },
    ],
  };
}

/** A read/event confirms exact identities only; absence does not prove rejection. */
function reconcilePendingSendPresentations(
  state: ComposerState,
  items: readonly CanonicalItem[],
): ComposerState {
  if (!state.pendingSends?.length) return state;
  const admitted = new Set<string>();
  for (const item of items) {
    if (
      (item.type === "user_message" || item.type === "user_message_queued") &&
      item.clientId !== undefined
    ) admitted.add(item.clientId);
  }
  const pendingSends = state.pendingSends.filter(
    (entry) => !admitted.has(entry.clientId),
  );
  return pendingSends.length === state.pendingSends.length
    ? state
    : { ...state, pendingSends };
}

/** Decode once per draft, preserve UTF-16 token positions, and encode one header. */
function mergeRecoveredDraftText(newer: string, recovered: string): string {
  const newerDraft = parseSkillDraft(newer);
  const recoveredDraft = parseSkillDraft(recovered);
  const first = normalizeInlineReferences(newerDraft.text, newerDraft.references);
  const second = normalizeInlineReferences(recoveredDraft.text, recoveredDraft.references);
  const separator = first.text.length > 0 && second.text.length > 0 ? "\n\n" : "";
  const offset = first.text.length + separator.length;
  return withSkillDraft(
    first.text + separator + second.text,
    [...newerDraft.skills, ...recoveredDraft.skills],
    [
      ...first.references,
      ...second.references.map((reference) => ({
        ...reference,
        position: reference.position! + offset,
      })),
    ],
  );
}

/** Explicit recovery never overwrites a newer draft or sends anything. */
export function recoverPendingSend(
  state: ComposerState,
  clientId: string,
): ComposerState {
  const entry = state.pendingSends?.find((item) => item.clientId === clientId);
  if (
    entry === undefined ||
    entry.recovered ||
    (entry.status !== "unconfirmed" && entry.status !== "notSent")
  ) return state;
  const empty = !composerDraftHasContent(state.draft);
  const images = [...state.draft.images];
  for (const image of entry.draft.images) {
    if (!images.some((existing) => existing.id === image.id)) images.push(image);
  }
  const draft = empty
    ? cloneDraft(entry.draft)
    : {
        text: mergeRecoveredDraftText(state.draft.text, entry.draft.text),
        images,
      };
  const draftRevision = state.draftRevision + 1;
  return {
    ...state,
    draft,
    draftRevision,
    // Recovering unchanged text can explicitly retry using existing idempotency.
    // Merging into a newer draft intentionally does not inherit that identity.
    submission:
      empty && state.submission?.clientUserMessageId === clientId
        ? { ...state.submission, draftRevision }
        : state.submission,
    pendingSends: state.pendingSends!.map((item) =>
      item.clientId === clientId ? { ...item, recovered: true } : item,
    ),
  };
}

export function dismissPendingSend(
  state: ComposerState,
  clientId: string,
): ComposerState {
  const entry = state.pendingSends?.find((item) => item.clientId === clientId);
  if (entry === undefined || !entry.recovered) return state;
  return {
    ...state,
    pendingSends: state.pendingSends!.filter((item) => item.clientId !== clientId),
  };
}

/** Before dispatch is known not sent; after dispatch, generic IPC errors are unknown. */
export function failImmediateComposerSubmission(
  state: ComposerState,
  clientId: string,
  error: string,
  dispatched: boolean,
): ComposerState {
  const entry = state.pendingSends?.find((item) => item.clientId === clientId);
  if (entry === undefined) return failComposerSubmission(state, clientId, error);
  const failed = failComposerSubmission(state, clientId, error);
  const next: ComposerState = {
    ...failed,
    pendingSends: failed.pendingSends!.map((item) =>
      item.clientId === clientId
        ? { ...item, status: dispatched ? "unconfirmed" : "notSent", error }
        : item,
    ),
  };
  // A known pre-dispatch failure may restore only the still-owned blank editor.
  if (
    !dispatched &&
    !composerDraftHasContent(next.draft) &&
    next.submission?.clientUserMessageId === clientId &&
    next.draftRevision === next.submission.draftRevision + 1
  ) return recoverPendingSend(next, clientId);
  return next;
}

/** Reconcile only exact canonical client identity, never text or queue disappearance. */
export function reconcileCanonicalAdmission(
  state: ComposerState,
  items: readonly CanonicalItem[],
  terminalEvent?: {
    turnId: string;
    status: "completed" | "failed" | "interrupted";
  },
): ComposerState {
  state = reconcilePendingSendPresentations(state, items);
  const feedback = state.compaction;
  if (feedback?.operationId !== undefined) {
    const fence = items.findIndex(
      (item) => item.id === feedback.startedAfterItemId,
    );
    const committed = items.find(
      (item, index) =>
        item.type === "context_compaction" &&
        (feedback.compactionItemId !== undefined
          ? item.id === feedback.compactionItemId
          : (feedback.status === "pending" ||
              feedback.outcomeUnknown === true) &&
            fence >= 0 &&
            index > fence &&
            item.coveredThroughItemId === feedback.coveredThroughItemId),
    );
    if (committed !== undefined) {
      const { compaction: _observed, ...rest } = state;
      state = {
        ...rest,
        ...(state.compactionRequest === undefined ||
        state.compactionRequest.operationId !== feedback.operationId
          ? {}
          : {
              compactionRequest: {
                ...state.compactionRequest,
                observedCommitItemId: committed.id,
              },
            }),
      };
    }
  }
  const submission = state.submission;
  const clientId =
    submission?.clientUserMessageId ?? state.confirmedAdmission?.clientId;
  if (
    clientId === undefined ||
    (submission?.status === "failed" &&
      submission.immediateFeedback !== true &&
      !submission.error?.includes("outcome unknown"))
  )
    return state;
  const delivered = items.find(
    (item) => item.type === "user_message" && item.clientId === clientId,
  );
  const queued = items.some(
    (item) => item.type === "user_message_queued" && item.clientId === clientId,
  );
  // A queued record only confirms a queue submission; other modes require
  // the actual user_message associated with a Turn.
  if (
    delivered === undefined &&
    (!queued || (submission !== null && submission.intent !== "queue"))
  )
    return state;
  const terminal =
    delivered === undefined
      ? undefined
      : items.find(
          (item) =>
            (item.type === "turn_completed" || item.type === "turn_aborted") &&
            item.turnId === delivered.turnId,
        );
  const stage =
    terminal?.type === "turn_completed" && terminal.status === "completed"
      ? "completed"
      : terminal !== undefined
        ? "ended"
        : delivered !== undefined && terminalEvent?.turnId === delivered.turnId
          ? terminalEvent?.status === "completed"
            ? "completed"
            : "ended"
          : delivered !== undefined
            ? "delivered"
            : "queued";
  if (
    submission === null &&
    state.confirmedAdmission?.clientId === clientId &&
    (state.confirmedAdmission.stage === "completed" ||
      state.confirmedAdmission.stage === "ended") &&
    (stage === "queued" || stage === "delivered")
  )
    return state;
  if (submission === null && state.confirmedAdmission?.stage === stage)
    return state;
  if (submission !== null) {
    return {
      ...state,
      draft: canClearSubmittedDraft(state, submission)
        ? { text: "", images: [] }
        : state.draft,
      submission: null,
      confirmedAdmission: { clientId, stage },
    };
  }
  return { ...state, confirmedAdmission: { clientId, stage } };
}

export function acceptComposerSubmission(
  state: ComposerState,
  clientUserMessageId: string,
): ComposerState {
  const submission = matchingSubmission(state, clientUserMessageId);
  if (submission === null) return state;
  return {
    ...(state.compaction === undefined ? {} : { compaction: state.compaction }),
    ...(state.compactionRequest === undefined
      ? {}
      : { compactionRequest: state.compactionRequest }),
    ...(state.compactionObservation === undefined
      ? {}
      : { compactionObservation: state.compactionObservation }),
    ...(state.pendingSends === undefined ? {} : {
      pendingSends: state.pendingSends.map((entry) =>
        entry.clientId === clientUserMessageId
          ? { ...entry, status: "admitted" as const, error: null }
          : entry,
      ),
    }),
    draftRevision: state.draftRevision,
    draft: canClearSubmittedDraft(state, submission)
      ? { text: "", images: [] }
      : state.draft,
    submission: null,
  };
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return { text: draft.text, images: [...draft.images] };
}

function sameDraft(left: ComposerDraft, right: ComposerDraft): boolean {
  return (
    left.text === right.text &&
    left.images.length === right.images.length &&
    left.images.every((image, index) => image.id === right.images[index]?.id)
  );
}

function canClearSubmittedDraft(
  state: ComposerState,
  submission: ComposerSubmission,
): boolean {
  return (
    state.draftRevision === submission.draftRevision &&
    sameDraft(state.draft, submission.draftAtSubmit)
  );
}

export function failComposerSubmission(
  state: ComposerState,
  clientUserMessageId: string,
  error: string,
): ComposerState {
  const submission = matchingSubmission(state, clientUserMessageId);
  if (submission === null) return state;
  return {
    ...state,
    submission: { ...submission, status: "failed", error },
  };
}

function matchingSubmission(
  state: ComposerState,
  clientUserMessageId: string,
): ComposerSubmission | null {
  return state.submission?.clientUserMessageId === clientUserMessageId
    ? state.submission
    : null;
}

export function dismissCompactionFeedback(state: ComposerState): ComposerState {
  if (state.compaction === undefined || state.compaction.status === "pending")
    return state;
  const { compaction: _feedback, ...rest } = state;
  return rest;
}
