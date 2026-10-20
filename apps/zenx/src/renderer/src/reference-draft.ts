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
  const quotes = references.filter((reference) => reference.kind === "message");
  if (quotes.length === 0 || !clientId)
    return [text, ...references.map(referenceText)]
      .filter(Boolean)
      .join("\n\n");
  // One canonical text part carries both the question and exact quote snapshots.
  // A matching send identity opts in to presentation; it is not authentication.
  return (
    SENT_QUOTE_PREFIX +
    JSON.stringify({
      version: 1,
      clientId,
      text: [
        text,
        ...references
          .filter((reference) => reference.kind !== "message")
          .map(referenceText),
      ]
        .filter(Boolean)
        .join("\n\n"),
      quotes: quotes.map(({ threadId, id, excerpt }) => ({
        threadId,
        id,
        excerpt,
      })),
    })
  );
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
export function parseSentReferenceMessage(
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
