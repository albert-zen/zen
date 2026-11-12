import {
  parseSentReferenceV3,
  serializeSentReferenceV3,
  type Reference,
} from "../../../../../src/selected-reference-protocol.js";
import { inlineReferenceParts } from "./reference-draft.js";
import { referenceText } from "./composer-selector.js";

// Clipboard metadata is user input, not a permission or trusted source claim.
export const REFERENCE_CLIPBOARD_TYPE = "application/x-zenx-references-v3";
const CLIENT = "zenx-clipboard";
export function referenceClipboard(
  text: string,
  references: readonly Reference[],
) {
  const parts = inlineReferenceParts(text, references);
  return {
    plain: parts
      .map((part) =>
        "text" in part ? part.text : referenceText(part.reference),
      )
      .join(""),
    structured: serializeSentReferenceV3(parts, CLIENT),
  };
}
export function readReferenceClipboard(
  data: Pick<DataTransfer, "getData"> | null,
) {
  if (!data) return null;
  try {
    const parsed = parseSentReferenceV3(
      data.getData(REFERENCE_CLIPBOARD_TYPE),
      CLIENT,
    );
    if (
      !parsed ||
      referenceClipboard(parsed.text, parsed.references).plain !==
        data.getData("text/plain")
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}
