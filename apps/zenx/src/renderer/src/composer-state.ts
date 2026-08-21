export type ComposerIntent = "start" | "steer" | "replace";

import type { ZenXImageDraft } from "../../main/image-attachments.js";

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
  draft: ComposerDraft;
  submission: ComposerSubmission | null;
}

export function emptyComposerState(): ComposerState {
  return { draft: { text: "", images: [] }, submission: null };
}

export function defaultComposerIntent(active: boolean): "start" | "steer" {
  return active ? "steer" : "start";
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
  return { draft: { ...state.draft, text }, submission };
}

export function addComposerImages(
  state: ComposerState,
  images: readonly ComposerDraftImage[],
): ComposerState {
  if (images.length === 0) return state;
  return {
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
  if (state.submission?.status === "pending") return state;
  const text = state.draft.text.trim();
  if (!composerDraftHasContent(state.draft)) return state;
  const retry =
    state.submission?.status === "failed" &&
    state.submission.intent === intent &&
    state.submission.expectedTurnId === expectedTurnId &&
    sameDraft(state.submission.draftAtSubmit, state.draft);
  return {
    ...state,
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

export function acceptComposerSubmission(
  state: ComposerState,
  clientUserMessageId: string,
): ComposerState {
  const submission = matchingSubmission(state, clientUserMessageId);
  if (submission === null) return state;
  return {
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
