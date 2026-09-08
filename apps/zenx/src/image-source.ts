export type ImageSource =
  | { kind: "url"; value: string }
  | { kind: "local"; value: string }
  | { kind: "rejected" };
export function classifyImageSource(source: string): ImageSource {
  if (
    !source ||
    /[\u0000-\u001f]/u.test(source) ||
    source.startsWith("//") ||
    source.startsWith("\\\\")
  )
    return { kind: "rejected" };
  if (
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/iu.test(
      source,
    )
  ) {
    return source.length <= 28_000_000
      ? { kind: "url", value: source }
      : { kind: "rejected" };
  }
  if (/^https?:/iu.test(source)) {
    try {
      const url = new URL(source);
      return url.username || url.password
        ? { kind: "rejected" }
        : { kind: "url", value: url.href };
    } catch {
      return { kind: "rejected" };
    }
  }
  if (
    /^file:/iu.test(source) ||
    /^[A-Za-z]:[\\/]/u.test(source) ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)
  ) {
    return source.startsWith("#")
      ? { kind: "rejected" }
      : { kind: "local", value: source };
  }
  return { kind: "rejected" };
}
