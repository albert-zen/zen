import type { UserInput, UserInputPart } from "./item.js";

/** Collapse only identical media, keeping explicit text and first-occurrence order. */
export function deduplicateMediaContent(content: UserInput): UserInput {
  const seen = new Set<string>();
  return content.filter((part) => {
    if (part.type === "text") return true;
    const key = `${part.type}:${part.attachment.sha256}:${part.attachment.mediaType}:${String(part.attachment.byteLength)}:${String(part.attachment.width)}:${String(part.attachment.height)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Ephemeral identity only: never infer a canonical occurrence from equal bytes. */
const mediaOrigins = new WeakMap<object, UserInputPart>();
export function canonicalMediaPart(part: UserInputPart): UserInputPart {
  return mediaOrigins.get(part) ?? part;
}
export function linkCanonicalMediaPart(
  source: UserInputPart,
  projected: UserInputPart,
): void {
  if (source.type !== "text" && projected.type !== "text")
    mediaOrigins.set(projected, canonicalMediaPart(source));
}
