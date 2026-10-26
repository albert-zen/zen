import type { UserInput } from "../../../../../src/item.js";
import type { ComposerDraft } from "./composer-state.js";
import { i18n } from "./i18n.js";
import {
  parseReferenceDraft,
  parseSentReferenceContent,
  referenceMessage,
  withReferenceDraft,
} from "./reference-draft.js";

/** Only the existing Composer's plain text + ordered image shape is editable. */
export function queuedInputDraft(
  input: UserInput,
  queuedItemId: string,
  clientId?: string,
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
  const decoded = parseSentReferenceContent(text, clientId);
  // Canonical ordinary text is visible input, never an internal draft header.
  return { text: withReferenceDraft(decoded.text, decoded.references), images };
}

export function queuedDraftInput(
  draft: ComposerDraft,
  clientId?: string,
): UserInput {
  const decoded = parseReferenceDraft(draft.text);
  const text = referenceMessage(decoded.text, decoded.references, clientId);
  return [
    ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
    ...draft.images.map((image) => ({
      type: "image" as const,
      attachment: image.attachment,
    })),
  ];
}
