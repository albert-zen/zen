import { referenceText, type Reference } from "./composer-selector.js";

const PREFIX = /^\[zenx-references:([^\]\n]+)\]\n/u;
export function parseReferenceDraft(draft: string): {
  text: string;
  references: Reference[];
} {
  const match = PREFIX.exec(draft);
  if (match) {
    try {
      const value: unknown = JSON.parse(decodeURIComponent(match[1]!));
      if (Array.isArray(value) && value.every(isReference))
        return { text: draft.slice(match[0].length), references: value };
    } catch {
      /* Unrecognized text stays ordinary user text. */
    }
  }
  return { text: draft, references: [] };
}
export function withReferenceDraft(
  text: string,
  references: readonly Reference[],
) {
  return references.length
    ? `[zenx-references:${encodeURIComponent(JSON.stringify(references))}]\n${text}`
    : text;
}
export function referenceMessage(
  text: string,
  references: readonly Reference[],
) {
  return [text, ...references.map(referenceText)].filter(Boolean).join("\n\n");
}
export function referenceTitle(text: string, references: readonly Reference[]) {
  return [text, ...references.map((reference) => reference.name)]
    .filter(Boolean)
    .join("\n");
}
function isReference(value: unknown): value is Reference {
  if (!value || typeof value !== "object") return false;
  const reference = value as Record<string, unknown>;
  return (
    typeof reference.name === "string" &&
    typeof reference.cwd === "string" &&
    ((reference.kind === "file" && typeof reference.path === "string") ||
      (reference.kind === "thread" && typeof reference.id === "string"))
  );
}
