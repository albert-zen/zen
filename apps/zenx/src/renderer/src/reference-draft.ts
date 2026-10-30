import { referenceText, type Reference } from "./composer-selector.js";
import {
  serializeSentReferenceV3,
  sentReference,
  type SentMessageQuote,
} from "../../../../../src/selected-reference-protocol.js";

const PREFIX = /^\[zenx-references:([^\]\n]+)\]\n/u;
const OBJECT_REPLACEMENT = "\uFFFC";

export type InlineReferencePart = { text: string } | { reference: Reference };

/**
 * Keep every reference paired with one atomic object-replacement token.
 * Legacy references without positions are appended, in their input order.
 * Positions are JavaScript/CodeMirror UTF-16 offsets.
 */
export function normalizeInlineReferences(
  text: string,
  references: readonly Reference[],
): { text: string; references: Reference[] } {
  const positioned: Reference[] = [];
  const appended: Reference[] = [];
  const claimed = new Set<number>();

  for (const reference of references) {
    const position = reference.position;
    if (
      Number.isSafeInteger(position) &&
      position! >= 0 &&
      position! < text.length &&
      text.charAt(position!) === OBJECT_REPLACEMENT &&
      !claimed.has(position!)
    ) {
      positioned.push(reference);
      claimed.add(position!);
    } else {
      // Invalid or duplicate positions cannot own an existing token. Preserve
      // their reference data by treating them like legacy unpositioned refs.
      appended.push(reference);
    }
  }

  let normalizedText = text;
  for (const reference of appended) {
    const position = normalizedText.length;
    normalizedText += OBJECT_REPLACEMENT;
    positioned.push({ ...reference, position });
  }
  positioned.sort((left, right) => left.position! - right.position!);
  return { text: normalizedText, references: positioned };
}

/** Replace a UTF-16 range while preserving the locations of surviving tokens. */
export function spliceInlineReferenceText(
  text: string,
  references: readonly Reference[],
  from: number,
  to: number,
  insertion: string,
): { text: string; references: Reference[] } {
  const normalized = normalizeInlineReferences(text, references);
  const clamp = (offset: number) =>
    Number.isFinite(offset)
      ? Math.min(normalized.text.length, Math.max(0, Math.trunc(offset)))
      : 0;
  const start = Math.min(clamp(from), clamp(to));
  const end = Math.max(clamp(from), clamp(to));
  const nextText =
    normalized.text.slice(0, start) + insertion + normalized.text.slice(end);
  const delta = insertion.length - (end - start);
  const nextReferences = normalized.references.flatMap((reference) => {
    const position = reference.position!;
    if (position >= start && position < end) return [];
    return [
      {
        ...reference,
        position: position >= end ? position + delta : position,
      },
    ];
  });
  return { text: nextText, references: nextReferences };
}

/** Replace a selection with one atomic reference token and return its caret. */
export function insertInlineReference(
  text: string,
  references: readonly Reference[],
  reference: Reference,
  from: number,
  to = from,
): { text: string; references: Reference[]; caret: number } {
  const normalized = normalizeInlineReferences(text, references);
  const clamp = (offset: number) =>
    Number.isFinite(offset)
      ? Math.min(normalized.text.length, Math.max(0, Math.trunc(offset)))
      : 0;
  const start = Math.min(clamp(from), clamp(to));
  const spliced = spliceInlineReferenceText(
    normalized.text,
    normalized.references,
    start,
    Math.max(clamp(from), clamp(to)),
    OBJECT_REPLACEMENT,
  );
  const withReference = normalizeInlineReferences(spliced.text, [
    ...spliced.references,
    { ...reference, position: start },
  ]);
  return { ...withReference, caret: start + OBJECT_REPLACEMENT.length };
}

/** Split Composer text into prose and references, in visible text order. */
export function inlineReferenceParts(
  text: string,
  references: readonly Reference[],
): InlineReferencePart[] {
  const normalized = normalizeInlineReferences(text, references);
  const parts: InlineReferencePart[] = [];
  let cursor = 0;
  for (const reference of normalized.references) {
    const position = reference.position!;
    if (position > cursor)
      parts.push({ text: normalized.text.slice(cursor, position) });
    parts.push({ reference });
    cursor = position + OBJECT_REPLACEMENT.length;
  }
  if (cursor < normalized.text.length)
    parts.push({ text: normalized.text.slice(cursor) });
  return parts;
}

