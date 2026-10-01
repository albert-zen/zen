import { useEffect, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/controls.js";
import { Icon } from "./icons.js";
import {
  defaultComposerIntent,
  type ComposerIntent,
  type ComposerSendMode,
} from "./composer-state.js";

const choices: readonly {
  mode: ComposerSendMode;
  intent: ComposerIntent;
  label: string;
}[] = [
  { mode: "soft", intent: "steer", label: "Steer now" },
  { mode: "batch", intent: "batch-next", label: "Next turn" },
  { mode: "queue", intent: "queue", label: "Each turn" },
  { mode: "hard", intent: "replace", label: "Interrupt and send" },
];

/** Presentation only: sending and saving preferences keep their existing owners. */
export function ComposerSendControl({
  mode,
  running,
  hasDraft,
  disabled,
  sendDisabled,
  primaryMode,
  primaryLabel,
  compact,
  onPrimary,
  onSend,
  onStop,
  onModeChange,
}: {
  mode: ComposerSendMode;
  running: boolean;
  hasDraft: boolean;
  disabled: boolean;
  sendDisabled: boolean;
  primaryMode: string;
  primaryLabel: string;
  compact: boolean;
  onPrimary(): void;
  onSend(intent: ComposerIntent): void;
  onStop(): void;
  onModeChange?(mode: ComposerSendMode): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusPanel = useRef(false);
  const cancelClose = () => {
    clearTimeout(timer.current);
  };
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const close = () => {
    cancelClose();
    setOpen(false);
  };
  const leave = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (
        !anchor.current?.contains(document.activeElement) &&
        !panel.current?.contains(document.activeElement)
      )
        setOpen(false);
    }, 200);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (open && focusPanel.current) {
      focusPanel.current = false;
      panel.current
        ?.querySelector<HTMLElement>(
          "button:not(:disabled), select:not(:disabled)",
        )
        ?.focus();
    }
  }, [open]);
  const sendIntent = defaultComposerIntent(running, mode);
  const alternate = defaultComposerIntent(running, mode, true);
  const modifier =
    typeof navigator !== "undefined" && /Mac/.test(navigator.platform)
      ? "⌘"
      : "Ctrl+";
  const options = compact
    ? [{ intent: sendIntent, label: "Compact context" }]
    : running
      ? choices
      : [{ intent: "start" as const, label: "Send" }];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          className="composer-send-control"
          ref={anchor}
          onPointerEnter={show}
          onPointerLeave={leave}
          onFocus={show}
          onBlur={leave}
          tabIndex={disabled ? 0 : undefined}
          aria-label={disabled ? "Send options" : undefined}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              focusPanel.current = true;
              show();
              if (open) {
                focusPanel.current = false;
                panel.current
                  ?.querySelector<HTMLElement>(
                    "button:not(:disabled), select:not(:disabled)",
                  )
                  ?.focus();
              }
            }
          }}
        >
          <button
            className={`action-orb ${primaryMode}`}
            type="button"
            aria-label={primaryLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => {
              close();
              onPrimary();
            }}
          >
            <Icon name={primaryMode === "stop" ? "stop" : "send"} size={18} />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={panel}
        className="composer-send-popover"
        align="end"
        side="top"
        sideOffset={8}
        aria-label="Send options"
        onPointerEnter={cancelClose}
        onPointerLeave={leave}
        onFocus={cancelClose}
        onBlur={leave}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => {
          if (anchor.current?.contains(event.target as Node))
            event.preventDefault();
        }}
        onEscapeKeyDown={() => {
          anchor.current?.querySelector("button")?.focus();
          close();
        }}
      >
        <div className="composer-send-options">
          {options.map(({ intent, label }) => (
            <button
              type="button"
              key={intent}
              disabled={sendDisabled || !hasDraft}
              onClick={() => {
                close();
                onSend(intent);
              }}
            >
              <span>{label}</span>
              {intent === sendIntent ? (
                <kbd>Enter</kbd>
              ) : intent === alternate ? (
                <kbd>{modifier}Enter</kbd>
              ) : null}
            </button>
          ))}
          {running ? (
            <button
              type="button"
              disabled={disabled && primaryMode === "stop"}
              onClick={() => {
                close();
                onStop();
              }}
            >
              <span>Stop</span>
              <Icon name="stop" size={13} />
            </button>
          ) : null}
        </div>
        {onModeChange ? (
          <label className="composer-send-default">
            <span>Default while running</span>
            <select
              aria-label="Default send mode"
              value={mode}
              disabled={saving}
              onChange={(event) => {
                const next = event.target.value as ComposerSendMode;
                if (next === mode) return;
                setSaving(true);
                setError(null);
                void onModeChange(next)
                  .catch((reason: unknown) =>
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : "Could not save send preference",
                    ),
                  )
                  .finally(() => setSaving(false));
              }}
            >
              {choices.map((choice) => (
                <option key={choice.mode} value={choice.mode}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? (
          <p className="composer-send-error" role="alert">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
