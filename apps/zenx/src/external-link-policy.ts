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
// Keep destinations intact: only the Markdown parser knows bare-link provenance.
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
  if (
    /^[a-z][a-z0-9+.-]*:/iu.test(raw) &&
    !/^file:/iu.test(raw) &&
    !/^[a-z]:(?:[\\/]|%5c|%2f)/iu.test(raw)
  )
    return { kind: "rejected" };
  if (/^file:/iu.test(raw)) {
    try {
      const url = new URL(raw);
      if (
        url.protocol !== "file:" ||
        (url.hostname && url.hostname !== "localhost") ||
        url.search ||
        (url.hash && !/^#L[1-9]\d*(?:C[1-9]\d*)?$/u.test(url.hash))
      )
        return { kind: "rejected" };
      const decoded = decodeURIComponent(url.pathname);
      const value = /^\/[a-z]:\//iu.test(decoded) ? decoded.slice(1) : decoded;
      return /[\u0000-\u001f\u007f]/u.test(value)
        ? { kind: "rejected" }
        : { kind: "file", value };
    } catch {
      return { kind: "rejected" };
    }
  }
  try {
    const value = decodeURIComponent(messageFileLocation(raw).path);
    return /[\u0000-\u001f\u007f]/u.test(value)
      ? { kind: "rejected" }
      : { kind: "file", value };
  } catch {
    return { kind: "rejected" };
  }
}

// Conventional locations on an explicit path are metadata, not part of the
// filename. The current sidebar opens the file; it does not promise line scroll.
export function messageFileLocation(value: string): {
  path: string;
  line?: number;
  column?: number;
} {
  const match =
    /^(.+\.[a-z0-9]{1,16})(?:#L([1-9]\d*)(?:C([1-9]\d*))?|:([1-9]\d*)(?::([1-9]\d*))?)$/iu.exec(
      value,
    );
  if (!match || !/(?:[\\/]|%2f|%5c)/iu.test(match[1]!)) return { path: value };
  const line = Number(match[2] ?? match[4]);
  const column = match[3] ?? match[5];
  if (
    !Number.isSafeInteger(line) ||
    (column && !Number.isSafeInteger(Number(column)))
  )
    return { path: value };
  return {
    path: match[1]!,
    line,
    ...(column ? { column: Number(column) } : {}),
  };
}
