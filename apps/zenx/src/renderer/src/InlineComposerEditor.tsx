import { editorStyleNonce } from "./editor-style-nonce.js";
import {
  defaultKeymap,
  history,
  historyKeymap,
  invertedEffects,
} from "@codemirror/commands";
import {
  Compartment,
  EditorState,
  MapMode,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type ChangeSet,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  placeholder as editorPlaceholder,
  WidgetType,
} from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import {
  useContext,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type RefObject,
} from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import type { ComposerEditorHandle, ComposerInput } from "./composer-input.js";
import { referenceText, type Reference } from "./composer-selector.js";
import { MessageLinkContext } from "./Markdown.js";
import {
  MessageSourceNavigationContext,
  MessageSourceViewportContext,
} from "./message-source-navigation.js";
import { ReferenceToken } from "./ReferenceToken.js";

/** The document contains one UTF-16 U+FFFC code unit for each inline chip. */
export type PositionedReference = Reference & { position: number };

type Entry = { key: number; position: number; reference: Reference };
const setReferences = StateEffect.define<readonly Entry[]>();
const referencesField = StateField.define<readonly Entry[]>({
  create: () => [],
  update(entries, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setReferences)) entries = effect.value;
    return entries;
  },
});

function isPositioned(reference: Reference): reference is PositionedReference {
  return typeof (reference as { position?: unknown }).position === "number";
}

function stripPosition(reference: PositionedReference): Reference {
  const { position: _position, ...content } = reference;
  return content as Reference;
}

function identity(reference: Reference): string {
  return JSON.stringify(reference);
}

function mapEntries(
  entries: readonly Entry[],
  changes: ChangeSet,
  doc: string,
): Entry[] {
  const mapped: Entry[] = [];
  for (const entry of entries) {
    let removed = false;
    changes.iterChanges((from, to) => {
      if (from <= entry.position && entry.position < to) removed = true;
    });
    if (removed) continue;
    const position = changes.mapPos(entry.position, 1, MapMode.TrackDel);
    if (position !== null && doc[position] === "\uFFFC")
      mapped.push({ ...entry, position });
  }
  return mapped;
}

function initialEntries(
  value: string,
  references: readonly Reference[],
  nextKey: () => number,
): Entry[] {
  const seen = new Set<number>();
  return references
    .flatMap((reference) => {
      if (
        !isPositioned(reference) ||
        !Number.isInteger(reference.position) ||
        value[reference.position] !== "\uFFFC"
      )
        return [];
      if (seen.has(reference.position)) return [];
      seen.add(reference.position);
      return [
        {
          key: nextKey(),
          position: reference.position,
          reference: stripPosition(reference),
        },
      ];
    })
    .sort((left, right) => left.position - right.position);
}

function reconcileEntries(
  value: string,
  references: readonly Reference[],
  existing: readonly Entry[],
  nextKey: () => number,
): Entry[] {
  const used = new Set<number>();
  const seen = new Set<number>();
  return references
    .flatMap((reference) => {
      if (
        !isPositioned(reference) ||
        !Number.isInteger(reference.position) ||
        value[reference.position] !== "\uFFFC"
      )
        return [];
      if (seen.has(reference.position)) return [];
      seen.add(reference.position);
      const content = stripPosition(reference);
      const match = existing.find(
        (entry) =>
          !used.has(entry.key) &&
          entry.position === reference.position &&
          identity(entry.reference) === identity(content),
      );
      if (match) used.add(match.key);
      return [
        {
          key: match?.key ?? nextKey(),
          position: reference.position,
          reference: content,
        },
      ];
    })
    .sort((left, right) => left.position - right.position);
}

function sameEntries(left: readonly Entry[], right: readonly Entry[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.position === right[index]?.position &&
        identity(entry.reference) === identity(right[index]!.reference),
    )
  );
}

/** Preserve all ordinary code units; expand only tokens with genuine metadata. */
export function readableReferenceSelection(
  state: EditorState,
  from: number,
  to: number,
): string {
  const entries = state.field(referencesField);
  let cursor = from;
  let output = "";
  for (const entry of entries) {
    if (entry.position < from || entry.position >= to) continue;
    output +=
      state.sliceDoc(cursor, entry.position) + referenceText(entry.reference);
    cursor = entry.position + 1;
  }
  return output + state.sliceDoc(cursor, to);
}

