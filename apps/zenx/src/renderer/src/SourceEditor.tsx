import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import {
  documentText,
  normalizedSource,
  preserveRawSource,
  rawSource,
  setRawSource,
} from "./editor-raw-source.js";

const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
    color: "var(--color-text-accent)",
  },
  {
    tag: [tags.string, tags.regexp, tags.attributeValue],
    color: "var(--color-status-success)",
  },
  {
    tag: [tags.number, tags.bool, tags.null],
    color: "var(--color-status-warning)",
  },
  {
    tag: [tags.comment, tags.meta],
    color: "var(--color-text-secondary)",
    fontStyle: "italic",
  },
  {
    tag: [tags.typeName, tags.className, tags.tagName, tags.attributeName],
    color: "var(--color-text-accent)",
  },
]);

function sourceLanguage(path: string) {
  if (/\.[cm]?[jt]sx?$/i.test(path))
    return javascript({
      typescript: /\.[cm]?tsx?$/i.test(path),
      jsx: /\.[jt]sx$/i.test(path),
    });
  if (/\.jsonc?$/i.test(path)) return javascript();
  if (/\.css$/i.test(path)) return css();
  if (/\.(?:html?|svg)$/i.test(path)) return html();
  return [];
}

/** A bounded, highlighted text surface. Saving and conflict ownership stay with file drafts. */
export function SourceEditor({
  path,
  text,
  onChange,
  readOnly = false,
}: {
  path: string;
  text: string;
  onChange?(text: string): void;
  readOnly?: boolean;
}) {
  useTranslation("panels");
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const changed = useRef(onChange);
  const applyingExternal = useRef(false);
  const languageScope = useRef(new Compartment());
  const historyScope = useRef(new Compartment());
  changed.current = onChange;
  const label = i18n.t(readOnly ? "panels:sourceOfFile" : "panels:editFile", {
    path,
  });
  const large = text.length > 100_000;
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: normalizedSource(text),
        extensions: [
          rawSource.init(() => text),
          preserveRawSource,
          languageScope.current.of(large ? [] : sourceLanguage(path)),
          syntaxHighlighting(highlight),
          lineNumbers(),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          historyScope.current.of(readOnly ? [] : history()),
          readOnly
            ? []
            : [
                highlightActiveLine(),
                keymap.of([...defaultKeymap, ...historyKeymap]),
              ],
          EditorView.contentAttributes.of({
            "aria-label": label,
            spellcheck: "false",
            "aria-readonly": String(readOnly),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingExternal.current && !readOnly)
              changed.current?.(documentText(update.state));
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = undefined;
      view.destroy();
    };
  }, [path, readOnly]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageScope.current.reconfigure(
        large ? [] : sourceLanguage(path),
      ),
    });
  }, [path, large]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.contentDOM.setAttribute("aria-label", label);
    if (documentText(view.state) === text) return;
    applyingExternal.current = true;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: normalizedSource(text),
      },
      effects: [setRawSource.of(text), historyScope.current.reconfigure([])],
      annotations: Transaction.addToHistory.of(false),
    });
    if (!readOnly)
      view.dispatch({ effects: historyScope.current.reconfigure(history()) });
    applyingExternal.current = false;
  }, [text, label, readOnly]);
  return (
    <div className="file-source-editor" data-readonly={readOnly}>
      {large ? (
        <p className="workspace-file-note">
          {i18n.t("panels:largeFileHighlightingDisabled")}
        </p>
      ) : null}
      <div ref={host} />
    </div>
  );
}
