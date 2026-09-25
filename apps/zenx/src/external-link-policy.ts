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
  const target = classifyZenXLink(raw);
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
