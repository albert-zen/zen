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
