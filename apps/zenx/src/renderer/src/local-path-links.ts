import { messageFileLocation } from "../../external-link-policy.js";
import type { Parent, PhrasingContent, Root, RootContent } from "mdast";

// A rendering-only projection. Never reads the filesystem or grants access;
// activation still goes through the current Host's workspace file reader.
export function isLocalPath(value: string): boolean {
  if (value.length > 4096) return false;
  value = messageFileLocation(value).path;
  if (!value || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)) return false;
  if (/^(?:\\\\|\/\/)/u.test(value)) return false;
  if (/^[a-z]:[\\/]/iu.test(value)) return true;
  if (/^file:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      return (
        (!url.hostname || url.hostname === "localhost") &&
        !url.search &&
        (!url.hash || /^#L[1-9]\d*(?:C[1-9]\d*)?$/u.test(url.hash))
      );
    } catch {
      return false;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return false;
  if (/^(?:\/|\.\.?\/)/u.test(value))
    return value.length > 1 && !value.endsWith("/");
  // Bare relative names must include a directory and a file extension. A
  // standalone filename/prose token is intentionally not guessed to be a path.
  return /^[^\s<>:"|?*]+[\/\\][^<>:"|?*]+\.[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(
    value,
  );
}

function pathLink(value: string, code: boolean): PhrasingContent {
  return {
    type: "link",
    url: /^file:\/\//iu.test(value)
      ? new URL(value).toString()
      : encodeURI(value),
    children: [{ type: code ? "inlineCode" : "text", value }],
  };
}

export function remarkLocalPaths(options?: { markers?: string[] }) {
  const safePath = (value: string) =>
    isLocalPath(value) &&
    !options?.markers?.some((marker) => value.includes(marker));
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      parent.children = parent.children.flatMap<RootContent>((node) => {
        if (
          node.type === "link" ||
          node.type === "linkReference" ||
          node.type === "image" ||
          node.type === "imageReference"
        )
          return [node];
        if (node.type === "inlineCode")
          return safePath(node.value) ? [pathLink(node.value, true)] : [node];
        if (node.type !== "text") {
          if ("children" in node) visit(node as Parent);
          return [node];
        }
        const parts: PhrasingContent[] = [];
        // Spaces are supported when the entire path is delimited by quotes or
        // inline code. Unquoted prose stops at whitespace rather than guessing.
        const candidates =
          /"([^"\n]+)"|'([^'\n]+)'|(?<![\p{L}\p{N}_:/\\])(?:[a-z]:[\\/]|file:\/\/|\.\.?\/|\/|[\p{L}\p{N}_.-]+[\/\\])[^\s<>"'`，。；：！？（）【】「」]+/giu;
        let end = 0;
        let ambiguousEnd: number | undefined;
        for (const match of node.value.matchAll(candidates)) {
          const quoted = match[1] ?? match[2];
          const candidate =
            quoted ?? match[0].replace(/[.,;:!?，。；：！？）)\]}]+$/u, "");
          if (candidate.length > 4096) continue;
          if (quoted === undefined && !/^file:/iu.test(candidate)) {
            const path = messageFileLocation(candidate).path;
            const fileLike =
              /[\\/][^\\/]+\.[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(path);
            const continuation =
              ambiguousEnd !== undefined &&
              /^\s+$/u.test(node.value.slice(ambiguousEnd, match.index));
            if (!fileLike || continuation) {
              ambiguousEnd = match.index + match[0].length;
              continue;
            }
          }
          ambiguousEnd = undefined;
          if (!safePath(candidate)) continue;
          const start = match.index + (quoted === undefined ? 0 : 1);
          parts.push(
            { type: "text", value: node.value.slice(end, start) },
            pathLink(candidate, false),
          );
          end = start + candidate.length;
        }
        if (!parts.length) return [node];
        parts.push({ type: "text", value: node.value.slice(end) });
        return parts;
      }) as typeof parent.children;
    };
    visit(tree);
  };
}
