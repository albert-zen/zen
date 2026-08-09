import { useState } from "react";
import type { TriggerSnapshot } from "../../main/trigger-types.js";
import { Markdown } from "./Markdown.js";

export function RoomView({
  roomId,
  snapshot,
  onOpenThread,
}: {
  roomId: string;
  snapshot: TriggerSnapshot;
  onOpenThread(id: string): void;
}) {
  const [draft, setDraft] = useState("");
  const room = snapshot.rooms.find((item) => item.id === roomId);
  if (!room)
    return (
      <section className="empty-canvas">
        <h2>Room not found</h2>
      </section>
    );
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await window.zenx.triggers.postRoomMessage(room.id, "You", text);
  };
  return (
    <section className="room-view">
      <header>
        <div>
          <h1>
            <span>#</span>
            {room.name}
          </h1>
          <p>
            Shared conclusions and routing · reasoning stays in each member
            Thread
          </p>
        </div>
        <div className="room-members">
          {room.members.map((member) => (
            <span key={member.threadId}>@{member.name}</span>
          ))}
        </div>
      </header>
      <div className="room-messages">
        <div className="room-note">
          <strong>Room ≠ Thread.</strong> Messages enter an Agent context only
          when an explicit @mention trigger wakes its member Thread.
        </div>
        {room.messages.map((message) =>
          message.kind === "system" ? (
            <div className="room-system" key={message.id}>
              {message.text}
            </div>
          ) : (
            <article className="room-message" key={message.id}>
              <header>
                <strong>{message.author}</strong>
                <time>
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </header>
              <Markdown text={message.text} />
              {message.originThreadId ? (
                <button
                  className="origin-card"
                  type="button"
                  onClick={() => onOpenThread(message.originThreadId!)}
                >
                  Source Thread · Turn {message.originTurnId?.slice(0, 8)}{" "}
                  <span>Open →</span>
                </button>
              ) : null}
            </article>
          ),
        )}
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <textarea
            rows={1}
            aria-label="Room message"
            placeholder="Message the Room… use @name to wake a member"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-row">
            <span>@mention only routes to a registered member trigger</span>
            <button
              className="send-button"
              type="button"
              disabled={!draft.trim()}
              onClick={() => void send()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
