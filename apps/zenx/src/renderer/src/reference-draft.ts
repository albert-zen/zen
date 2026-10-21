import { referenceText, type Reference } from "./composer-selector.js";

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
    if (clientId)
      return (
        referenceMessageV3Header(clientId) +
        parts
          .map((part) =>
            "text" in part
              ? escapeReferenceProse(part.text)
              : referenceMarker(part.reference),
          )
          .join("")
      );
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
const SENT_REFERENCE_V3_HEADER_PREFIX = "[zenx-reference-message:v3;clientId=";
const SENT_REFERENCE_V3_MARKER_PREFIX = "[ZenX reference: ";

function referenceMessageV3Header(clientId: string) {
  return `${SENT_REFERENCE_V3_HEADER_PREFIX}${JSON.stringify(clientId)}]\n`;
}

function escapeReferenceProse(text: string) {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll(
      SENT_REFERENCE_V3_MARKER_PREFIX,
      `\\${SENT_REFERENCE_V3_MARKER_PREFIX}`,
    );
}

function referenceMarker(reference: Reference) {
  return `${SENT_REFERENCE_V3_MARKER_PREFIX}${JSON.stringify(sentReference(reference))}]`;
}

function sentReference(reference: Reference) {
  const common = {
    kind: reference.kind,
    name: reference.name,
    cwd: reference.cwd,
  };
  if (reference.kind === "file")
    return { ...common, path: reference.path, contentMode: "pointer" };
  if (reference.kind === "thread")
    return { ...common, id: reference.id, contentMode: "pointer" };
  return {
    ...common,
    threadId: reference.threadId,
    id: reference.id,
    contentMode: "excerpt",
    excerpt: reference.excerpt,
  };
}

function jsonStringEnd(source: string, start: number) {
  if (source[start] !== '"') return -1;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') return index + 1;
  }
  return -1;
}

function jsonObjectEnd(source: string, start: number) {
  if (source[start] !== "{") return -1;
  let depth = 0;
  let inString = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function decodedSentReference(value: unknown): Reference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const keys = Object.keys(record).sort().join(",");
  const expected =
    kind === "file"
      ? "contentMode,cwd,kind,name,path"
      : kind === "thread"
        ? "contentMode,cwd,id,kind,name"
        : kind === "message"
          ? "contentMode,cwd,excerpt,id,kind,name,threadId"
          : "";
  if (!expected || keys !== expected) return null;
  if (
    typeof record.name !== "string" ||
    typeof record.cwd !== "string" ||
    (kind === "file" &&
      (typeof record.path !== "string" ||
        !record.path ||
        record.contentMode !== "pointer")) ||
    (kind === "thread" &&
      (typeof record.id !== "string" ||
        !record.id ||
        record.contentMode !== "pointer")) ||
    (kind === "message" &&
      (typeof record.threadId !== "string" ||
        !record.threadId ||
        typeof record.id !== "string" ||
        !record.id ||
        typeof record.excerpt !== "string" ||
        !record.excerpt.trim() ||
        record.contentMode !== "excerpt"))
  )
    return null;
  const { contentMode: _contentMode, ...reference } = record;
  return reference as unknown as Reference;
}

function parseSentReferenceV3(
  text: string,
  expectedClientId: string,
): { text: string; references: Reference[] } | null {
  const stringStart = SENT_REFERENCE_V3_HEADER_PREFIX.length;
  const stringEnd = jsonStringEnd(text, stringStart);
  if (stringEnd < 0 || text.slice(stringEnd, stringEnd + 2) !== "]\n")
    return null;
  let clientId: unknown;
  try {
    clientId = JSON.parse(text.slice(stringStart, stringEnd));
  } catch {
    return null;
  }
  const headerEnd = stringEnd + 2;
  if (
    typeof clientId !== "string" ||
    clientId !== expectedClientId ||
    text.slice(0, headerEnd) !== referenceMessageV3Header(clientId)
  )
    return null;

  const body = text.slice(headerEnd);
  let decodedText = "";
  const references: Reference[] = [];
  for (let index = 0; index < body.length;) {
    if (body.startsWith(SENT_REFERENCE_V3_MARKER_PREFIX, index)) {
      const jsonStart = index + SENT_REFERENCE_V3_MARKER_PREFIX.length;
      const jsonEnd = jsonObjectEnd(body, jsonStart);
      if (jsonEnd < 0 || body[jsonEnd] !== "]") return null;
      let value: unknown;
      try {
        value = JSON.parse(body.slice(jsonStart, jsonEnd));
      } catch {
        return null;
      }
      const reference = decodedSentReference(value);
      if (!reference) return null;
      references.push({ ...reference, position: decodedText.length });
      decodedText += OBJECT_REPLACEMENT;
      index = jsonEnd + 1;
      continue;
    }
    if (body[index] === "\\") {
      if (body.startsWith("\\\\", index)) {
        decodedText += "\\";
        index += 2;
        continue;
      }
      if (body.startsWith(`\\${SENT_REFERENCE_V3_MARKER_PREFIX}`, index)) {
        decodedText += SENT_REFERENCE_V3_MARKER_PREFIX;
        index += SENT_REFERENCE_V3_MARKER_PREFIX.length + 1;
        continue;
      }
      return null;
    }
    decodedText += body[index]!;
    index += 1;
  }
  if (references.length === 0) return null;
  // This verifies escaping, marker spelling, field order and JSON spelling.
  // Any unknown or noncanonical envelope remains entirely visible as raw text.
  if (referenceMessage(decodedText, references, clientId) !== text) return null;
  return { text: decodedText, references };
}

