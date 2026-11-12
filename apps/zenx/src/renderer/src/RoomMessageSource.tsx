import { useTranslation } from "react-i18next";
import React, { useRef, useState } from "react";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type {
  RoomMember,
  RoomMessage,
  ZenXRoom,
} from "../../main/trigger-types.js";
import { i18n } from "./i18n.js";
import { threadTitle } from "./thread-list.js";
import { roomConversationRoute } from "./room-conversations.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/controls.js";

/** A single human-readable name; only recorded source identity may resolve a generic label. */
export function roomSenderName(
  message: RoomMessage,
  members: readonly RoomMember[],
  threads: readonly NativeThreadSummary[],
): string {
  if (message.kind === "human" && message.author === "You")
    return i18n.t("panels:you");
  if (message.kind === "system" && message.author === "System")
    return i18n.t("panels:system");
  if (message.author.trim() && message.author !== "Agent")
    return message.author;
  if (message.kind !== "agent") return message.author;
  if (!message.originThreadId) return i18n.t("panels:roomUnknownSender");
  const resolved =
    members.find((member) => member.threadId === message.originThreadId)
      ?.name ??
    threads.find((thread) => thread.threadId === message.originThreadId)?.name;
  return resolved?.trim() || i18n.t("panels:roomUnnamedSender");
}

/** The normal message header is just name + time. Source navigation is on demand. */
export function RoomMessageSource({
  message,
  members = [],
  rooms,
  threads,
  navigate,
}: {
  message: RoomMessage;
  members?: readonly RoomMember[];
  rooms: readonly Pick<ZenXRoom, "id" | "name" | "assistant">[];
  threads: readonly NativeThreadSummary[];
  navigate(route: string): void;
}) {
  const { t } = useTranslation("panels");
  const [open, setOpen] = useState(false);
  const navigating = useRef(false);
  const name = roomSenderName(message, members, threads);
  if (message.kind !== "agent") return <strong>{name}</strong>;
  const threadId = message.originThreadId;
  const thread = threads.find((entry) => entry.threadId === threadId);
  const paws = threadId
    ? rooms.filter((entry) => entry.assistant?.threadId === threadId)
    : [];
  const openSource = (route: string) => {
    navigating.current = true;
    setOpen(false);
    navigate(route);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="room-sender-name"
          title={t("roomSenderProfile", { name })}
        >
          <strong>{name}</strong>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        className="room-sender-profile"
        aria-label={t("roomSenderProfile", { name })}
        onCloseAutoFocus={(event) => {
          if (navigating.current) event.preventDefault();
          navigating.current = false;
        }}
      >
        <strong>{name}</strong>
        {threadId ? (
          <button
            type="button"
            className="room-source-link"
            onClick={() =>
              openSource(`/threads/${encodeURIComponent(threadId)}`)
            }
          >
            {thread
              ? t("roomSourceThread", { name: threadTitle(thread) })
              : t("roomOpenSourceConversation")}
          </button>
        ) : (
          <p>{t("roomSourceNotRecordedHelp")}</p>
        )}
        {paws.map((paw) => (
          <button
            type="button"
            className="room-source-link"
            key={paw.id}
            title={t("roomSourcePawHelp")}
            onClick={() => openSource(roomConversationRoute(paw.id))}
          >
            {t("roomSourcePaw", { name: paw.name })}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
