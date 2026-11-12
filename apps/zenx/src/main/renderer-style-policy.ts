/** Only the trusted packaged renderer template receives a per-document style nonce. */
export function rendererHtmlWithStyleNonce(
  html: string,
  nonce: string,
): string {
  if (!/^[A-Za-z0-9+/]{32}$/u.test(nonce))
    throw new Error("Invalid renderer style nonce");
  if (/name\s*=\s*["']zenx-style-nonce["']/iu.test(html))
    throw new Error("Renderer template already contains a style nonce");
  const metas = [...html.matchAll(/<meta\b[^>]*>/giu)].filter((match) =>
    /http-equiv\s*=\s*"Content-Security-Policy"/iu.test(match[0]),
  );
  if (metas.length !== 1) throw new Error("Expected one renderer CSP meta");
  const meta = metas[0]!;
  const content = /\bcontent\s*=\s*"([^"]*)"/iu.exec(meta[0]);
  if (!content) throw new Error("Expected quoted renderer CSP content");
  const directives = content[1]!.split(";");
  const indexes = directives.flatMap((value, index) =>
    /^\s*style-src(?:\s|$)/iu.test(value) ? [index] : [],
  );
  if (
    indexes.length !== 1 ||
    directives[indexes[0]!]!.trim() !== "style-src 'self'"
  )
    throw new Error("Unexpected renderer style policy");
  if (
    directives.some((value) =>
      /^\s*style-src-(?:elem|attr)(?:\s|$)/iu.test(value),
    )
  )
    throw new Error("Unexpected renderer style sub-policy");
  const index = indexes[0]!;
  directives[index] = directives[index]!.replace(
    "style-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
  );
  const start = content.index + content[0].indexOf('"') + 1;
  const replaced =
    meta[0].slice(0, start) +
    directives.join(";") +
    meta[0].slice(start + content[1]!.length);
  return (
    html.slice(0, meta.index) +
    replaced +
    `<meta name="zenx-style-nonce" content="${nonce}">` +
    html.slice(meta.index! + meta[0].length)
  );
}

export function isExactRendererEntry(
  requestUrl: string,
  entryUrl: string,
): boolean {
  // No decoding or path normalization of untrusted input: encoded aliases,
  // query strings, adjacent files, hosts and external URLs cannot transform.
  return requestUrl === entryUrl;
}
