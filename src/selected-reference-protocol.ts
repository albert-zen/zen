/** Browser-safe codec; the client ID is a presentation discriminator, not authentication. */
export type Reference =
  | {
      kind: "file";
      name: string;
      cwd: string;
      path: string;
      /** UTF-16 offset of this reference's U+FFFC token in Composer text. */
      position?: number;
    }
  | {
      kind: "thread";
      name: string;
      cwd: string;
      id: string;
      /** UTF-16 offset of this reference's U+FFFC token in Composer text. */
      position?: number;
    }
  | MessageQuoteReference
  | TextQuoteReference;

export interface TextQuoteReference {
  kind: "text";
  name: string;
  cwd: string;
  position?: number;
  excerpt: string;
  sources: Array<{ threadId: string; id: string }>;
}
export type QuoteReference = MessageQuoteReference | TextQuoteReference;

export interface MessageQuoteReference {
  kind: "message";
  name: string;
  cwd: string;
  /** UTF-16 offset of this reference's U+FFFC token in Composer text. */
  position?: number;
  threadId: string;
  id: string;
  /** The exact browser-selected rendered text. */
  excerpt: string;
}

export type SentReferencePart = { text: string } | { reference: Reference };

/** Existing v3 wire codec, shared by Composer and semantic input preparation. */
export function serializeSentReferenceV3(
  parts: readonly SentReferencePart[],
  clientId: string,
): string {
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
}

const OBJECT_REPLACEMENT = "\uFFFC";

export const SENT_REFERENCE_V3_HEADER_PREFIX =
  "[zenx-reference-message:v3;clientId=";
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

export function sentReference(reference: Reference) {
  const common = {
    kind: reference.kind,
    name: reference.name,
    cwd: reference.cwd,
  };
  if (reference.kind === "file")
    return { ...common, path: reference.path, contentMode: "pointer" };
  if (reference.kind === "thread")
    return { ...common, id: reference.id, contentMode: "pointer" };
  if (reference.kind === "text")
    return {
      ...common,
      excerpt: reference.excerpt,
      sources: reference.sources,
      contentMode: "excerpt",
    };
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
          : kind === "text"
            ? "contentMode,cwd,excerpt,kind,name,sources"
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
    (kind === "text" &&
      (!validTextQuote(record) || record.contentMode !== "excerpt")) ||
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

export function parseSentReferenceV3(
  text: string,
  expectedClientId: string,
): { text: string; references: Reference[] } | null {
  if (!expectedClientId || !text.startsWith(SENT_REFERENCE_V3_HEADER_PREFIX))
    return null;
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
  const parts: SentReferencePart[] = [];
  let cursor = 0;
  for (const reference of references) {
    parts.push({ text: decodedText.slice(cursor, reference.position) });
    parts.push({ reference });
    cursor = reference.position! + 1;
  }
  parts.push({ text: decodedText.slice(cursor) });
  if (serializeSentReferenceV3(parts, clientId) !== text) return null;
  return { text: decodedText, references };
}

const SENT_REFERENCE_PREFIX = "[zenx-reference-message:v2]\n";
/** Exact versioned presentation, never reference inference from ordinary text. */
export function parseSentReferenceContent(
  text: string,
  clientId?: string | null,
): { text: string; references: Reference[] } {
  const ordinary = { text, references: [] };
  const unbound = parseLegacyPlainMessageQuote(text);
  if (unbound) return unbound;
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
            : entry.kind === "text"
              ? "contentMode,cwd,excerpt,kind,name,sources"
              : "contentMode,cwd,excerpt,id,kind,name,threadId";
      if (
        keys !== expected ||
        record.contentMode !==
          (entry.kind === "message" || entry.kind === "text"
            ? "excerpt"
            : "pointer")
      )
        return ordinary;
      if (
        entry.kind === "file"
          ? !entry.path
          : entry.kind === "text"
            ? false
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

export function validTextQuote(reference: Record<string, unknown>): boolean {
  return (
    typeof reference.excerpt === "string" &&
    reference.excerpt.trim().length > 0 &&
    Array.isArray(reference.sources) &&
    reference.sources.every(
      (source) =>
        source !== null &&
        typeof source === "object" &&
        !Array.isArray(source) &&
        Object.keys(source).sort().join(",") === "id,threadId" &&
        typeof source.threadId === "string" &&
        source.threadId.length > 0 &&
        typeof source.id === "string" &&
        source.id.length > 0,
    )
  );
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
    ((reference.kind === "text" && validTextQuote(reference)) ||
      (reference.kind === "file" && typeof reference.path === "string") ||
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

/** Strict compatibility for the old clipboard/no-client quote formatter.
 * Only a canonical leading quote is recognized; examples embedded in prose,
 * malformed JSON and unknown variants remain ordinary text. This is user input,
 * not authentication, and the original input fact is never rewritten.
 */
function parseLegacyPlainMessageQuote(
  text: string,
): { text: string; references: Reference[] } | null {
  const string =
    '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const pattern = new RegExp(
    `^\\[Message quote; thread ID: (${string}); message ID: (${string}); excerpt: (${string})\\]`,
    "u",
  );
  const match = pattern.exec(text);
  if (!match) return null;
  try {
    const [threadId, id, excerpt] = match
      .slice(1)
      .map((value) => JSON.parse(value) as string);
    if (!threadId || !id || !excerpt?.trim()) return null;
    const canonical = `[Message quote; thread ID: ${JSON.stringify(threadId)}; message ID: ${JSON.stringify(id)}; excerpt: ${JSON.stringify(excerpt)}]`;
    if (match[0] !== canonical) return null;
    return {
      text: OBJECT_REPLACEMENT + text.slice(match[0].length),
      references: [
        {
          kind: "message",
          name: "ZenX",
          cwd: "",
          threadId,
          id,
          excerpt,
          position: 0,
        },
      ],
    };
  } catch {
    return null;
  }
}
