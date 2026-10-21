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
  clientId?: string,
) {
  if (references.length === 0) return text;
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

/** Exact versioned presentation, never reference inference from ordinary text. */
export function parseSentReferenceContent(
  text: string,
  clientId?: string | null,
): { text: string; references: Reference[] } {
  const ordinary = { text, references: [] };
  if (!clientId) return ordinary;
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
