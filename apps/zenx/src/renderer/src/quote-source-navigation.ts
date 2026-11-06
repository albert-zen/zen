import type { Turn } from "../../protocol-client/index.js";
import type { TurnCanonicalPresentationIndex } from "./turn-canonical-presentation.js";
import { projectTurn } from "./turn-projection.js";
import { disclosureKey } from "./thread-reading-state.js";

export interface QuoteSourceIdentity {
  threadId: string;
  id: string;
}
export function findMessageQuoteSource(
  viewport: Element | null,
  quote: QuoteSourceIdentity,
): HTMLElement | null {
  return (
    Array.from(
      viewport?.querySelectorAll<HTMLElement>(
        "[data-quote-thread-id][data-quote-item-id]",
      ) ?? [],
    ).find((element) => {
      if (element.dataset.quoteThreadId !== quote.threadId) return false;
      if (element.dataset.quoteItemId === quote.id) return true;
      try {
        const ids: unknown = JSON.parse(element.dataset.quoteItemIds ?? "null");
        return Array.isArray(ids) && ids.includes(quote.id);
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** Resolve on explicit navigation, using the full canonical projection, not mounted text. */
export function quoteSourceTarget(
  scope: string,
  turns: readonly Turn[],
  presentation: TurnCanonicalPresentationIndex,
  quote: QuoteSourceIdentity,
) {
  const canonical = presentation.source.quoteItems
    .get(quote.id)
    ?.find((item) => item.id === quote.id && item.threadId === quote.threadId);
  if (!canonical || !("turnId" in canonical) || !canonical.turnId) return null;
  const turn = turns.find((turn) => turn.id === canonical.turnId);
  const metadata = turn && presentation.turns.get(turn.id);
  if (!turn || !metadata) return null;
  const entry = [...metadata.quoteItems].find(([, items]) =>
    items.some(
      (item) => item.id === quote.id && item.threadId === quote.threadId,
    ),
  );
  if (!entry) return null;
  const [renderItemId] = entry;
  const projection = projectTurn(turn);
  const disclosures: string[] = [];
  if (
    projection.finalItem?.id !== renderItemId &&
    !projection.inputItems.some((item) => item.id === renderItemId)
  )
    disclosures.push(disclosureKey("turn", turn.id));
  for (const node of projection.history) {
    if (node.kind !== "traceItem" && node.kind !== "traceGroup") continue;
    const items = node.kind === "traceItem" ? [node.item] : node.items;
    if (items.some((item) => item.id === renderItemId)) {
      disclosures.push(
        disclosureKey("trace", turn.id, node.id),
        disclosureKey("item", turn.id, renderItemId),
      );
      break;
    }
  }
  return {
    rowKey: JSON.stringify([scope, "turn", turn.id]),
    renderItemId,
    disclosures,
  };
}

/** Exact rendered text within an already identity-verified source; never a global text search. */
export function quoteExcerptRange(
  source: HTMLElement,
  excerpt: string,
): Range | null {
  if (!excerpt) return null;
  const walker = source.ownerDocument.createTreeWalker(source, 4);
  const nodes: Text[] = [];
  let text = "";
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (
      node.parentElement?.closest(
        "button, [data-message-quote-ignore], [hidden], [aria-hidden='true']",
      )
    )
      continue;
    nodes.push(node as Text);
    text += node.textContent ?? "";
  }
  let start = text.indexOf(excerpt);
  let end = start + excerpt.length;
  if (start < 0) {
    // Browser selection inserts layout whitespace at block boundaries while text nodes do not.
    // Reconcile only whitespace, inside this already identity-verified source.
    const offsets: number[] = [];
    let folded = "";
    for (let index = 0; index < text.length; index++) {
      if (/\s/u.test(text[index]!)) continue;
      offsets.push(index);
      folded += text[index];
    }
    const needle = excerpt.replace(/\s/gu, "");
    const match = needle ? folded.indexOf(needle) : -1;
    if (match < 0) return null;
    start = offsets[match]!;
    end = offsets[match + needle.length - 1]! + 1;
  }
  const range = source.ownerDocument.createRange();
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const next = offset + node.length;
    if (!started && start < next) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= next) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset = next;
  }
  return null;
}
const quoteHighlights = new WeakMap<Document, () => void>();

/** A temporary paint-only highlight keeps React DOM, selection and canonical text unchanged. */
export function focusMessageQuoteSource(
  source: HTMLElement,
  excerpt: string,
  highlight = true,
): void {
  const range = quoteExcerptRange(source, excerpt);
  source.scrollIntoView({ block: "center", behavior: "auto" });
  const rect = range?.getBoundingClientRect?.();
  const viewport = source.closest<HTMLElement>(".messages");
  if (rect && rect.height > 0 && viewport) {
    const bounds = viewport.getBoundingClientRect();
    viewport.scrollTop +=
      rect.top + rect.height / 2 - (bounds.top + viewport.clientHeight / 2);
  }
  source.focus({ preventScroll: true });
  if (!highlight) return;
  const document = source.ownerDocument;
  quoteHighlights.get(document)?.();
  const view = document.defaultView as (Window & typeof globalThis) | null;
  const registry = view?.CSS?.highlights;
  const HighlightConstructor = view?.Highlight;
  if (range && registry && HighlightConstructor)
    registry.set("zenx-quote-source", new HighlightConstructor(range));
  else source.dataset.quoteHighlight = "true";
  const clear = () => {
    clearTimeout(timer);
    registry?.delete("zenx-quote-source");
    delete source.dataset.quoteHighlight;
    document.removeEventListener("pointerdown", clear, true);
    document.removeEventListener("keydown", clear, true);
    if (quoteHighlights.get(document) === clear)
      quoteHighlights.delete(document);
  };
  const timer = setTimeout(clear, 1600);
  document.addEventListener("pointerdown", clear, true);
  document.addEventListener("keydown", clear, true);
  quoteHighlights.set(document, clear);
}