function encodedReferenceDraft(draft: string): {
  text: string;
  references: Reference[];
} | null {
  const match = PREFIX.exec(draft);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(match[1]!));
    if (Array.isArray(value) && value.length > 0 && value.every(isReference))
      return { text: draft.slice(match[0].length), references: value };
  } catch {
    /* Unrecognized text stays ordinary user text. */
  }
  return null;
}

export function parseReferenceDraft(draft: string): {
  text: string;
  references: Reference[];
} {
  // Ordinary composer input is encoded through withReferenceDraft first.
  // A leading backslash run is the reversible literal escape for text that
  // would otherwise look like an internal reference draft header.
  const slashes = /^(\\+)/u.exec(draft)?.[0].length ?? 0;
  if (slashes > 0 && encodedReferenceDraft(draft.slice(slashes)))
    return { text: draft.slice(1), references: [] };
  const encoded = encodedReferenceDraft(draft);
  if (encoded) return encoded;
  return { text: draft, references: [] };
}
export function withReferenceDraft(
  text: string,
  references: readonly Reference[],
) {
  if (references.length)
    return `[zenx-references:${encodeURIComponent(JSON.stringify(references))}]\n${text}`;

  // The textarea's onChange path calls this even when it has no selected
  // references. Escape a pasted/typed valid-looking header before the next
  // render hydrates the internal draft; preserve any backslashes the user
  // already typed by always adding exactly one more.
  const slashes = /^(\\*)/u.exec(text)?.[0].length ?? 0;
  if (encodedReferenceDraft(text.slice(slashes))) return `\\${text}`;
  return text;
}
/*
 * This is a draft-only codec. Sent-message envelopes use their distinct v1/v2
 * prefixes below, and unreferenced outgoing text is never rewritten.
 */
export function referenceMessage(
  text: string,
  references: readonly Reference[],
  clientId?: string,
) {
  if (references.length === 0) return text;
  if (references.some((reference) => reference.position !== undefined)) {
    const parts = inlineReferenceParts(text, references);
    if (clientId) return serializeSentReferenceV3(parts, clientId);
    return parts
      .map((part) =>
        "text" in part ? part.text : referenceText(part.reference),
      )
      .join("");
  }
  if (!clientId)
    return [text, ...references.map(referenceText)]
      .filter(Boolean)
      .join("\n\n");
  return (
    SENT_REFERENCE_PREFIX +
    JSON.stringify({
      version: 2,
      clientId,
      text,
      references: references.map(sentReference),
    })
  );
}

const SENT_REFERENCE_PREFIX = "[zenx-reference-message:v2]\n";
export { parseSentReferenceContent } from "../../../../../src/selected-reference-protocol.js";
import { parseSentReferenceContent } from "../../../../../src/selected-reference-protocol.js";

/** Compatibility view for callers that only need quote snapshots. */
export function parseSentReferenceMessage(
  text: string,
  clientId?: string | null,
): { text: string; quotes: SentMessageQuote[] } {
  const parsed = parseSentReferenceContent(text, clientId);
  return {
    text: parsed.text,
    quotes: parsed.references.flatMap((reference) =>
      reference.kind === "message"
        ? [
            {
              threadId: reference.threadId,
              id: reference.id,
              excerpt: reference.excerpt,
            },
          ]
        : [],
    ),
  };
}

export function referenceTitle(text: string, references: readonly Reference[]) {
  if (references.some((reference) => reference.position !== undefined))
    return inlineReferenceParts(text, references)
      .map((part) => ("text" in part ? part.text : part.reference.name))
      .join("");
  return [text, ...references.map((reference) => reference.name)]
    .filter(Boolean)
    .join("\n");
}
function isReference(value: unknown): value is Reference {
  if (!value || typeof value !== "object") return false;
  const reference = value as Record<string, unknown>;
  return (
    (reference.position === undefined ||
      (Number.isSafeInteger(reference.position) &&
        (reference.position as number) >= 0)) &&
    typeof reference.name === "string" &&
    typeof reference.cwd === "string" &&
    ((reference.kind === "file" && typeof reference.path === "string") ||
      (reference.kind === "thread" && typeof reference.id === "string") ||
      (reference.kind === "message" &&
        typeof reference.threadId === "string" &&
        typeof reference.id === "string" &&
        typeof reference.excerpt === "string" &&
        reference.excerpt.trim().length > 0))
  );
}
