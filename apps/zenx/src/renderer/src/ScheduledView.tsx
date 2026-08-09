import { useState } from "react";
import type { Thread } from "../../protocol-client/index.js";
import type { RoomMember, TriggerSnapshot } from "../../main/trigger-types.js";

export function ScheduledView({
  snapshot,
  threads,
  onOpenThread,
  onOpenRoom,
}: {
  snapshot: TriggerSnapshot;
  threads: readonly Thread[];
  onOpenThread(id: string): void;
  onOpenRoom(id: string): void;
}) {
  const [roomName, setRoomName] = useState("");
  const [memberName, setMemberName] = useState("Zen");
  const [memberThread, setMemberThread] = useState(threads[0]?.id ?? "");
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>([]);
  const [roomPending, setRoomPending] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [signalName, setSignalName] = useState("");
  const [signalDetail, setSignalDetail] = useState("");
  const [signalPending, setSignalPending] = useState(false);
  const [signalError, setSignalError] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState<Set<string>>(new Set());
  const [cancelErrors, setCancelErrors] = useState<Record<string, string>>({});
  const active = snapshot.triggers.filter((trigger) => trigger.active);
  const selectedMemberThread = memberThread || threads[0]?.id || "";

  const addMemberDraft = () => {
    const member = { name: memberName.trim(), threadId: selectedMemberThread };
    if (!member.name || !member.threadId) {
      setRoomError("Member name and Thread are required.");
      return;
    }
    if (
      roomMembers.some(
        (entry) =>
          entry.name.toLocaleLowerCase() === member.name.toLocaleLowerCase() ||
          entry.threadId === member.threadId,
      )
    ) {
      setRoomError("Member names and Threads must be unique within a Room.");
      return;
    }
    setRoomMembers((current) => [...current, member]);
    setMemberName("");
    setRoomError(null);
  };

  const createRoom = async () => {
    if (roomPending) return;
    setRoomPending(true);
    setRoomError(null);
    try {
      await window.zenx.triggers.createRoom({
        name: roomName,
        members: roomMembers,
      });
      setRoomName("");
      setRoomMembers([]);
    } catch (error) {
      setRoomError(`${describeError(error)} Draft and members were kept.`);
    } finally {
      setRoomPending(false);
    }
  };

  const sendSignal = async () => {
    if (signalPending) return;
    setSignalPending(true);
    setSignalError(null);
    try {
      await window.zenx.triggers.signal(signalName, signalDetail);
      setSignalName("");
      setSignalDetail("");
    } catch (error) {
      setSignalError(`${describeError(error)} Signal draft was kept.`);
    } finally {
      setSignalPending(false);
    }
  };

  const cancelTrigger = async (triggerId: string) => {
    setCancelPending((current) => new Set(current).add(triggerId));
    setCancelErrors((current) => {
      const next = { ...current };
      delete next[triggerId];
      return next;
    });
    try {
      await window.zenx.triggers.cancel(triggerId);
    } catch (error) {
      setCancelErrors((current) => ({
        ...current,
        [triggerId]: describeError(error),
      }));
    } finally {
      setCancelPending((current) => {
        const next = new Set(current);
        next.delete(triggerId);
        return next;
      });
    }
  };

  return (
    <section className="scheduled-view">
      <header>
        <div>
          <span>ZenX outer layer</span>
          <h1>Scheduled</h1>
          <p>
            {active.length} active wakeup conditions across{" "}
            {new Set(active.map((item) => item.threadId)).size} threads
          </p>
        </div>
      </header>
      <div className="scheduled-scroll">
        <h2>Active triggers</h2>
        {active.map((trigger) => (
          <div className="scheduled-trigger" key={trigger.id}>
            <button
              className="scheduled-row"
              type="button"
              onClick={() => onOpenThread(trigger.threadId)}
            >
              <span className={`trigger-kind ${trigger.kind}`}>
                {trigger.kind}
              </span>
              <div>
                <strong>{trigger.label}</strong>
                <small>{trigger.prompt}</small>
              </div>
              <time>
                {trigger.timer
                  ? new Date(trigger.timer.nextRunAt).toLocaleString()
                  : "Event driven"}
              </time>
            </button>
            <button
              className="scheduled-cancel"
              type="button"
              disabled={cancelPending.has(trigger.id)}
              onClick={() => void cancelTrigger(trigger.id)}
            >
              {cancelPending.has(trigger.id) ? "Cancelling…" : "Cancel"}
            </button>
            {cancelErrors[trigger.id] ? (
              <span className="form-error" role="alert">
                {cancelErrors[trigger.id]} · retry explicitly
              </span>
            ) : null}
          </div>
        ))}
        {active.length === 0 ? (
          <p className="scheduled-empty">
            No triggers are registered. Open a thread’s Trigger panel to create
            one.
          </p>
        ) : null}

        <h2>Rooms</h2>
        {snapshot.rooms.map((room) => (
          <button
            className="scheduled-row room-row"
            type="button"
            key={room.id}
            onClick={() => onOpenRoom(room.id)}
          >
            <span>#</span>
            <div>
              <strong>{room.name}</strong>
              <small>
                {room.members.map((member) => `@${member.name}`).join(" · ")}
              </small>
            </div>
            <time>{room.messages.length} messages</time>
          </button>
        ))}
        <div className="create-room">
          <strong>Create a multi-Agent Room</strong>
          <p>
            Add one or more unique member names and Threads before creating the
            shared routing surface.
          </p>
          <input
            aria-label="Room name"
            placeholder="release-42"
            value={roomName}
            onChange={(event) => setRoomName(event.target.value)}
          />
          <div className="room-member-editor">
            <input
              aria-label="Member name"
              placeholder="Monitor"
              value={memberName}
              onChange={(event) => setMemberName(event.target.value)}
            />
            <select
              aria-label="Member thread"
              value={selectedMemberThread}
              onChange={(event) => setMemberThread(event.target.value)}
            >
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.name ?? thread.preview ?? thread.id}
                </option>
              ))}
            </select>
            <button type="button" onClick={addMemberDraft}>
              Add member
            </button>
          </div>
          <div className="room-member-drafts">
            {roomMembers.map((member) => (
              <span key={member.threadId}>
                @{member.name}
                <button
                  type="button"
                  aria-label={`Remove ${member.name} from Room draft`}
                  onClick={() =>
                    setRoomMembers((current) =>
                      current.filter(
                        (entry) => entry.threadId !== member.threadId,
                      ),
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          {roomError ? (
            <p className="form-error" role="alert">
              {roomError}
            </p>
          ) : null}
          <button
            className="primary-button"
            type="button"
            disabled={
              roomPending || !roomName.trim() || roomMembers.length === 0
            }
            onClick={() => void createRoom()}
          >
            {roomPending ? "Creating…" : "Create Room"}
          </button>
        </div>

        <h2>Recent wakeups</h2>
        {snapshot.history.slice(0, 30).map((entry) => (
          <button
            className="history-row"
            type="button"
            key={entry.id}
            onClick={() => onOpenThread(entry.threadId)}
          >
            <time>{new Date(entry.startedAt).toLocaleString()}</time>
            <span>
              {entry.reason}
              {entry.sourceThreadId
                ? ` · relay ${entry.sourceThreadId.slice(0, 8)} / ${entry.sourceTurnId?.slice(0, 8)}`
                : ""}
            </span>
            <small className={entry.status}>{entry.status}</small>
          </button>
        ))}

        <div className="create-room signal-console">
          <strong>Developer signal simulator</strong>
          <p>
            This local UI invokes ZenX renderer IPC for testing. A production
            external ingress and Agent-callable trigger tools are follow-up
            work.
          </p>
          <div>
            <input
              aria-label="Signal name"
              placeholder="deploy.completed"
              value={signalName}
              onChange={(event) => setSignalName(event.target.value)}
            />
            <input
              aria-label="Signal detail"
              placeholder="release-42 passed"
              value={signalDetail}
              onChange={(event) => setSignalDetail(event.target.value)}
            />
            <button
              type="button"
              disabled={signalPending || !signalName.trim()}
              onClick={() => void sendSignal()}
            >
              {signalPending ? "Sending…" : "Simulate signal"}
            </button>
          </div>
          {signalError ? (
            <p className="form-error" role="alert">
              {signalError}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
