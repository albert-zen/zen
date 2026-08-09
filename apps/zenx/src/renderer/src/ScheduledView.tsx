import { useState } from "react";
import type { Thread } from "../../protocol-client/index.js";
import type { TriggerSnapshot } from "../../main/trigger-types.js";

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
  const [signalName, setSignalName] = useState("");
  const [signalDetail, setSignalDetail] = useState("");
  const active = snapshot.triggers.filter((trigger) => trigger.active);
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
          <button
            className="scheduled-row"
            type="button"
            key={trigger.id}
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
          <strong>Create a Room</strong>
          <p>
            A Room is shared transcription and routing, never an Agent Thread.
          </p>
          <div>
            <input
              aria-label="Room name"
              placeholder="release-42"
              value={roomName}
              onChange={(event) => setRoomName(event.target.value)}
            />
            <input
              aria-label="Member name"
              placeholder="Monitor"
              value={memberName}
              onChange={(event) => setMemberName(event.target.value)}
            />
            <select
              aria-label="Member thread"
              value={memberThread}
              onChange={(event) => setMemberThread(event.target.value)}
            >
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.name ?? thread.preview ?? thread.id}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() =>
                void window.zenx.triggers
                  .createRoom({
                    name: roomName,
                    members: [{ name: memberName, threadId: memberThread }],
                  })
                  .then(() => setRoomName(""))
              }
            >
              Create
            </button>
          </div>
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
            <span>{entry.reason}</span>
            <small className={entry.status}>{entry.status}</small>
          </button>
        ))}
        <div className="create-room signal-console">
          <strong>External signal</strong>
          <p>
            Deliver a named, auditable event to every matching signal trigger.
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
              disabled={!signalName.trim()}
              onClick={() =>
                void window.zenx.triggers
                  .signal(signalName, signalDetail)
                  .then(() => {
                    setSignalName("");
                    setSignalDetail("");
                  })
              }
            >
              Send signal
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
