import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { useEffect, useId, useRef, useState } from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  Select,
} from "./ui/controls.js";
import { ComposerAction } from "./Composer.js";
import { Icon, type IconName } from "./icons.js";
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

function intentDescription(intent: ComposerIntent): string {
  const key = {
    start: "sendDescriptionStart",
    steer: "sendDescriptionSteer",
    "batch-next": "sendDescriptionBatch",
    queue: "sendDescriptionQueue",
    replace: "sendDescriptionReplace",
  }[intent];
  return i18n.t(`shell:${key}`);
}
function intentIcon(intent: ComposerIntent): IconName {
  return intent === "steer"
    ? "send"
    : intent === "batch-next"
      ? "layers"
      : intent === "queue"
        ? "list-detail"
        : intent === "replace"
          ? "reload"
          : "send";
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
  const primary = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusRequest = useRef<"open" | "return" | null>(null);
  // React focus events include the shared Select's nested portal.
  const panelOwnsFocus = useRef(false);
  const pinned = useRef(false);
  const dismissed = useRef(false);
  const touchActivation = useRef(false);
  const id = useId();
  const cancelClose = () => clearTimeout(timer.current);
  const show = () => {
    cancelClose();
    if (!dismissed.current) setOpen(true);
  };
  const close = (restoreFocus = false) => {
    cancelClose();
    if (
      restoreFocus &&
      (panelOwnsFocus.current ||
        panel.current?.contains(document.activeElement))
    ) {
      focusRequest.current = "return";
    } else if (focusRequest.current !== "return") {
      focusRequest.current = null;
    }
    pinned.current = false;
    dismissed.current = true;
    setOpen(false);
  };
  const leave = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (
        !pinned.current &&
        !anchor.current?.contains(document.activeElement) &&
        !panel.current?.contains(document.activeElement)
      )
        setOpen(false);
    }, 200);
  };
  const focusFirstAction = () =>
    panel.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  const openForInteraction = () => {
    dismissed.current = false;
    pinned.current = true;
    focusRequest.current = "open";
    show();
    if (open && panel.current) {
      focusRequest.current = null;
      focusFirstAction();
    }
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  // A changed turn/context invalidates the old action surface, never the draft.
  useEffect(() => {
    close(true);
  }, [running, compact]);
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
  const description = compact
    ? i18n.t("shell:sendDescriptionCompact")
    : primaryMode === "stop"
      ? i18n.t("shell:sendDescriptionStop")
      : !hasDraft
        ? i18n.t("shell:sendDraftHint")
        : disabled
          ? i18n.t("shell:sendUnavailableHint")
          : intentDescription(sendIntent);
  const saveMode = (value: string) => {
    const next = value as ComposerSendMode;
    if (next === mode || !onModeChange || saving) return;
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
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) show();
        else close();
      }}
    >
      <PopoverAnchor asChild>
        <div
          className="composer-send-control"
          ref={anchor}
          tabIndex={disabled ? 0 : undefined}
          role={disabled ? "group" : undefined}
          aria-label={disabled ? i18n.t("shell:sendOptions") : undefined}
          aria-describedby={disabled ? `${id}-hint` : undefined}
          aria-keyshortcuts={disabled ? "ArrowUp ArrowDown" : undefined}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            touchActivation.current = false;
            dismissed.current = false;
            show();
          }}
          onPointerDown={(event) => {
            touchActivation.current = event.pointerType === "touch";
          }}
          onPointerLeave={leave}
          onFocus={(event) => {
            if (focusRequest.current === "return") return;
            if (touchActivation.current) return;
            const previous = event.relatedTarget as Node | null;
            if (
              !anchor.current?.contains(previous) &&
              !panel.current?.contains(previous)
            )
              dismissed.current = false;
            show();
          }}
          onBlur={leave}
          onKeyDown={(event) => {
            touchActivation.current = false;
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              openForInteraction();
            }
          }}
        >
          <span id={`${id}-hint`} className="sr-only">
            {description} {i18n.t("shell:sendOptionsHint")}
          </span>
          <ComposerAction
            ref={primary}
            mode={primaryMode}
            label={primaryLabel}
            aria-describedby={`${id}-hint`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            disabled={disabled}
            onClick={() => {
              close();
              onPrimary();
            }}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        id={`${id}-panel`}
        ref={panel}
        className="composer-send-popover"
        align="end"
        side="top"
        sideOffset={8}
        aria-label={i18n.t("shell:sendOptions")}
        aria-describedby={`${id}-description`}
        onPointerEnter={cancelClose}
        onPointerLeave={leave}
        onPointerDown={() => {
          pinned.current = true;
        }}
        onFocus={() => {
          panelOwnsFocus.current = true;
          pinned.current = true;
          cancelClose();
        }}
        onBlur={() => {
          panelOwnsFocus.current = false;
          leave();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (focusRequest.current === "open") {
            focusRequest.current = null;
            focusFirstAction();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          panelOwnsFocus.current = false;
          if (focusRequest.current === "return") {
            (primary.current?.disabled
              ? anchor.current
              : primary.current
            )?.focus();
            focusRequest.current = null;
          }
        }}
        onFocusOutside={(event) => {
          if (anchor.current?.contains(event.target as Node))
            event.preventDefault();
        }}
        onEscapeKeyDown={() => {
          close(true);
        }}
      >
        <button
          type="button"
          className="composer-send-summary"
          data-action={primaryMode}
          aria-label={primaryLabel}
          aria-describedby={`${id}-description`}
          disabled={disabled}
          onClick={() => {
            close(true);
            onPrimary();
          }}
        >
          <span className="composer-send-heading">
            <strong>{primaryLabel}</strong>
            <span>
              {primaryMode === "stop" ? (
                i18n.t("shell:sendClickHint")
              ) : (
                <>
                  <span>{i18n.t("shell:sendClickHint")}</span>
                  <kbd>Enter</kbd>
                </>
              )}
            </span>
          </span>
          <span id={`${id}-description`} className="composer-send-description">
            {description}
          </span>
        </button>
        <div className="composer-send-body">
          <div className="composer-send-options">
            {options
              .filter(
                ({ intent }) => primaryMode === "stop" || intent !== sendIntent,
              )
              .map(({ intent, label }) => (
                <button
                  type="button"
                  key={intent}
                  data-primary={
                    primaryMode !== "stop" && intent === sendIntent
                      ? "true"
                      : undefined
                  }
                  disabled={sendDisabled || !hasDraft}
                  onClick={() => {
                    close(true);
                    onSend(intent);
                  }}
                >
                  <Icon
                    name={compact ? "compress" : intentIcon(intent)}
                    size={15}
                  />
                  <span>
                    <strong>{label}</strong>
                    {running && !compact ? (
                      <small>{intentDescription(intent)}</small>
                    ) : null}
                  </span>
                  {intent === sendIntent ? (
                    <kbd>Enter</kbd>
                  ) : intent === alternate ? (
                    <kbd>{modifier}Enter</kbd>
                  ) : null}
                </button>
              ))}
            {running && primaryMode !== "stop" ? (
              <button
                type="button"
                className="composer-send-stop"
                disabled={stopDisabled}
                onClick={() => {
                  close(true);
                  onStop();
                }}
              >
                <Icon name="stop" size={15} />
                <span>
                  <strong>{i18n.t("shell:stop")}</strong>
                  <small>{i18n.t("shell:sendDescriptionStop")}</small>
                </span>
              </button>
            ) : null}
          </div>
          {onModeChange ? (
            <div className="composer-send-default">
              <label htmlFor={`${id}-default`}>
                {i18n.t("shell:defaultWhileRunning")}
              </label>
              <Select
                id={`${id}-default`}
                aria-label={i18n.t("shell:defaultSendMode")}
                value={mode}
                disabled={saving}
                onValueChange={saveMode}
              >
                {sendChoices().map((choice) => (
                  <option key={choice.mode} value={choice.mode}>
                    {choice.label}
                  </option>
                ))}
              </Select>
              <p>{i18n.t("shell:sendDefaultHint")}</p>
            </div>
          ) : null}
          {error ? (
            <p className="composer-send-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
