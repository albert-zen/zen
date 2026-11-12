import { EditorSelection, Prec } from "@codemirror/state";
import {
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  search,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { i18n } from "./i18n.js";

function searchShortcut(event: KeyboardEvent, view: EditorView): boolean {
  const modified = (event.ctrlKey || event.metaKey) && !event.altKey;
  const open = modified && !event.shiftKey && event.key.toLowerCase() === "f";
  const close = event.key === "Escape" && searchPanelOpen(view.state);
  if (!open && !close) return false;
  // Let IME handle its own commit/cancel without closing the outer workspace.
  if (event.isComposing || event.keyCode === 229 || view.composing) {
    event.stopPropagation();
    return false;
  }
  if (open) openSearchPanel(view);
  else closeSearchPanel(view);
  event.preventDefault();
  event.stopPropagation();
  return true;
}

class FileSearchPanel implements Panel {
  readonly dom = document.createElement("div");
  readonly top = true;
  private readonly input = document.createElement("input");
  private readonly count = document.createElement("span");
  private readonly previous = this.button("previous", "↑", () => this.move(-1));
  private readonly next = this.button("next", "↓", () => this.move(1));
  private readonly close = this.button("close", "×", () => {
    closeSearchPanel(this.view);
    this.view.focus();
  });
  private composing = false;
  // Flat boundaries avoid one object per match in a near-limit file. Matching
  // and visible highlights both use CodeMirror's official literal query.
  private matches: number[] = [];

  constructor(private readonly view: EditorView) {
    this.dom.className = "cm-file-search";
    this.dom.setAttribute("role", "search");
    this.input.className = "cm-file-search-input";
    this.input.type = "text";
    this.input.setAttribute("main-field", "true");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("spellcheck", "false");
    this.input.value = getSearchQuery(view.state).search;
    this.count.className = "cm-file-search-count";
    this.count.setAttribute("role", "status");
    this.count.setAttribute("aria-live", "polite");
    this.count.setAttribute("aria-atomic", "true");
    this.dom.append(
      this.input,
      this.count,
      this.previous,
      this.next,
      this.close,
    );
    this.input.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.input.addEventListener("compositionend", () => {
      this.composing = false;
      this.commit();
    });
    this.input.addEventListener("input", () => {
      if (!this.composing) this.commit();
    });
    this.dom.addEventListener("keydown", (event) => {
      if (this.composing || event.isComposing || event.keyCode === 229) {
        event.stopPropagation();
        return;
      }
      if (searchShortcut(event, view)) return;
      const modified = (event.ctrlKey || event.metaKey) && !event.altKey;
      if (
        (event.key === "Enter" && event.target === this.input) ||
        event.key === "F3" ||
        (modified && event.key.toLowerCase() === "g")
      ) {
        this.move(event.shiftKey ? -1 : 1);
        event.preventDefault();
        event.stopPropagation();
      }
    });
    this.rebuildMatches();
    this.translate();
    i18n.on("languageChanged", this.translate);
  }

  private button(name: string, symbol: string, action: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.name = name;
    button.className = "cm-file-search-button icon-button";
    const icon = document.createElement("span");
    icon.textContent = symbol;
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
    button.addEventListener("click", action);
    return button;
  }

  private readonly translate = () => {
    const find = i18n.t("panels:findInFile");
    this.dom.setAttribute("aria-label", find);
    this.input.setAttribute("aria-label", find);
    this.input.placeholder = find;
    for (const [button, label] of [
      [this.previous, i18n.t("panels:previousMatch")],
      [this.next, i18n.t("panels:nextMatch")],
      [this.close, i18n.t("panels:closeFileSearch")],
    ] as const) {
      button.setAttribute("aria-label", label);
      button.title = label;
    }
    this.updateCount();
  };

  private commit() {
    const query = new SearchQuery({ search: this.input.value, literal: true });
    if (!query.eq(getSearchQuery(this.view.state)))
      this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private rebuildMatches() {
    this.matches = [];
    const query = getSearchQuery(this.view.state);
    if (query.valid) {
      const cursor = query.getCursor(this.view.state);
      for (let result = cursor.next(); !result.done; result = cursor.next())
        this.matches.push(result.value.from, result.value.to);
    }
  }

  // First match starting at or after a position. Navigation and counts use the
  // same non-overlapping results as the highlighter, including repeated text.
  private matchAtOrAfter(position: number) {
    let low = 0,
      high = this.matches.length / 2;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.matches[middle * 2]! < position) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private updateCount() {
    const total = this.matches.length / 2;
    const selection = this.view.state.selection.main;
    const index = this.matchAtOrAfter(selection.from);
    const current =
      this.matches[index * 2] === selection.from &&
      this.matches[index * 2 + 1] === selection.to
        ? index + 1
        : 0;
    this.count.textContent = !getSearchQuery(this.view.state).valid
      ? ""
      : total
        ? i18n.t("panels:fileSearchMatchCount", { current, total })
        : i18n.t("panels:fileSearchNoMatches");
    this.previous.disabled = this.next.disabled = total === 0;
  }

  private move(direction: -1 | 1) {
    const total = this.matches.length / 2;
    if (!total) return;
    const selection = this.view.state.selection.main;
    let index =
      direction === 1
        ? this.matchAtOrAfter(selection.to)
        : this.matchAtOrAfter(selection.from) - 1;
    index = (index + total) % total;
    const range = EditorSelection.range(
      this.matches[index * 2]!,
      this.matches[index * 2 + 1]!,
    );
    this.view.dispatch({
      selection: EditorSelection.create([range]),
      effects: EditorView.scrollIntoView(range, { y: "nearest" }),
      userEvent: "select.search",
    });
  }

  update(update: ViewUpdate) {
    if (getSearchQuery(update.state) !== getSearchQuery(update.startState)) {
      this.input.value = getSearchQuery(update.state).search;
      this.rebuildMatches();
    } else if (update.docChanged) this.rebuildMatches();
    if (update.docChanged || update.selectionSet || update.transactions.length)
      this.updateCount();
  }

  mount() {
    this.input.focus();
    this.input.select();
  }
  destroy() {
    i18n.off("languageChanged", this.translate);
  }
}

/** File-local, read-only Find UI; it never writes a document or draft. */
export const fileContentSearch = [
  search({
    top: true,
    literal: true,
    createPanel: (view) => new FileSearchPanel(view),
  }),
  Prec.highest(EditorView.domEventHandlers({ keydown: searchShortcut })),
];
