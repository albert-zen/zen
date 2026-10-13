export type ZenXLinkTarget =
  | { kind: "anchor"; href: string }
  | { kind: "external"; href: string }
  | { kind: "rejected" };

export function classifyZenXLink(raw: string): ZenXLinkTarget {
  if (raw.startsWith("#")) {
    return { kind: "anchor", href: raw };
  }
  if (raw.startsWith("//")) return { kind: "rejected" };
  try {
    const url = new URL(raw);
    return url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
      ? { kind: "external", href: url.toString() }
      : { kind: "rejected" };
  } catch {
    return { kind: "rejected" };
  }
}

export function isAllowedZenXExternalUrl(raw: string): boolean {
  return classifyZenXLink(raw).kind === "external";
}

/**
 * Bare autolinks can inherit markdown delimiter residue (emphasis that failed
 * to pair, e.g. `**` before CJK punctuation) and trailing CJK prose
 * punctuation. Cut at the first CJK punctuation mark and drop trailing ASCII
 * emphasis or sentence punctuation; neither is ever an intended link target.
 * Full-width alphanumerics and CJK characters in a path stay untouched.
 */
const CJK_PROSE_PUNCTUATION =
  /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;
const TRAILING_LINK_RESIDUE = /[*~`_'",.;:!?]+$/u;

function trimAutolinkResidue(raw: string): string {
  // Renderers hand us the href percent-encoded; decode runs of %XX bytes to
  // locate a cut point, then map it back so legitimate escapes survive.
  let decoded = "";
  const offsets: number[] = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] === "%") {
      const bytes: number[] = [];
      let end = index;
      while (/^%[0-9a-f]{2}/iu.test(raw.slice(end, end + 3))) {
        bytes.push(Number.parseInt(raw.slice(end + 1, end + 3), 16));
        end += 3;
      }
      if (bytes.length > 0) {
        for (const char of new TextDecoder().decode(Uint8Array.from(bytes))) {
          decoded += char;
          offsets.push(index);
        }
        index = end;
        continue;
      }
    }
    decoded += raw[index] ?? "";
    offsets.push(index);
    index += 1;
  }
  const cut = decoded.search(CJK_PROSE_PUNCTUATION);
  const trimmed = cut === -1 ? raw : raw.slice(0, offsets[cut]);
  return trimmed.replace(TRAILING_LINK_RESIDUE, "");
}

// Message links use the existing workspace file and Browser capabilities;
// this classifier does not grant filesystem or navigation permissions.
export function classifyMessageLink(
  raw: string,
):
  | { kind: "file"; value: string }
  | { kind: "browser"; value: string }
  | { kind: "anchor" | "external"; href: string }
  | { kind: "rejected" } {
  if (
    !raw ||
    /[\u0000-\u001f\u007f]/u.test(raw) ||
    raw.startsWith("//") ||
    raw.startsWith("\\\\")
  )
    return { kind: "rejected" };
  const target = classifyZenXLink(trimAutolinkResidue(raw));
  if (target.kind === "anchor") return target;
  if (target.kind === "external")
    return target.href.startsWith("mailto:")
      ? target
      : { kind: "browser", value: target.href };
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) && !/^file:/iu.test(raw))
    return { kind: "rejected" };
  if (/^file:/iu.test(raw)) {
    try {
      const url = new URL(raw);
      if (
        url.protocol !== "file:" ||
        (url.hostname && url.hostname !== "localhost") ||
        url.search ||
        url.hash
      )
        return { kind: "rejected" };
      const value = decodeURIComponent(url.pathname);
      return /[\u0000-\u001f\u007f]/u.test(value)
        ? { kind: "rejected" }
        : { kind: "file", value };
    } catch {
      return { kind: "rejected" };
    }
  }
  try {
    const value = decodeURIComponent(raw);
    return /[\u0000-\u001f\u007f]/u.test(value)
      ? { kind: "rejected" }
      : { kind: "file", value };
  } catch {
    return { kind: "rejected" };
  }
}