function clipboardText(state: EditorState): string {
  if (state.selection.ranges.some((range) => !range.empty))
    return state.selection.ranges
      .filter((range) => !range.empty)
      .map((range) => readableReferenceSelection(state, range.from, range.to))
      .join(state.lineBreak);
  const seen = new Set<number>();
  return state.selection.ranges
    .flatMap(({ from }) => {
      const line = state.doc.lineAt(from);
      if (seen.has(line.number)) return [];
      seen.add(line.number);
      return [readableReferenceSelection(state, line.from, line.to)];
    })
    .join(state.lineBreak);
}

function changedRange(previous: string, next: string) {
  let from = 0;
  while (
    from < previous.length &&
    from < next.length &&
    previous[from] === next[from]
  )
    from++;
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (
    oldEnd > from &&
    newEnd > from &&
    previous[oldEnd - 1] === next[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return { from, to: oldEnd, insert: next.slice(from, newEnd) };
}

type CurrentProps = {
  onChange(text: string, references: PositionedReference[]): void;
  onSelectionChange?(handle: ComposerEditorHandle): void;
  onKeyDown?(event: KeyboardEvent): void;
  onPaste?(event: ClipboardEvent): void;
  onBlur?(): void;
  onReferenceSource?(reference: Reference): boolean;
  disabled?: boolean;
  readOnly?: boolean;
};

type WidgetContext = {
  link: React.ContextType<typeof MessageLinkContext>;
  navigate: React.ContextType<typeof MessageSourceNavigationContext>;
  viewport: React.ContextType<typeof MessageSourceViewportContext>;
  i18n: ReturnType<typeof useTranslation>["i18n"];
};

class ReferenceWidget extends WidgetType {
  private root: Root | null = null;
  constructor(
    readonly entry: Entry,
    private readonly getContext: () => WidgetContext,
    private readonly current: () => CurrentProps,
    private readonly registry: Set<ReferenceWidget>,
  ) {
    super();
  }
  eq(other: ReferenceWidget) {
    return (
      this.entry.key === other.entry.key &&
      identity(this.entry.reference) === identity(other.entry.reference)
    );
  }
  toDOM(view: EditorView) {
    const host = document.createElement("span");
    host.className = "inline-composer-reference";
    host.contentEditable = "false";
    host.setAttribute("data-reference-key", String(this.entry.key));
    this.root = createRoot(host);
    this.registry.add(this);
    this.render(view);
    return host;
  }
  render(view: EditorView) {
    if (!this.root) return;
    const context = this.getContext();
    const remove = () => {
      if (this.current().disabled || this.current().readOnly) return;
      const entry = view.state
        .field(referencesField)
        .find((candidate) => candidate.key === this.entry.key);
      if (!entry) return;
      view.dispatch({
        changes: { from: entry.position, to: entry.position + 1 },
        userEvent: "delete.reference",
      });
      view.focus();
    };
    this.root.render(
      <I18nextProvider i18n={context.i18n}>
        <MessageLinkContext.Provider value={context.link}>
          <MessageSourceNavigationContext.Provider value={context.navigate}>
            <MessageSourceViewportContext.Provider value={context.viewport}>
              <ReferenceToken
                reference={this.entry.reference}
                onRemove={remove}
                removeDisabled={Boolean(
                  this.current().disabled || this.current().readOnly,
                )}
                onSource={() =>
                  this.current().onReferenceSource?.(this.entry.reference) ??
                  false
                }
              />
            </MessageSourceViewportContext.Provider>
          </MessageSourceNavigationContext.Provider>
        </MessageLinkContext.Provider>
      </I18nextProvider>,
    );
  }
  ignoreEvent() {
    return true;
  }
  destroy() {
    const root = this.root;
    this.root = null;
    this.registry.delete(this);
    // CodeMirror may replace a widget during a React commit. Unmount afterward.
    if (root) queueMicrotask(() => root.unmount());
  }
}

export interface InlineComposerEditorProps {
  value: string;
  references: readonly Reference[];
  onChange(text: string, references: PositionedReference[]): void;
  onSelectionChange?(handle: ComposerEditorHandle): void;
  editorRef: RefObject<ComposerInput | null>;
  onKeyDown?(event: KeyboardEvent): void;
  onPaste?(event: ClipboardEvent): void;
  onBlur?(): void;
  onReferenceSource?(reference: Reference): boolean;
  /** Seed native history when switching from a plain textarea on first chip insertion. */
  initialUndo?: {
    value: string;
    references: readonly Reference[];
    selection?: { anchor: number; head: number };
  };
  initialSelection?: { anchor: number; head: number };
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-controls"?: string;
  "aria-activedescendant"?: string;
  maxRows?: number;
}

/** Genuine CodeMirror input: one editable document, atomic reference widgets, native history. */
export function InlineComposerEditor(props: InlineComposerEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handleRef = useRef<ComposerEditorHandle | null>(null);
  const widgets = useRef(new Set<ReferenceWidget>());
  const nextKeyRef = useRef(0);
  const currentRef = useRef<CurrentProps>(props);
  currentRef.current = props;
  const applyingExternal = useRef(false);
  const pendingInitialSelection = useRef(false);
  const placeholderCompartment = useRef(new Compartment());
  const attributesCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());
  const readonlyCompartment = useRef(new Compartment());
  const link = useContext(MessageLinkContext);
  const navigate = useContext(MessageSourceNavigationContext);
  const viewport = useContext(MessageSourceViewportContext);
  const { i18n } = useTranslation();
  const contextRef = useRef<WidgetContext>({ link, navigate, viewport, i18n });
  contextRef.current = { link, navigate, viewport, i18n };

  const attributes = () => ({
    role: "textbox",
    "aria-multiline": "true",
    "aria-label": props["aria-label"] ?? "Message",
    ...(props.id ? { id: props.id } : {}),
    ...(props["aria-describedby"]
      ? { "aria-describedby": props["aria-describedby"] }
      : {}),
    ...(props["aria-controls"]
      ? { "aria-controls": props["aria-controls"] }
      : {}),
    ...(props["aria-activedescendant"]
      ? { "aria-activedescendant": props["aria-activedescendant"] }
      : {}),
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const nextKey = () => ++nextKeyRef.current;
    let view: EditorView;
    const handle: ComposerEditorHandle = {
      get value() {
        return view.state.doc.toString();
      },
      get selectionStart() {
        return view.state.selection.main.from;
      },
      get selectionEnd() {
        return view.state.selection.main.to;
      },
      get element() {
        return view.dom;
      },
      get isConnected() {
        return view.dom.isConnected;
      },
      focus(options?: FocusOptions) {
        view.contentDOM.focus(options);
      },
      setSelectionRange(start: number, end: number) {
        const limit = view.state.doc.length;
        view.dispatch({
          selection: {
            anchor: Math.max(0, Math.min(limit, start)),
            head: Math.max(0, Math.min(limit, end)),
          },
        });
      },
    };
    const initialValue = props.initialUndo?.value ?? props.value;
    const initialReferences = props.initialUndo?.references ?? props.references;
    const initialSelection =
      props.initialUndo?.selection ?? props.initialSelection;
    pendingInitialSelection.current = props.initialUndo !== undefined;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValue,
        selection: initialSelection
          ? {
              anchor: Math.min(
                initialValue.length,
                Math.max(0, initialSelection.anchor),
              ),
              head: Math.min(
                initialValue.length,
                Math.max(0, initialSelection.head),
              ),
            }
          : undefined,
        extensions: [
          editorStyleNonce(),
          EditorState.lineSeparator.of("\n"),
          referencesField.init(() =>
            initialEntries(initialValue, initialReferences, nextKey),
          ),
          EditorState.transactionExtender.of((transaction) => {
            if (
              !transaction.docChanged ||
              transaction.effects.some((effect) => effect.is(setReferences))
            )
              return null;
            return {
              effects: setReferences.of(
                mapEntries(
                  transaction.startState.field(referencesField),
                  transaction.changes,
                  transaction.newDoc.toString(),
                ),
              ),
            };
          }),
          invertedEffects.of((transaction) =>
            transaction.effects.some((effect) => effect.is(setReferences))
              ? [
                  setReferences.of(
                    transaction.startState.field(referencesField),
                  ),
                ]
              : [],
          ),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          placeholderCompartment.current.of(
            editorPlaceholder(props.placeholder ?? ""),
          ),
          attributesCompartment.current.of(
            EditorView.contentAttributes.of(attributes()),
          ),
          editableCompartment.current.of(
            EditorView.editable.of(!props.disabled),
          ),
          readonlyCompartment.current.of(
            EditorState.readOnly.of(Boolean(props.readOnly || props.disabled)),
          ),
          EditorView.decorations.of((editor) =>
            Decoration.set(
              editor.state.field(referencesField).map((entry) =>
                Decoration.replace({
                  widget: new ReferenceWidget(
                    entry,
                    () => contextRef.current,
                    () => currentRef.current,
                    widgets.current,
                  ),
                  inclusive: false,
                }).range(entry.position, entry.position + 1),
              ),
            ),
          ),
          EditorView.atomicRanges.of((editor) =>
            Decoration.set(
              editor.state
                .field(referencesField)
                .map((entry) =>
                  Decoration.replace({}).range(
                    entry.position,
                    entry.position + 1,
                  ),
                ),
            ),
          ),
          EditorView.clipboardOutputFilter.of((_text, state) =>
            clipboardText(state),
          ),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown(event) {
                currentRef.current.onKeyDown?.(event);
                return event.defaultPrevented;
              },
              paste(event) {
                currentRef.current.onPaste?.(event);
                return event.defaultPrevented;
              },
              blur() {
                currentRef.current.onBlur?.();
                return false;
              },
            }),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingExternal.current) {
              const references = update.state
                .field(referencesField)
                .map((entry) => ({
                  ...entry.reference,
                  position: entry.position,
                })) as PositionedReference[];
              currentRef.current.onChange(
                update.state.doc.toString(),
                references,
              );
            }
            if (update.selectionSet || update.docChanged)
              currentRef.current.onSelectionChange?.(handle);
          }),
        ],
      }),
    });
    viewRef.current = view;
    handleRef.current = handle;
    props.editorRef.current = handle;
    props.onSelectionChange?.(handle);
    return () => {
      if (props.editorRef.current === handle) props.editorRef.current = null;
      handleRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = view.state.doc.toString();
    const change = changedRange(previous, props.value);
    const changed = previous !== props.value;
    const mapped = changed
      ? mapEntries(
          view.state.field(referencesField),
          view.state.changes(change),
          props.value,
        )
      : view.state.field(referencesField);
    const entries = reconcileEntries(
      props.value,
      props.references,
      mapped,
      () => ++nextKeyRef.current,
    );
    const refsChanged = !sameEntries(
      view.state.field(referencesField),
      entries,
    );
    const initialSelection = pendingInitialSelection.current
      ? props.initialSelection
      : undefined;
    pendingInitialSelection.current = false;
    if (!changed && !refsChanged && !initialSelection) return;
    applyingExternal.current = true;
    try {
      view.dispatch({
        ...(changed ? { changes: change } : {}),
        ...(initialSelection
          ? {
              selection: {
                anchor: Math.max(
                  0,
                  Math.min(props.value.length, initialSelection.anchor),
                ),
                head: Math.max(
                  0,
                  Math.min(props.value.length, initialSelection.head),
                ),
              },
            }
          : {}),
        effects: setReferences.of(entries),
        annotations: Transaction.userEvent.of("input.reference.external"),
      });
    } finally {
      applyingExternal.current = false;
    }
  }, [props.value, props.references]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        placeholderCompartment.current.reconfigure(
          editorPlaceholder(props.placeholder ?? ""),
        ),
        attributesCompartment.current.reconfigure(
          EditorView.contentAttributes.of(attributes()),
        ),
        editableCompartment.current.reconfigure(
          EditorView.editable.of(!props.disabled),
        ),
        readonlyCompartment.current.reconfigure(
          EditorState.readOnly.of(Boolean(props.readOnly || props.disabled)),
        ),
      ],
    });
  }, [
    props.placeholder,
    props.id,
    props["aria-label"],
    props["aria-describedby"],
    props["aria-controls"],
    props["aria-activedescendant"],
    props.disabled,
    props.readOnly,
  ]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    for (const widget of widgets.current) widget.render(view);
  }, [props.disabled, props.readOnly, link, navigate, viewport, i18n]);

  const rows = Math.max(1, Math.min(12, props.maxRows ?? 6));
  return (
    <div
      className="inline-composer-editor"
      ref={hostRef}
      style={{ "--inline-composer-max-rows": rows } as CSSProperties}
      aria-disabled={props.disabled || undefined}
    />
  );
}
