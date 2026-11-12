import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RoomMessage } from "../../main/trigger-types.js";
import { Icon } from "./icons.js";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/controls.js";

const reactionOptions = ["👍", "❤️", "🎉", "👀", "✅", "🤔"];
type ActionPanel = "actions" | "reactions" | "details";

export function RoomMessageActions({
  message,
  disabled,
  onReply,
  onReact,
  operationId,
}: {
  message: RoomMessage;
  disabled: boolean;
  onReply(): void;
  onReact(emoji: string | null): Promise<void> | void;
  operationId?: string;
}) {
  const { t } = useTranslation("panels");
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<ActionPanel>("actions");
  const contentId = useId();
  const toolbar = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(true);
  const ownReaction = message.reactions?.find(
    (reaction) => reaction.actorId === "user",
  )?.emoji;
  const groups = new Map<string, NonNullable<RoomMessage["reactions"]>>();
  for (const reaction of message.reactions ?? []) {
    const group = groups.get(reaction.emoji) ?? [];
    group.push(reaction);
    groups.set(reaction.emoji, group);
  }

  useLayoutEffect(() => {
    if (open)
      content.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
  }, [open, panel]);

  function openPanel(
    next: ActionPanel,
    trigger: HTMLButtonElement,
    toggle = true,
  ) {
    const sameTrigger = opener.current === trigger;
    restoreFocus.current = true;
    opener.current = trigger;
    setOpen((current) => !(toggle && current && sameTrigger));
    setPanel(next);
  }

  function reply() {
    if (disabled) return;
    // The parent moves focus to the composer. Closing the popover must not
    // restore its old trigger over that deliberate destination.
    restoreFocus.current = false;
    setOpen(false);
    onReply();
  }

  function react(emoji: string) {
    if (disabled) return;
    setOpen(false);
    void onReact(ownReaction === emoji ? null : emoji);
  }

  const panelLabel =
    panel === "reactions"
      ? t("chooseReaction")
      : panel === "details"
        ? t("roomTechnicalDetails")
        : t("roomMessageActions");
  const openedFromMore =
    opener.current?.classList.contains("room-message-action-more") ?? false;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div
            ref={toolbar}
            className="room-message-action-toolbar"
            role="group"
            aria-label={t("roomMessageActions")}
            data-open={open || undefined}
          >
            <button
              type="button"
              className="room-message-action-quick"
              disabled={disabled}
              aria-label={t("reply")}
              title={t("reply")}
              onClick={reply}
            >
              <Icon name="reply" size={16} />
            </button>
            <button
              type="button"
              className="room-message-action-quick"
              disabled={disabled}
              aria-label={t("react")}
              title={t("react")}
              aria-haspopup="dialog"
              aria-expanded={open && !openedFromMore}
              aria-controls={open && !openedFromMore ? contentId : undefined}
              onClick={(event) => openPanel("reactions", event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  openPanel("reactions", event.currentTarget, false);
                }
              }}
            >
              <Icon name="smile" size={16} />
            </button>
            <button
              type="button"
              className="room-message-action-more"
              aria-label={t("moreActions")}
              title={t("moreActions")}
              aria-haspopup={
                open && openedFromMore && panel !== "actions"
                  ? "dialog"
                  : "menu"
              }
              aria-expanded={open && openedFromMore}
              aria-controls={open && openedFromMore ? contentId : undefined}
              onClick={(event) => openPanel("actions", event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  openPanel("actions", event.currentTarget, false);
                }
              }}
            >
              <Icon name="more" size={16} />
            </button>
          </div>
        </PopoverAnchor>
        <PopoverContent
          ref={content}
          id={contentId}
          side="bottom"
          align={message.kind === "human" ? "start" : "end"}
          role={panel === "actions" ? "menu" : "dialog"}
          aria-label={panelLabel}
          className={`room-message-action-popover room-message-action-${panel}`}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current
              ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
              ?.focus();
          }}
          onInteractOutside={(event) => {
            // Both More and React control the same anchored popover. Let their
            // click toggle/switch it, rather than dismissing on pointerdown and
            // reopening it on the following click.
            if (toolbar.current?.contains(event.target as Node)) {
              event.preventDefault();
              return;
            }
            restoreFocus.current = false;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (restoreFocus.current && opener.current?.isConnected)
              opener.current.focus();
          }}
          onKeyDown={(event) => {
            if (panel === "details") return;
            if (event.key === "Tab" && panel === "actions") {
              restoreFocus.current = false;
              opener.current?.focus();
              setOpen(false);
              return;
            }
            const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
            if (panel === "reactions") keys.push("ArrowLeft", "ArrowRight");
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(
              content.current?.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ) ?? [],
            );
            const current = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (current +
                      (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) +
                      buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }}
        >
          {panel === "actions" ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="ui-action-item"
                disabled={disabled}
                onClick={reply}
              >
                <Icon name="reply" size={16} />
                {t("reply")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="ui-action-item"
                disabled={disabled}
                onClick={() => setPanel("reactions")}
              >
                <Icon name="smile" size={16} />
                {t("react")}
              </button>
              <div className="room-message-action-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="ui-action-item"
                onClick={() => setPanel("details")}
              >
                <Icon name="list-detail" size={16} />
                {t("roomTechnicalDetails")}
              </button>
            </>
          ) : panel === "reactions" ? (
            <div className="room-message-reaction-picker">
              {reactionOptions.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  disabled={disabled}
                  aria-label={
                    ownReaction === emoji
                      ? t("roomRemoveReaction", { emoji })
                      : t("reactEmoji", { emoji })
                  }
                  title={
                    ownReaction === emoji
                      ? t("roomRemoveReaction", { emoji })
                      : t("reactEmoji", { emoji })
                  }
                  aria-pressed={ownReaction === emoji}
                  onClick={() => react(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          ) : panel === "details" ? (
            <>
              <div className="room-message-technical-heading">
                <button
                  type="button"
                  aria-label={`${t("back")} · ${t("roomMessageActions")}`}
                  title={t("back")}
                  onClick={() => setPanel("actions")}
                >
                  <Icon name="arrow-left" size={16} />
                </button>
                <strong>{t("roomTechnicalDetails")}</strong>
                <button
                  type="button"
                  aria-label={t("close")}
                  title={t("close")}
                  onClick={() => setOpen(false)}
                >
                  <Icon name="x" size={16} />
                </button>
              </div>
              <dl className="room-message-technical-fields">
                <dt>{t("messageId")}</dt>
                <dd>{message.id}</dd>
                {message.originThreadId ? (
                  <>
                    <dt>{t("sourceConversation")}</dt>
                    <dd>{message.originThreadId}</dd>
                  </>
                ) : null}
                {message.originTurnId ? (
                  <>
                    <dt>{t("turn")}</dt>
                    <dd>{message.originTurnId}</dd>
                  </>
                ) : null}
                {operationId ? (
                  <>
                    <dt>{t("operationId")}</dt>
                    <dd>{operationId}</dd>
                  </>
                ) : null}
              </dl>
            </>
          ) : null}
        </PopoverContent>
      </Popover>
      {groups.size ? (
        <div className="room-message-reactions">
          {Array.from(groups, ([emoji, reactions]) => {
            const summary = t("roomReactionSummary", {
              emoji,
              count: reactions.length,
              names: reactions.map((reaction) => reaction.label).join(", "),
            });
            const action =
              ownReaction === emoji
                ? t("roomRemoveReaction", { emoji })
                : t("reactEmoji", { emoji });
            return (
              <button
                key={emoji}
                type="button"
                className="room-message-reaction-chip"
                disabled={disabled}
                title={summary}
                aria-label={`${summary} · ${action}`}
                aria-pressed={ownReaction === emoji}
                onClick={() => react(emoji)}
              >
                <span aria-hidden="true">{emoji}</span>
                <span aria-hidden="true">{reactions.length}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
