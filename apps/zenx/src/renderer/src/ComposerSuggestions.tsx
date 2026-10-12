import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons.js";

const groups = {
  "built-in": "builtIn",
  custom: "yourCommands",
  skill: "skills",
  file: "workspaceFiles",
  thread: "agentThreads",
  more: "moreResults",
  member: "roomMembers",
};
const icons: Record<keyof typeof groups, IconName> = {
  "built-in": "terminal",
  custom: "compose",
  skill: "layers",
  file: "file",
  thread: "thread",
  more: "chevron-down",
  member: "thread",
};
export interface ComposerSuggestionState {
  open: boolean;
  rows: Array<{
    key: string;
    kind: keyof typeof groups;
    name: string;
    description: string;
    detail?: string;
    reference?: { cwd: string };
  }>;
  active: number;
  setActive(index: number): void;
  choose(index: number): void | Promise<void>;
  dismiss(): void;
  loading: boolean;
  busy: boolean;
  note: string;
  error: string;
}

/** Shared selection keys never invoke a send while the candidate menu is open. */
export function handleComposerSuggestionKey(
  event: KeyboardEvent<HTMLTextAreaElement>,
  selector: ComposerSuggestionState,
): boolean {
  if (event.nativeEvent.isComposing || !selector.open) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    selector.dismiss();
    return true;
  }
  if (
    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
    selector.rows.length
  ) {
    event.preventDefault();
    selector.setActive(
      (selector.active +
        (event.key === "ArrowDown" ? 1 : -1) +
        selector.rows.length) %
        selector.rows.length,
    );
    return true;
  }
  if (
    (event.key === "Enter" && !event.shiftKey) ||
    (event.key === "Tab" &&
      (selector.rows.length || selector.loading || selector.busy))
  ) {
    event.preventDefault();
    if (!event.repeat) void selector.choose(selector.active);
    return true;
  }
  return false;
}

/** Viewport-anchored presentation shared by Thread references and Room addressing. */
export function ComposerSuggestions({
  id,
  selector,
  textarea,
  label,
  hint,
}: {
  id: string;
  selector: ComposerSuggestionState;
  textarea: RefObject<HTMLTextAreaElement | null>;
  label: string;
  hint: string;
}) {
  useTranslation("shell");
  const panel = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<CSSProperties>({
    left: 10,
    width: 320,
    maxHeight: 360,
    top: 10,
    bottom: "auto",
  });
  useLayoutEffect(() => {
    const list = panel.current?.querySelector<HTMLElement>(".selector-results");
    const selected = panel.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    if (!list || !selected) return;
    // Scroll only the candidate list, never the transcript or outer viewport.
    const listRect = list.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    if (selectedRect.top < listRect.top)
      list.scrollTop += selectedRect.top - listRect.top;
    else if (selectedRect.bottom > listRect.bottom)
      list.scrollTop += selectedRect.bottom - listRect.bottom;
  }, [selector.active, selector.rows[selector.active]?.key]);
  useLayoutEffect(() => {
    if (!selector.open) return;
    const ownerDocument = textarea.current?.ownerDocument ?? document;
    const dismissOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (
        !target ||
        panel.current?.contains(target) ||
        target === textarea.current
      )
        return;
      selector.dismiss();
    };
    ownerDocument.addEventListener("pointerdown", dismissOutside);
    ownerDocument.addEventListener("focusin", dismissOutside);
    return () => {
      ownerDocument.removeEventListener("pointerdown", dismissOutside);
      ownerDocument.removeEventListener("focusin", dismissOutside);
    };
  }, [selector.open, selector.dismiss, textarea]);
  useLayoutEffect(() => {
    if (!selector.open) return;
    const anchor = textarea.current?.closest(".composer") ?? textarea.current;
    if (!anchor) return;
    const reposition = () => {
      const rect = anchor.getBoundingClientRect();
      const above = Math.max(0, rect.top - 18);
      const below = Math.max(0, window.innerHeight - rect.bottom - 18);
      const placeAbove = above >= 160 || above >= below;
      const width = Math.max(
        0,
        Math.min(rect.width - 16, window.innerWidth - 20),
      );
      setLayout({
        left: Math.max(
          10,
          Math.min(rect.left + 8, window.innerWidth - width - 10),
        ),
        width,
        maxHeight: Math.max(0, Math.min(360, placeAbove ? above : below)),
        top: placeAbove ? "auto" : rect.bottom + 8,
        bottom: placeAbove ? window.innerHeight - rect.top + 8 : "auto",
      });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(reposition);
    observer?.observe(anchor);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      observer?.disconnect();
    };
  }, [selector.open, textarea]);
  if (!selector.open) return null;
  return createPortal(
    <div
      className="workflow-command-menu composer-suggestion-menu"
      ref={panel}
      style={{
        position: "fixed",
        right: "auto",
        ...layout,
        zIndex: "var(--z-popover, 1000)",
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {selector.loading || selector.busy ? (
        <div className="selector-heading" role="status">
          {selector.busy ? i18n.t("shell:checking") : i18n.t("shell:searching")}
        </div>
      ) : null}
      <div
        className="selector-results"
        role="listbox"
        aria-label={label}
        id={id}
        aria-busy={selector.loading || selector.busy}
      >
        {selector.rows.map((row, index) => (
          <div role="presentation" key={row.key}>
            {index === 0 || selector.rows[index - 1]?.kind !== row.kind ? (
              <div className="selector-group" role="presentation">
                {i18n.t(`shell:${groups[row.kind]}`)}
                {row.kind === "file" && row.reference ? (
                  <span title={row.reference.cwd}>{row.reference.cwd}</span>
                ) : null}
              </div>
            ) : null}
            <button
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === selector.active}
              tabIndex={-1}
              type="button"
              className={`selector-option${index === selector.active ? " is-active" : ""}`}
              onMouseMove={() => selector.setActive(index)}
              onClick={() => void selector.choose(index)}
            >
              <span className="selector-icon">
                <Icon name={icons[row.kind]} />
              </span>
              <span className="selector-copy">
                <span className="selector-summary">
                  <strong title={row.name}>{row.name}</strong>
                  {row.detail ? (
                    <small title={row.detail}>{row.detail}</small>
                  ) : null}
                </span>
                <span className="selector-description" title={row.description}>
                  {row.description}
                </span>
              </span>
              {index === selector.active ? (
                <span className="selector-enter" aria-hidden="true">
                  ↵
                </span>
              ) : null}
            </button>
          </div>
        ))}
        {!selector.loading && !selector.rows.length ? (
          <p className="selector-status" role="status">
            {i18n.t("shell:noMatchesTryAnother")}
          </p>
        ) : null}
      </div>
      {selector.error ? (
        <p className="selector-status selector-error" role="alert">
          {selector.error}
        </p>
      ) : null}
      {selector.note ? (
        <p className="selector-status">{selector.note}</p>
      ) : null}
      <footer id={`${id}-hint`}>
        <span className="sr-only">{hint}</span>
        <span>
          <kbd>↑↓</kbd> <kbd>Enter</kbd> <kbd>Tab</kbd>{" "}
          {i18n.t("shell:selectShortcut")}
          <kbd>Esc</kbd> {i18n.t("shell:closeShortcut")}
        </span>
      </footer>
    </div>,
    document.body,
  );
}