/** Exact versioned presentation, never reference inference from ordinary text. */
export function parseSentReferenceContent(
  text: string,
  clientId?: string | null,
): { text: string; references: Reference[] } {
  const ordinary = { text, references: [] };
  if (!clientId) return ordinary;
  if (text.startsWith(SENT_REFERENCE_V3_HEADER_PREFIX))
    return parseSentReferenceV3(text, clientId) ?? ordinary;
  if (!text.startsWith(SENT_REFERENCE_PREFIX)) {
    const legacy = parseLegacyQuoteMessage(text, clientId);
    return {
      text: legacy.text,
      references: legacy.quotes.map((quote) => ({
        kind: "message",
        name: "ZenX",
        cwd: "",
        ...quote,
      })),
    };
  }
  try {
    const value: unknown = JSON.parse(text.slice(SENT_REFERENCE_PREFIX.length));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return ordinary;
    const envelope = value as Record<string, unknown>;
    if (
      SENT_REFERENCE_PREFIX + JSON.stringify(value) !== text ||
      Object.keys(envelope).sort().join(",") !==
        "clientId,references,text,version" ||
      envelope.version !== 2 ||
      envelope.clientId !== clientId ||
      typeof envelope.text !== "string" ||
      !Array.isArray(envelope.references) ||
      envelope.references.length === 0
    )
      return ordinary;
    const references: Reference[] = [];
    for (const entry of envelope.references) {
      if (!isReference(entry)) return ordinary;
      const record = entry as unknown as Record<string, unknown>;
      const keys = Object.keys(record).sort().join(",");
      const expected =
        entry.kind === "file"
          ? "contentMode,cwd,kind,name,path"
          : entry.kind === "thread"
            ? "contentMode,cwd,id,kind,name"
            : "contentMode,cwd,excerpt,id,kind,name,threadId";
      if (
        keys !== expected ||
        record.contentMode !==
          (entry.kind === "message" ? "excerpt" : "pointer")
      )
        return ordinary;
      if (
        entry.kind === "file"
          ? !entry.path
          : !entry.id || (entry.kind === "message" && !entry.threadId)
      )
        return ordinary;
      // Strip only the known presentation policy, never source text or identity.
      const { contentMode: _contentMode, ...reference } = record;
      references.push(reference as unknown as Reference);
    }
    return { text: envelope.text, references };
  } catch {
    return ordinary;
  }
}

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

const SENT_QUOTE_PREFIX = "[zenx-quoted-message:v1]\n";
export interface SentMessageQuote {
  threadId: string;
  id: string;
  excerpt: string;
}
/** Presentation only. Invalid, unbound or future formats stay completely visible. */
function parseLegacyQuoteMessage(
  text: string,
  clientId?: string | null,
): { text: string; quotes: SentMessageQuote[] } {
  const ordinary = { text, quotes: [] };
  if (!clientId || !text.startsWith(SENT_QUOTE_PREFIX)) return ordinary;
  try {
    const value: unknown = JSON.parse(text.slice(SENT_QUOTE_PREFIX.length));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return ordinary;
    const envelope = value as Record<string, unknown>;
    // Only our exact wire form opts in. JSON.parse otherwise hides duplicate
    // keys or normalizes noncanonical text that was never emitted by this sender.
    if (SENT_QUOTE_PREFIX + JSON.stringify(value) !== text) return ordinary;
    if (
      Object.keys(envelope).sort().join(",") !==
        "clientId,quotes,text,version" ||
      envelope.version !== 1 ||
      envelope.clientId !== clientId ||
      typeof envelope.text !== "string" ||
      !Array.isArray(envelope.quotes) ||
      envelope.quotes.length === 0
    )
      return ordinary;
    const quotes: SentMessageQuote[] = [];
    for (const entry of envelope.quotes) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return ordinary;
      const quote = entry as Record<string, unknown>;
      if (
        Object.keys(quote).sort().join(",") !== "excerpt,id,threadId" ||
        typeof quote.threadId !== "string" ||
        !quote.threadId ||
        typeof quote.id !== "string" ||
        !quote.id ||
        typeof quote.excerpt !== "string" ||
        !quote.excerpt.trim()
      )
        return ordinary;
      quotes.push({
        threadId: quote.threadId,
        id: quote.id,
        excerpt: quote.excerpt,
      });
    }
    return { text: envelope.text, quotes };
  } catch {
    return ordinary;
  }
}
