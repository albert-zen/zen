import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons.js";

export const ROOM_ROUTE = "/plugins/zenx-rooms/rooms";
const MAX_ROOMS = 128;
const POLL_DELAY_MS = 3_000;

export interface RoomConversation {
  id: string;
  name: string;
  assistant?: { threadId: string; triggerId: string };
  members: readonly { name: string; threadId: string }[];
  memberCount: number;
  messagePreview: string | null;
}

export interface RoomConversationState {
  rooms: readonly RoomConversation[];
  error: string | null;
  loading: boolean;
}

export function roomConversationRoute(id: string): string {
  return `${ROOM_ROUTE}?${new URLSearchParams({ roomId: id })}`;
}

/** A bounded navigation projection; the Rooms plugin remains its sole authority. */
export function useRoomConversations(enabled: boolean, revision?: unknown) {
  const [state, setState] = useState<
    RoomConversationState & { revision: unknown }
  >({
    rooms: [],
    error: null,
    loading: enabled,
    revision,
  });
  const inFlight = useRef<Promise<void> | null>(null);
  const refreshCurrent = useRef<(() => Promise<void>) | null>(null);
  const refresh = useCallback(
    () => refreshCurrent.current?.() ?? Promise.resolve(),
    [],
  );

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let pending: Promise<void> | null = null;
    setState({ rooms: [], error: null, loading: enabled, revision });
    if (!enabled) {
      refreshCurrent.current = null;
      return () => {
        active = false;
      };
    }

    const load = (): Promise<void> => {
      if (!active) return Promise.resolve();
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (pending !== null) return pending;
      // IPC reads cannot be cancelled. A new generation waits for the previous
      // read, but never consumes its result or overlaps another polling loop.
      const previous = inFlight.current;
      const operation = Promise.resolve()
        .then(async () => {
          if (previous !== null) await previous;
          if (!active) return;
          setState((current) => ({ ...current, loading: true }));
          try {
            const rooms = await readRoomConversations(() => active);
            if (active)
              setState({ rooms, error: null, loading: false, revision });
          } catch (error) {
            if (active)
              setState((current) => ({
                ...current,
                loading: false,
                error: error instanceof Error ? error.message : String(error),
              }));
          }
        })
        .finally(() => {
          if (inFlight.current === operation) inFlight.current = null;
          pending = null;
          if (active)
            timer = window.setTimeout(() => void load(), POLL_DELAY_MS);
        });
      pending = operation;
      inFlight.current = operation;
      return operation;
    };
    refreshCurrent.current = load;
    void load();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      if (refreshCurrent.current === load) refreshCurrent.current = null;
    };
  }, [enabled, revision]);

  // Admission changes hide the old projection during the render itself,
  // before effect cleanup has had a chance to run.
  return {
    rooms: enabled && Object.is(state.revision, revision) ? state.rooms : [],
    error: enabled && Object.is(state.revision, revision) ? state.error : null,
    loading: enabled && (state.loading || !Object.is(state.revision, revision)),
    refresh,
  };
}

async function readRoomConversations(
  active: () => boolean,
): Promise<RoomConversation[]> {
  const api = window.zenx?.plugins;
  if (api?.executeCommand === undefined)
    throw new Error("Rooms are unavailable");
  const rooms: RoomConversation[] = [];
  const ids = new Set<string>();
  let cursor = 0;
  for (let pageNumber = 0; pageNumber < MAX_ROOMS; pageNumber += 1) {
    if (!active()) return [];
    const page = record(
      await api.executeCommand("zenx-rooms", "list", { cursor }),
    );
    if (!active()) return [];
    if (!page || !Array.isArray(page.rooms))
      throw new Error("Invalid Room list");
    if (rooms.length + page.rooms.length > MAX_ROOMS)
      throw new Error("Room list exceeds its navigation limit");
    for (const value of page.rooms) {
      const room = navigationRoom(value);
      if (ids.has(room.id))
        throw new Error("Duplicate Room identity in navigation");
      ids.add(room.id);
      rooms.push(room);
    }
    if (page.nextCursor === null || page.nextCursor === undefined) return rooms;
    if (
      typeof page.nextCursor !== "number" ||
      !Number.isSafeInteger(page.nextCursor) ||
      page.nextCursor <= cursor
    )
      throw new Error("Room list cursor did not advance");
    cursor = page.nextCursor;
  }
  throw new Error("Room pagination exceeds its navigation limit");
}

