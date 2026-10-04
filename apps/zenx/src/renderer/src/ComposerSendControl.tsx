import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/controls.js";
import { ComposerAction } from "./Composer.js";
import { Icon } from "./icons.js";
import {
  defaultComposerIntent,
  type ComposerIntent,
  type ComposerSendMode,
} from "./composer-state.js";

function sendChoices(): readonly {
  mode: ComposerSendMode;
  intent: ComposerIntent;
  label: string;
}[] {
  return [
    { mode: "soft", intent: "steer", label: i18n.t("shell:steerNow") },
    { mode: "batch", intent: "batch-next", label: i18n.t("shell:nextTurn") },
    { mode: "queue", intent: "queue", label: i18n.t("shell:eachTurn") },
    {
      mode: "hard",
      intent: "replace",
      label: i18n.t("shell:interruptAndSend"),
    },
  ];
}

/** Presentation only: sending and saving preferences keep their existing owners. */
export function ComposerSendControl({
  mode,
  running,
  hasDraft,
  disabled,
  sendDisabled,
  stopDisabled = disabled,
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
  stopDisabled?: boolean;
  primaryMode: string;
  primaryLabel: string;
  compact: boolean;
  onPrimary(): void;
  onSend(intent: ComposerIntent): void;
  onStop(): void;
  onModeChange?(mode: ComposerSendMode): Promise<void>;
}) {
  useTranslation("shell");
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
    ? [{ intent: sendIntent, label: i18n.t("shell:compactContext") }]
    : running
      ? sendChoices()
      : [{ intent: "start" as const, label: i18n.t("shell:send") }];
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
          aria-label={disabled ? i18n.t("shell:sendOptions") : undefined}
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
          <ComposerAction
            mode={primaryMode}
            label={primaryLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => {
              close();
              onPrimary();
            }}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={panel}
        className="composer-send-popover"
        align="end"
        side="top"
        sideOffset={8}
        aria-label={i18n.t("shell:sendOptions")}
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
              disabled={stopDisabled}
              onClick={() => {
                close();
                onStop();
              }}
            >
              <span>{i18n.t("shell:stop")}</span>
              <Icon name="stop" size={13} />
            </button>
          ) : null}
        </div>
        {onModeChange ? (
          <label className="composer-send-default">
            <span>{i18n.t("shell:defaultWhileRunning")}</span>
            <select
              aria-label={i18n.t("shell:defaultSendMode")}
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
                        : i18n.t("shell:couldNotSaveSendPreference"),
                    ),
                  )
                  .finally(() => setSaving(false));
              }}
            >
              {sendChoices().map((choice) => (
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
