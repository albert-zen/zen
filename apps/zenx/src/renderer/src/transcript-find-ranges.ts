import {
  findTextOccurrences,
  normalizeFindText,
  type TranscriptFindMatch,
} from "./transcript-find-index.js";

const BLOCKS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
  "TD",
  "TH",
]);
interface Point {
  node: Text;
  from: number;
  to: number;
}

/** Resolve only real connected product text, never a hidden clone or the browser Selection. */
export function transcriptFindRange(
  viewport: HTMLElement,
  match: TranscriptFindMatch,
  query: string,
): Range | null {
  const needle = normalizeFindText(query);
  if (!needle) return null;
  let occurrence = 0;
  for (const scope of viewport.querySelectorAll<HTMLElement>(
    "[data-thread-find-item-id]",
  )) {
    if (
      scope.dataset.threadFindItemId !== match.entry.itemId ||
      (scope.dataset.threadFindField ?? "body") !== match.entry.field
    )
      continue;
    if (scope.closest("[hidden], [aria-hidden='true'], [inert]")) continue;
    if (scope.closest(".trace-input-preview")?.closest("details[open]"))
      continue;
    let text = "";
    let points: Point[] = [];
    let result: Range | null = null;
    const flush = () => {
      for (const offset of findTextOccurrences(text.trimEnd(), needle)) {
        if (occurrence++ !== match.occurrence) continue;
        const start = points[offset];
        const end = points[offset + needle.length - 1];
        if (!start || !end || !start.node.isConnected || !end.node.isConnected)
          continue;
        result = viewport.ownerDocument.createRange();
        result.setStart(start.node, start.from);
        result.setEnd(end.node, end.to);
        break;
      }
      text = "";
      points = [];
    };
    const visit = (node: Node) => {
      if (result) return;
      if (node.nodeType === 1) {
        const element = node as HTMLElement;
        if (
          element.matches(
            "svg,script,style,[hidden],[aria-hidden='true'],[inert],[data-thread-find-ignore]",
          )
        )
          return;
        if (
          element.matches(
            ".markdown-code-header,.markdown-image,.image-placeholder,[role='toolbar']",
          ) ||
          (element.tagName === "BUTTON" &&
            !element.matches(".reference-token-details"))
        ) {
          flush();
          return;
        }
        if (
          element !== scope &&
          element.hasAttribute("data-thread-find-item-id")
        )
          return;
        if (
          element.parentElement?.closest("details:not([open])") &&
          !element.closest("summary")
        )
          return;
        const block = BLOCKS.has(element.tagName);
        if (block) flush();
        if (element.tagName === "BR" && text && !text.endsWith(" ")) {
          text += " ";
          points.push(points.at(-1)!);
        }
        for (const child of element.childNodes) visit(child);
        if (block && !result) flush();
      } else if (node.nodeType === 3) {
        const value = node.nodeValue ?? "";
        for (let index = 0; index < value.length; index++) {
          const char = value[index]!;
          const point = { node: node as Text, from: index, to: index + 1 };
          if (/\s/u.test(char)) {
            if (text && !text.endsWith(" ")) {
              text += " ";
              points.push(point);
            }
          } else {
            text += char;
            points.push(point);
          }
        }
      }
    };
    visit(scope);
    if (!result) flush();
    if (result) return result;
  }
  return null;
}

type HighlightWindow = Window & {
  CSS?: typeof CSS;
  Highlight?: new (...ranges: Range[]) => Highlight;
};
const owners = new WeakMap<Document, Map<object, Range>>();
/** CSS Highlights do not mutate live message nodes or take over a user's Selection. */
export function paintTranscriptFindRange(
  document: Document,
  owner: object,
  range: Range | null,
): boolean {
  const window = document.defaultView as HighlightWindow | null;
  const registry = window?.CSS?.highlights;
  const Highlight = window?.Highlight;
  if (!registry || !Highlight) return false;
  let ranges = owners.get(document);
  if (!ranges) owners.set(document, (ranges = new Map()));
  if (range) ranges.set(owner, range);
  else ranges.delete(owner);
  for (const [key, value] of ranges)
    if (!value.startContainer.isConnected || !value.endContainer.isConnected)
      ranges.delete(key);
  if (ranges.size)
    registry.set("zenx-thread-find-active", new Highlight(...ranges.values()));
  else registry.delete("zenx-thread-find-active");
  return true;
}
