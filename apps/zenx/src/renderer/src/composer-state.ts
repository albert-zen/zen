export type ComposerIntent = "start" | "steer" | "replace";

export interface ComposerSubmission {
  intent: ComposerIntent;
  expectedTurnId: string | null;
  clientUserMessageId: string;
  draftAtSubmit: string;
  text: string;
  status: "pending" | "failed";
  error: string | null;
}

export interface ComposerState {
  draft: string;
  submission: ComposerSubmission | null;
}

export function emptyComposerState(): ComposerState {
  return { draft: "", submission: null };
}

export function defaultComposerIntent(active: boolean): "start" | "steer" {
  return active ? "steer" : "start";
}

export function editComposer(
  state: ComposerState,
  draft: string,
): ComposerState {
  const submission =
    state.submission?.status === "failed" &&
    draft !== state.submission.draftAtSubmit
      ? null
      : state.submission;
  return { draft, submission };
}

export function beginComposerSubmission(
  state: ComposerState,
  intent: ComposerIntent,
  expectedTurnId: string | null,
  createId: () => string,
): ComposerState {
  if (state.submission?.status === "pending") return state;
  const text = state.draft.trim();
  if (text.length === 0) return state;
  const retry =
    state.submission?.status === "failed" &&
    state.submission.intent === intent &&
    state.submission.expectedTurnId === expectedTurnId &&
    state.submission.draftAtSubmit === state.draft;
  return {
    ...state,
    submission: {
      intent,
      expectedTurnId,
      clientUserMessageId: retry
        ? state.submission!.clientUserMessageId
        : createId(),
      draftAtSubmit: state.draft,
      text,
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
    draft: state.draft === submission.draftAtSubmit ? "" : state.draft,
    submission: null,
  };
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
