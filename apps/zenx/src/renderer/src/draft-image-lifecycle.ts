import type { ComposerState } from "./composer-state.js";

/** A frozen/uncertain submission keeps its image lease even after editing the visible draft. */
export function composerRetainsImage(
  state: ComposerState,
  id: string,
): boolean {
  return [
    ...state.draft.images,
    ...(state.submission?.images ?? []),
    ...(state.submission?.draftAtSubmit.images ?? []),
    ...(state.pendingSends ?? []).flatMap((entry) => entry.draft.images),
  ].some((image) => image.id === id);
}

export function abandonUnusedComposerImage(
  id: string,
  state: ComposerState,
): void {
  if (!composerRetainsImage(state, id)) abandonDraftImage(id);
}

/** Explicitly closing a local draft discards its visible input, not frozen sends. */
export function abandonClosedComposerImages(state: ComposerState): void {
  const remaining = { ...state, draft: { text: "", images: [] } };
  for (const image of state.draft.images)
    abandonUnusedComposerImage(image.id, remaining);
}

/** Failed/unavailable cleanup IPC retains the payload instead of losing input. */
export function abandonDraftImage(id: string): void {
  if (typeof window.zenx?.imageAttachments?.abandon !== "function") return;
  void window.zenx.imageAttachments
    .abandon([id])
    .catch((error: unknown) =>
      console.warn(
        "Removed draft image could not be retired; its payload is retained",
        error,
      ),
    );
}
