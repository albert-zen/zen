import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState, type SelectionRange } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { useEffect, useRef } from "react";
import { classifyZenXLink } from "../../external-link-policy.js";

const touches = (
  selection: readonly SelectionRange[],
  from: number,
  to: number,
) => selection.some((range) => range.from <= to && range.to >= from);

const documentText = (state: EditorState) =>
  state.sliceDoc(0, state.doc.length);

function livePreviewDecorations(
  state: EditorState,
  editorFocused: boolean,
): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  const selection = state.selection.ranges;
  const hide = (from: number, to: number) => {
    if (to > from) ranges.push(Decoration.replace({}).range(from, to));
  };
  syntaxTree(state).iterate({
    enter(node) {
      const active = editorFocused && touches(selection, node.from, node.to);
      const children = (name: string) => node.node.getChildren(name);
      if (/^ATXHeading[1-6]$/u.test(node.name)) {
        const level = node.name.at(-1)!;
        ranges.push(
          Decoration.line({
            class: `cm-live-heading cm-live-heading-${level}`,
          }).range(node.from),
        );
        if (!active) {
          const marks = children("HeaderMark");
          for (const [index, mark] of marks.entries()) {
            let from = mark.from;
            let to = mark.to;
            if (index === 0)
              while (/\s/u.test(state.sliceDoc(to, to + 1)) && to < node.to)
                to += 1;
            if (index === marks.length - 1 && index > 0)
              while (
                /\s/u.test(state.sliceDoc(from - 1, from)) &&
                from > node.from
              )
                from -= 1;
            hide(from, to);
          }
        }
      } else if (node.name === "StrongEmphasis") {
        ranges.push(
          Decoration.mark({ class: "cm-live-strong" }).range(
            node.from,
            node.to,
          ),
        );
        if (!active)
          for (const mark of children("EmphasisMark")) hide(mark.from, mark.to);
      } else if (node.name === "Emphasis") {
        ranges.push(
          Decoration.mark({ class: "cm-live-emphasis" }).range(
            node.from,
            node.to,
          ),
        );
        if (!active)
          for (const mark of children("EmphasisMark")) hide(mark.from, mark.to);
      } else if (node.name === "Link") {
        ranges.push(
          Decoration.mark({ class: "cm-live-link" }).range(node.from, node.to),
        );
        if (!active) {
          for (const mark of children("LinkMark")) hide(mark.from, mark.to);
          for (const label of children("LinkLabel")) hide(label.from, label.to);
          for (const url of children("URL")) hide(url.from, url.to);
        }
      } else if (node.name === "LinkReference") {
        if (!active) hide(node.from, node.to);
      } else if (node.name === "InlineCode") {
        ranges.push(
          Decoration.mark({ class: "cm-live-inline-code" }).range(
            node.from,
            node.to,
          ),
        );
        if (!active)
          for (const mark of children("CodeMark")) hide(mark.from, mark.to);
      } else if (node.name === "FencedCode") {
        ranges.push(
          Decoration.mark({ class: "cm-live-code-block" }).range(
            node.from,
            node.to,
          ),
        );
        if (!active) {
          for (const mark of children("CodeMark")) hide(mark.from, mark.to);
          for (const info of children("CodeInfo")) hide(info.from, info.to);
        }
      }
    },
  });
  return Decoration.set(ranges, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = livePreviewDecorations(view.state, view.hasFocus);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged)
        this.decorations = livePreviewDecorations(
          update.state,
          update.view.hasFocus,
        );
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function InlineMarkdownEditor({
  path,
  text,
  onChange,
}: {
  path: string;
  text: string;
  onChange(text: string): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  const applyingExternal = useRef(false);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.lineSeparator.of(text.includes("\r\n") ? "\r\n" : "\n"),
          markdown({ extensions: [GFM] }),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": `Edit ${path}`,
            spellcheck: "false",
          }),
          livePreview,
          EditorView.domEventHandlers({
            mousedown(event, view) {
              if (!event.metaKey && !event.ctrlKey) return false;
              const position = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
              });
              if (position === null) return false;
              let node = syntaxTree(view.state).resolveInner(position, -1);
              while (node && node.name !== "Link") node = node.parent!;
              const url = node?.getChild("URL");
              if (url === null || url === undefined) return false;
              const target = classifyZenXLink(
                view.state.sliceDoc(url.from, url.to),
              );
              event.preventDefault();
              if (target.kind === "external")
                window.open(target.href, "_blank", "noopener,noreferrer");
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingExternal.current)
              onChangeRef.current(documentText(update.state));
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = undefined;
      view.destroy();
    };
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === undefined || documentText(view.state) === text) return;
    applyingExternal.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
    applyingExternal.current = false;
  }, [text]);

  return <div className="markdown-live-editor" ref={hostRef} />;
}
