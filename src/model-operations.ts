import {
  originalUserInput,
  textFromUserInput,
  type CanonicalItem,
  type ModelOperationItem,
} from "./item.js";
import type { AttachmentRef } from "./attachment-ref.js";
import { sourceModelMessage, type ModelMessage } from "./model.js";

export const MODEL_PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
export const DEFAULT_CANONICAL_TITLE_PROMPT =
  "Create a concise title of at most 64 characters in the same language as this request. Return only the title.\n\nRequest:\n{{request}}";

export function canonicalTitleSource(input: string): string | null {
  const value = input
    .replace(/^\s*\[ZenX trigger wakeup\][\s\S]*?\n\s*Task:\s*/iu, "")
    .replace(/^\s*(?:Trigger ID|Wakeup ID|Client ID|Thread ID):.*$/gimu, "")
    .replace(/^\s*Source (?:Thread|Turn|Room|Room message):.*$/gimu, "")
    .replace(
      /\b(?:zenx-wakeup:[^\s]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/giu,
      " ",
    )
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return value.length ? value.slice(0, 2000) : null;
}
export function renderCanonicalTitlePrompt(
  template: string | undefined,
  input: string,
): string {
  return (template ?? DEFAULT_CANONICAL_TITLE_PROMPT).replaceAll(
    "{{request}}",
    () => input,
  );
}

/** Auxiliary semantics are constructed here, not in Settings or adapter code. */
export function compileModelOperationMessage(
  operation: ModelOperationItem,
  items: readonly CanonicalItem[],
  options: { titleTemplate?: string; probeAttachment?: AttachmentRef },
): ModelMessage {
  if (operation.kind === "title") {
    const source = items.find((item) => item.id === operation.sourceItemIds[0]);
    if (source?.type !== "user_message")
      throw new Error(
        "Title operation requires a canonical human message source",
      );
    const text = canonicalTitleSource(
      textFromUserInput(originalUserInput(source)),
    );
    if (text === null)
      throw new Error("Canonical title source has no meaningful text");
    return sourceModelMessage(
      {
        role: "user",
        text: renderCanonicalTitlePrompt(options.titleTemplate, text),
      },
      {
        itemIds: [operation.id, source.id],
        purpose: "auxiliary-title",
        origin: "host",
      },
    );
  }
  if (!options.probeAttachment)
    throw new Error("Image probe requires its canonical attachment");
  return sourceModelMessage(
    {
      role: "user",
      content: [
        { type: "text", text: "Reply OK." },
        { type: "image", attachment: options.probeAttachment },
      ],
    },
    {
      itemIds: [operation.id],
      purpose: "auxiliary-image-probe",
      origin: "host",
    },
  );
}
