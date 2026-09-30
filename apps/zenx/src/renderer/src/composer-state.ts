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
  intent: ComposerIntent;
  expectedTurnId: string | null;
  clientUserMessageId: string;
  draftAtSubmit: ComposerDraft;
  text: string;
  images: readonly ComposerDraftImage[];
  status: "pending" | "failed";
  error: string | null;
}

export interface ComposerState {
  /** Ephemeral UI acknowledgement of an uncertain admission, not an execution record. */
  confirmedAdmission?: {
    clientId: string;
    stage: "queued" | "delivered" | "completed" | "ended";
  };
  /** Transient command feedback; never a message or durable execution state. */
  compaction?: {
    status: "pending" | "succeeded" | "failed";
    message: string;
    detail?: string;
  };
  draft: ComposerDraft;
  submission: ComposerSubmission | null;
}

export function emptyComposerState(): ComposerState {
  return { draft: { text: "", images: [] }, submission: null };
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
  const submission =
    state.submission?.status === "failed" &&
    text !== state.submission.draftAtSubmit.text
      ? null
      : state.submission;
  return {
    ...state,
    draft: { ...state.draft, text },
    submission,
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
    confirmedAdmission: undefined,
    draft: { ...state.draft, images: [...state.draft.images, ...images] },
    submission: state.submission?.status === "failed" ? null : state.submission,
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
    confirmedAdmission: undefined,
    draft: { ...state.draft, images },
    submission: state.submission?.status === "failed" ? null : state.submission,
  };
}

export function composerDraftHasContent(draft: ComposerDraft): boolean {
  return draft.text.trim().length > 0 || draft.images.length > 0;
}

export function beginComposerSubmission(
  state: ComposerState,
  intent: ComposerIntent,
  expectedTurnId: string | null,
  createId: () => string,
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
    sameDraft(state.submission.draftAtSubmit, state.draft);
  return {
    ...state,
    confirmedAdmission: undefined,
    submission: {
      intent,
      expectedTurnId,
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

/** Reconcile only exact canonical client identity, never text or queue disappearance. */
export function reconcileCanonicalAdmission(
  state: ComposerState,
  items: readonly CanonicalItem[],
  terminalEvent?: {
    turnId: string;
    status: "completed" | "failed" | "interrupted";
  },
): ComposerState {
  const submission = state.submission;
  const clientId =
    submission?.clientUserMessageId ?? state.confirmedAdmission?.clientId;
  if (
    clientId === undefined ||
    (submission?.status === "failed" &&
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
      draft: sameDraft(state.draft, submission.draftAtSubmit)
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
    draft: sameDraft(state.draft, submission.draftAtSubmit)
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
