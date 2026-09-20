import { useLayoutEffect, useRef } from "react";
import { Icon, type IconName } from "./icons.js";
import type { useComposerSelector } from "./use-composer-selector.js";

const groups = {
  "built-in": "Built in",
  custom: "Your commands",
  skill: "Skills",
  file: "Workspace files",
  thread: "Agent threads",
  more: "More results",
};
const icons: Record<keyof typeof groups, IconName> = {
  "built-in": "terminal",
  custom: "compose",
  skill: "layers",
  file: "file",
  thread: "thread",
  more: "chevron-down",
};

export function WorkflowCommandMenu({
  id,
  selector,
}: {
  id: string;
  selector: ReturnType<typeof useComposerSelector>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    panel.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selector.active, selector.rows[selector.active]?.key]);
  useLayoutEffect(() => {
    if (!selector.open || !panel.current) return;
    const resize = () => {
      const element = panel.current;
      if (!element) return;
      const bottom = element.getBoundingClientRect().bottom;
      element.style.maxHeight = `${Math.max(100, Math.min(360, bottom - 12, window.innerHeight - 24))}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [selector.open]);
  if (!selector.open) return null;
  return (
    <div
      className="workflow-command-menu"
      ref={panel}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="selector-heading">
        <Icon name={selector.referenceMode ? "paperclip" : "terminal"} />
        <strong>
          {selector.referenceMode ? "Add a reference" : "Commands & Skills"}
        </strong>
        {selector.loading || selector.busy ? (
          <span role="status">
            {selector.busy ? "Checking…" : "Searching…"}
          </span>
        ) : (
          <span>{selector.rows.length} results</span>
        )}
      </div>
      <div
        className="selector-results"
        role="listbox"
        aria-label={selector.referenceMode ? "References" : "Slash commands"}
        id={id}
        aria-busy={selector.loading || selector.busy}
      >
        {selector.rows.map((row, index) => (
          <div role="presentation" key={row.key}>
            {index === 0 || selector.rows[index - 1]?.kind !== row.kind ? (
              <div className="selector-group" role="presentation">
                {groups[row.kind]}
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
                <strong>{row.name}</strong>
                <span>{row.description}</span>
                {row.detail ? (
                  <small title={row.detail}>{row.detail}</small>
                ) : null}
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
            No matches. Try another name or description.
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
        <span>
          {selector.referenceMode
            ? "Adds a locator; the agent reads it when needed."
            : "Choose to edit before sending."}
        </span>
        <span>
          <kbd>↑↓</kbd> <kbd>Enter</kbd> <kbd>Tab</kbd> select · <kbd>Esc</kbd>{" "}
          close
        </span>
      </footer>
    </div>
  );
}
