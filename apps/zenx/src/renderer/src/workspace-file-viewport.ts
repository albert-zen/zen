import type { EditorView } from "@codemirror/view";

/** Window-local reading position; never serialized or used to read a file. */
export class WorkspaceFileViewport {
  #snapshot?: ReturnType<EditorView["scrollSnapshot"]>;
  #text?: string;
  #doc?: EditorView["state"]["doc"];
  #generation = 0;
  #top = 0;
  #left = 0;
  initial(text: string) {
    return text === this.#text ? this.#snapshot : undefined;
  }
  bind(view: EditorView): () => void {
    const unchanged = view.state.doc.toString() === this.#text;
    const generation = ++this.#generation;
    let live = true;
    const save = () => {
      if (!live || generation !== this.#generation) return;
      this.#snapshot = view.scrollSnapshot();
      if (this.#doc !== view.state.doc) {
        this.#doc = view.state.doc;
        this.#text = this.#doc.toString();
      }
      this.#top = view.scrollDOM.scrollTop;
      this.#left = view.scrollDOM.scrollLeft;
    };
    // Changed disk contents cannot reuse a document-relative snapshot. Restore
    // bounded pixel offsets after the new editor has measured its own layout.
    if (!unchanged && this.#text !== undefined) {
      const top = this.#top,
        left = this.#left;
      view.requestMeasure({
        read: () => ({
          top: Math.min(
            top,
            Math.max(
              0,
              view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight,
            ),
          ),
          left: Math.min(
            left,
            Math.max(
              0,
              view.scrollDOM.scrollWidth - view.scrollDOM.clientWidth,
            ),
          ),
        }),
        write: (position) => {
          if (!live || generation !== this.#generation) return;
          view.scrollDOM.scrollTop = position.top;
          view.scrollDOM.scrollLeft = position.left;
        },
      });
    }
    view.scrollDOM.addEventListener("scroll", save);
    return () => {
      save();
      live = false;
      view.scrollDOM.removeEventListener("scroll", save);
    };
  }
}
