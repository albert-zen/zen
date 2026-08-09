import { useState } from "react";
import type { TriggerSnapshot } from "../../main/trigger-types.js";
import type { Thread } from "../../protocol-client/index.js";
import { Markdown } from "./Markdown.js";

export function RoomView({
  roomId,
  snapshot,
  threads,
  onOpenThread,
}: {
  roomId: string;
  snapshot: TriggerSnapshot;
  threads: readonly Thread[];
  onOpenThread(id: string): void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [memberName, setMemberName] = useState("");
  const [memberThread, setMemberThread] = useState(threads[0]?.id ?? "");
  const [memberPending, setMemberPending] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const room = snapshot.rooms.find((item) => item.id === roomId);
  if (!room)
    return (
      <section className="empty-canvas">
        <h2>Room not found</h2>
      </section>
    );
  const availableThreads = threads.filter(
    (thread) => !room.members.some((member) => member.threadId === thread.id),
  );
  const selectedMemberThread = availableThreads.some(
    (thread) => thread.id === memberThread,
  )
    ? memberThread
    : (availableThreads[0]?.id ?? "");

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await window.zenx.triggers.postRoomMessage(room.id, "You", text);
      setDraft("");
    } catch (error) {
      setSendError(`${describeError(error)} Draft was kept; retry explicitly.`);
    } finally {
      setSending(false);
    }
  };

  const addMember = async () => {
    if (!memberName.trim() || !selectedMemberThread || memberPending !== null)
      return;
    setMemberPending("add");
    setMemberError(null);
    try {
      await window.zenx.triggers.addRoomMember(room.id, {
        name: memberName,
        threadId: selectedMemberThread,
      });
      setMemberName("");
    } catch (error) {
      setMemberError(`${describeError(error)} Member draft was kept.`);
    } finally {
      setMemberPending(null);
    }
  };

  const removeMember = async (threadId: string) => {
    if (memberPending !== null) return;
    setMemberPending(threadId);
    setMemberError(null);
    try {
      await window.zenx.triggers.removeRoomMember(room.id, threadId);
    } catch (error) {
      setMemberError(`${describeError(error)} Retry removal explicitly.`);
    } finally {
      setMemberPending(null);
    }
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
        <div className="room-members" aria-label="Room members">
          {room.members.map((member) => (
            <span key={member.threadId}>
              @{member.name}
              <button
                type="button"
                disabled={memberPending !== null}
                aria-label={`Remove ${member.name} from Room`}
                onClick={() => void removeMember(member.threadId)}
              >
                {memberPending === member.threadId ? "…" : "×"}
              </button>
            </span>
          ))}
        </div>
      </header>
      <div className="room-member-manager">
        <input
          aria-label="New member name"
          placeholder="Reviewer"
          value={memberName}
          onChange={(event) => setMemberName(event.target.value)}
        />
        <select
          aria-label="New member Thread"
          value={selectedMemberThread}
          onChange={(event) => setMemberThread(event.target.value)}
        >
          {availableThreads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.name ?? thread.preview ?? thread.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={
            memberPending !== null ||
            !memberName.trim() ||
            !selectedMemberThread
          }
          onClick={() => void addMember()}
        >
          {memberPending === "add" ? "Adding…" : "Add member"}
        </button>
        {memberError ? (
          <span className="form-error" role="alert">
            {memberError}
          </span>
        ) : null}
      </div>
      <div className="room-messages">
        <div className="room-note">
          <strong>Room ≠ Thread.</strong> A matching @mention trigger injects a
          bounded window of recent Room messages into that member’s normal new
          Turn.
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
            disabled={sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-row">
            <span
              className={sendError ? "composer-error" : undefined}
              role={sendError ? "alert" : undefined}
            >
              {sendError ??
                "@mention routes only through a registered member trigger"}
            </span>
            <button
              className="send-button"
              type="button"
              disabled={sending || !draft.trim()}
              onClick={() => void send()}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
