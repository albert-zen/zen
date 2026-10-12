import type { UserInput } from "../../../../../src/item.js";
import type { ComposerDraft } from "./composer-state.js";
import { i18n } from "./i18n.js";

/** Only the existing Composer's plain text + ordered image shape is editable. */
export function queuedInputDraft(
  input: UserInput,
  queuedItemId: string,
): ComposerDraft | null {
  let text = "";
  let seenText = false;
  const images: ComposerDraft["images"][number][] = [];
  for (const part of input) {
    if (part.type === "text") {
      if (part.skillSource !== undefined || seenText || images.length > 0)
        return null;
      text = part.text;
      seenText = true;
    } else if (part.type === "image") {
      images.push({
        id: `${queuedItemId}:image:${images.length}`,
        name: i18n.t("shell:attachedImageName", { number: images.length + 1 }),
        attachment: part.attachment,
      });
    } else return null;
  }
  return { text, images };
}

export function queuedDraftInput(draft: ComposerDraft): UserInput {
  return [
    ...(draft.text.length > 0
      ? [{ type: "text" as const, text: draft.text }]
      : []),
    ...draft.images.map((image) => ({
      type: "image" as const,
      attachment: image.attachment,
    })),
  ];
}
