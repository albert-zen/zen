import { useState } from "react";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { RoomMember, TriggerSnapshot } from "../../main/trigger-types.js";
import { Icon } from "./icons.js";
import { Markdown } from "./Markdown.js";
import { threadTitle } from "./thread-list.js";

export function RoomView({
  roomId,
  snapshot,
  threads,
  onOpenThread,
  onSelectRoom,
  onOpenSidebar,
}: {
  roomId: string | null;
  snapshot: TriggerSnapshot;
  threads: readonly NativeThreadSummary[];
  onOpenThread(id: string): void;
  onSelectRoom(id: string | null): void;
  onOpenSidebar?(): void;
}) {
  const room = snapshot.rooms.find((item) => item.id === roomId);
  if (room === undefined) {
    return (
      <RoomsOverview
        snapshot={snapshot}
        threads={threads}
        onOpenSidebar={onOpenSidebar}
        onSelectRoom={onSelectRoom}
      />
    );
  }
  return (
    <ActiveRoom
      room={room}
      threads={threads}
      onBack={() => onSelectRoom(null)}
      onOpenSidebar={onOpenSidebar}
      onOpenThread={onOpenThread}
    />
  );
}

function RoomsOverview({
  snapshot,
  threads,
  onSelectRoom,
  onOpenSidebar,
}: {
  snapshot: TriggerSnapshot;
  threads: readonly NativeThreadSummary[];
  onSelectRoom(id: string): void;
  onOpenSidebar?(): void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberThreadId, setMemberThreadId] = useState(
    threads.find((thread) => thread.status !== "systemError")?.threadId ?? "",
  );
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addMember = () => {
    const next = { name: memberName.trim(), threadId: memberThreadId };
    if (!next.name || !next.threadId) return;
    if (
      members.some(
        (member) =>
          member.threadId === next.threadId ||
          member.name.toLocaleLowerCase() === next.name.toLocaleLowerCase(),
      )
    ) {
      setError("Member names and Threads must be unique within a Room.");
      return;
    }
    setMembers((current) => [...current, next]);
    setMemberName("");
    setError(null);
  };
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.zenx.triggers.createRoom({ name, members });
      const created = next.rooms.find(
        (room) => room.name === name.trim() && room.members.length === members.length,
      );
      setName("");
      setMembers([]);
      setCreating(false);
      if (created !== undefined) onSelectRoom(created.id);
    } catch (reason) {
      setError(`${describeError(reason)} Draft and members were kept.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="product-page rooms-overview">
      <header className="page-header">
        <div className="page-title">
          <button className="icon-button mobile-menu" type="button" aria-label="Open sidebar" onClick={onOpenSidebar}><Icon name="tree" /></button>
          <div><h1>Rooms</h1><p>Shared conclusions and bounded routing</p></div>
        </div>
        <button className="primary-button" type="button" onClick={() => setCreating((value) => !value)}><Icon name="compose" size={14} />New Room</button>
      </header>
      <div className="page-scroll">
        <div className="page-intro"><div><h2>Coordinate without merging contexts.</h2><p>A Room carries shared conclusions and routes explicit @mentions into ordinary member Turns. Reasoning and tools stay in the source Thread.</p></div></div>
        {creating ? <div className="page-card room-create-card"><div className="form-grid"><label className="field wide"><span>Room name</span><input value={name} placeholder="release-review" onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>Member name</span><input value={memberName} placeholder="Reviewer" onChange={(event) => setMemberName(event.target.value)} /></label><label className="field"><span>Member Thread</span><select value={memberThreadId} onChange={(event) => setMemberThreadId(event.target.value)}>{threads.filter((thread) => thread.status !== "systemError").map((thread) => <option key={thread.threadId} value={thread.threadId}>{threadTitle(thread)}</option>)}</select></label></div><button type="button" onClick={addMember}>Add member</button><div className="member-drafts">{members.map((member) => <span key={member.threadId}>@{member.name}<button type="button" aria-label={`Remove ${member.name}`} onClick={() => setMembers((current) => current.filter((item) => item.threadId !== member.threadId))}>×</button></span>)}</div>{error ? <p className="form-error" role="alert">{error}</p> : null}<div className="form-actions"><button type="button" onClick={() => setCreating(false)}>Cancel</button><button className="primary-button" type="button" disabled={busy || !name.trim() || members.length === 0} onClick={() => void create()}>{busy ? "Creating…" : "Create Room"}</button></div></div> : null}
        <div className="section-heading"><h2>Your Rooms</h2><span>{snapshot.rooms.length} local</span></div>
        <div className="room-grid">{snapshot.rooms.length === 0 ? <div className="page-card page-empty">No Rooms yet. Create one and bind named members to existing Threads.</div> : snapshot.rooms.map((room) => <button className="page-card room-card" type="button" key={room.id} onClick={() => onSelectRoom(room.id)}><div><Icon name="users" /><strong># {room.name}</strong></div><p>{room.members.map((member) => `@${member.name}`).join(" · ") || "No members"}</p><span>{room.messages.length} messages</span></button>)}</div>
      </div>
    </section>
  );
}

function ActiveRoom({ room, threads, onBack, onOpenThread, onOpenSidebar }: { room: TriggerSnapshot["rooms"][number]; threads: readonly NativeThreadSummary[]; onBack(): void; onOpenThread(id: string): void; onOpenSidebar?(): void }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [memberName, setMemberName] = useState("");
  const availableThreads = threads.filter((thread) => thread.status !== "systemError" && !room.members.some((member) => member.threadId === thread.threadId));
  const [memberThread, setMemberThread] = useState(availableThreads[0]?.threadId ?? "");
  const [memberPending, setMemberPending] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const selectedMemberThread = availableThreads.some((thread) => thread.threadId === memberThread) ? memberThread : (availableThreads[0]?.threadId ?? "");
  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true); setSendError(null);
    try { await window.zenx.triggers.postRoomMessage(room.id, "You", draft.trim()); setDraft(""); }
    catch (reason) { setSendError(`${describeError(reason)} Draft was kept; retry explicitly.`); }
    finally { setSending(false); }
  };
  const addMember = async () => {
    if (!memberName.trim() || !selectedMemberThread) return;
    setMemberPending("add"); setMemberError(null);
    try { await window.zenx.triggers.addRoomMember(room.id, { name: memberName, threadId: selectedMemberThread }); setMemberName(""); }
    catch (reason) { setMemberError(`${describeError(reason)} Member draft was kept.`); }
    finally { setMemberPending(null); }
  };
  return (
    <section className="product-page active-room">
      <header className="page-header"><div className="page-title"><button className="icon-button mobile-menu" type="button" aria-label="Open sidebar" onClick={onOpenSidebar}><Icon name="tree" /></button><button className="quiet-button room-back" type="button" onClick={onBack}>Rooms</button><div><h1># {room.name}</h1><p>Shared conclusions and bounded routing</p></div></div></header>
      <div className="room-context"><p>Reasoning stays in each member Thread. @mentions create a normal new Turn for that member.</p><div className="room-members">{room.members.map((member) => <span key={member.threadId}>@{member.name}<button type="button" aria-label={`Remove ${member.name}`} disabled={memberPending !== null} onClick={() => { setMemberPending(member.threadId); setMemberError(null); void window.zenx.triggers.removeRoomMember(room.id, member.threadId).catch((reason: unknown) => setMemberError(describeError(reason))).finally(() => setMemberPending(null)); }}>×</button></span>)}</div></div>
      <div className="room-member-manager"><input aria-label="New member name" placeholder="Reviewer" value={memberName} onChange={(event) => setMemberName(event.target.value)} /><select aria-label="New member Thread" value={selectedMemberThread} onChange={(event) => setMemberThread(event.target.value)}>{availableThreads.map((thread) => <option key={thread.threadId} value={thread.threadId}>{threadTitle(thread)}</option>)}</select><button type="button" disabled={memberPending !== null || !memberName.trim() || !selectedMemberThread} onClick={() => void addMember()}>{memberPending === "add" ? "Adding…" : "Add member"}</button>{memberError ? <span className="form-error" role="alert">{memberError}</span> : null}</div>
      <div className="room-feed"><div className="room-note"><strong>Room ≠ Thread.</strong> This surface carries concise conclusions and routing context. Tool calls and private reasoning remain in each source Thread.</div>{room.messages.map((message) => message.kind === "system" ? <div className="room-system" key={message.id}>{message.text}</div> : <article className="room-message" key={message.id}><header><strong>{message.author}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header><Markdown text={message.text} />{message.originThreadId ? <button className="origin-card" type="button" onClick={() => onOpenThread(message.originThreadId!)}><Icon name="file" />Source Thread · Turn {message.originTurnId?.slice(0, 8)}<span>Open →</span></button> : null}</article>)}</div>
      <div className="room-composer"><textarea rows={1} aria-label="Room message" placeholder="Message the Room… use @name to wake a member" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} /><button className="primary-button" type="button" disabled={sending || !draft.trim()} onClick={() => void send()}>{sending ? "Sending…" : "Send"}</button>{sendError ? <span className="form-error" role="alert">{sendError}</span> : null}</div>
    </section>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