function navigationRoom(value: unknown): RoomConversation {
  const room = record(value);
  if (
    !room ||
    !text(room.id, 512) ||
    !text(room.name, 256) ||
    !Array.isArray(room.members) ||
    room.members.length > 64
  )
    throw new Error("Invalid Room navigation facts");
  const members = room.members.map((value: unknown) => {
    const member = record(value);
    if (!member || !text(member.name, 128) || !text(member.threadId, 512))
      throw new Error("Invalid Room member");
    return { name: member.name, threadId: member.threadId };
  });
  let assistant: RoomConversation["assistant"];
  if (room.assistant !== undefined) {
    const candidate = record(room.assistant);
    if (
      !candidate ||
      !text(candidate.threadId, 512) ||
      !text(candidate.triggerId, 512)
    )
      throw new Error("Invalid PAW identity");
    assistant = {
      threadId: candidate.threadId,
      triggerId: candidate.triggerId,
    };
  }
  const messages = Array.isArray(room.messages) ? room.messages : [];
  const latest = record(messages.at(-1));
  const preview = typeof latest?.text === "string" ? latest.text : null;
  return {
    id: room.id,
    name: room.name,
    ...(assistant ? { assistant } : {}),
    members,
    memberCount: members.length,
    messagePreview:
      preview === null
        ? null
        : Array.from(preview.slice(0, 240)).slice(0, 120).join(""),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).length <= maxBytes
  );
}

export function RoomConversationNavigation({
  rooms,
  error,
  loading,
  selectedRoomId,
  selectedPage,
  onOpen,
}: RoomConversationState & {
  selectedRoomId?: string | null;
  selectedPage: string;
  onOpen(route: string): void;
}) {
  const groups = [
    {
      label: "PAW",
      displayKind: "PAW",
      kind: "companion",
      rooms: rooms.filter((room) => room.assistant !== undefined),
      icon: "conversation" as const,
    },
    {
      label: "Rooms",
      displayKind: "room",
      kind: "room",
      rooms: rooms.filter((room) => room.assistant === undefined),
      icon: "users" as const,
    },
  ];
  return (
    <nav
      className="room-conversations"
      aria-label="Conversations"
      aria-busy={loading}
    >
      {groups.map((group) => (
        <section
          className="room-conversation-group"
          aria-label={group.label}
          key={group.kind}
        >
          <div className="room-conversation-heading">
            <h2>{group.label}</h2>
            <button
              type="button"
              className="room-conversation-create"
              aria-label={`New ${group.displayKind}`}
              title={`New ${group.displayKind}`}
              onClick={() => onOpen(`${ROOM_ROUTE}?create=${group.kind}`)}
            >
              <Icon name="plus" size={13} />
            </button>
          </div>
          {group.rooms.map((room) => (
            <button
              type="button"
              className="room-conversation-row"
              key={room.id}
              aria-label={`Open ${group.displayKind} ${room.name}`}
              aria-current={
                selectedRoomId === room.id &&
                selectedPage.split(/[?#]/u, 1)[0] === ROOM_ROUTE
                  ? "page"
                  : undefined
              }
              title={room.name}
              onClick={() => onOpen(roomConversationRoute(room.id))}
            >
              <Icon name={group.icon} size={14} />
              <span className="room-conversation-label">
                <strong>{room.name}</strong>
                <small>
                  {room.messagePreview ||
                    (room.assistant
                      ? "Personal conversation"
                      : `${room.memberCount} ${room.memberCount === 1 ? "member" : "members"}`)}
                </small>
              </span>
            </button>
          ))}
          {group.rooms.length === 0 && !loading && error === null ? (
            <p className="room-conversation-empty">
              {group.kind === "companion"
                ? "Your PAW conversations"
                : "Your shared conversations"}
            </p>
          ) : null}
        </section>
      ))}
      {loading && rooms.length === 0 ? (
        <p className="room-conversation-empty" role="status">
          Loading conversations…
        </p>
      ) : null}
      {error !== null ? (
        <div className="room-conversation-error" role="alert">
          <p>Could not load conversations: {error}</p>
          <button type="button" onClick={() => onOpen(ROOM_ROUTE)}>
            Open Rooms
          </button>
        </div>
      ) : null}
    </nav>
  );
}
