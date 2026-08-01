import { useEffect, useRef, useState } from "react";

import type { ApprovalDecision } from "../../main/app-server-manager.js";
import type { Thread, ThreadItem, Turn } from "../../protocol-client/index.js";
import type { ApprovalCardState } from "./approval-state";
import { Icon } from "./icons";
import { activeTurn } from "./thread-view-state";

interface ThreadViewProps {
  approvals: readonly ApprovalCardState[];
  thread: Thread;
  onInterrupt(turnId: string): Promise<void>;
  onRespondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  onStartTurn(text: string): Promise<void>;
}

export function ThreadView({
  approvals,
  thread,
  onInterrupt,
  onRespondToApproval,
  onStartTurn,
}: ThreadViewProps) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const runningTurn = activeTurn(thread);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll !== null) scroll.scrollTop = scroll.scrollHeight;
  }, [thread.turns]);

  const submit = async () => {
    const text = draft.trim();
    if (text.length === 0 || runningTurn !== null || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onStartTurn(text);
      setDraft("");
    } catch (requestError) {
      setError(describeError(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  const interrupt = async () => {
    if (runningTurn === null || interrupting) return;
    setInterrupting(true);
    setError(null);
    try {
      await onInterrupt(runningTurn.id);
    } catch (requestError) {
      setError(describeError(requestError));
    } finally {
      setInterrupting(false);
    }
  };

  return (
    <>
      <div className="messages" ref={scrollRef}>
        <div className="messages-inner">
          {thread.turns.length === 0 ? (
            <div className="thread-empty">
              <div className="empty-glyph" aria-hidden="true">
                <Icon name="thread" size={22} />
              </div>
              <h2>Ready for the first message</h2>
              <p>Send a prompt below to begin this thread.</p>
            </div>
          ) : (
            thread.turns.map((turn, index) => (
              <TurnBlock
                approvals={approvals.filter(
                  (approval) => approval.params.turnId === turn.id,
                )}
                index={index}
                key={turn.id}
                onRespondToApproval={onRespondToApproval}
                turn={turn}
              />
            ))
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            aria-label="Message"
            disabled={runningTurn !== null || submitting}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={
              runningTurn === null
                ? "Send a message…"
                : "Wait for the current turn to finish or interrupt it."
            }
            rows={1}
            value={draft}
          />
          <div className="composer-row">
            <span className={error === null ? undefined : "composer-error"}>
              {error ??
                (runningTurn === null
                  ? "Enter to send · Shift+Enter for a new line"
                  : "A thread can run only one turn at a time.")}
            </span>
            {runningTurn === null ? (
              <button
                className="send-button"
                type="button"
                disabled={draft.trim().length === 0 || submitting}
                onClick={() => void submit()}
              >
                {submitting ? "Starting…" : "Send"}
              </button>
            ) : (
              <button
                className="interrupt-button"
                type="button"
                disabled={interrupting}
                onClick={() => void interrupt()}
              >
                <Icon name="stop" size={12} />
                {interrupting ? "Stopping…" : "Interrupt"}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function TurnBlock({
  turn,
  index,
  approvals,
  onRespondToApproval,
}: {
  turn: Turn;
  index: number;
  approvals: readonly ApprovalCardState[];
  onRespondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
}) {
  return (
    <section
      className={`turn-block ${turn.status}`}
      aria-label={`Turn ${index + 1}`}
    >
      <div className="turn-boundary">
        <span>Turn {index + 1}</span>
        <span>{turnLabel(turn)}</span>
      </div>
      {turn.items.map((item) => (
        <div key={item.id}>
          <ItemView item={item} />
          {approvals
            .filter((approval) => approval.params.itemId === item.id)
            .map((approval) => (
              <ApprovalCard
                approval={approval}
                key={approval.requestId}
                onRespond={onRespondToApproval}
              />
            ))}
        </div>
      ))}
      {turn.error === null ? null : (
        <div className="turn-error" role="alert">
          {turn.error.message}
        </div>
      )}
    </section>
  );
}

function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: ApprovalCardState;
  onRespond(requestId: string, decision: ApprovalDecision): Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const respond = async (decision: "accept" | "decline") => {
    setError(null);
    try {
      await onRespond(approval.requestId, decision);
    } catch (requestError) {
      setError(describeError(requestError));
    }
  };
  return (
    <article className={`approval-card ${approval.status}`}>
      <header>
        <span className="approval-icon" aria-hidden="true">
          <Icon name="warning" size={14} />
        </span>
        <div>
          <strong>Command needs approval</strong>
          <span>Review what Zen is asking to run.</span>
        </div>
      </header>
      <dl>
        <div>
          <dt>Command</dt>
          <dd>
            <code>{approval.params.command}</code>
          </dd>
        </div>
        <div>
          <dt>Working directory</dt>
          <dd>{approval.params.cwd}</dd>
        </div>
      </dl>
      {error === null ? null : (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
      {approval.status === "pending" ? (
        <div className="approval-actions">
          <button
            className="approval-decline"
            type="button"
            onClick={() => void respond("decline")}
          >
            Do not run it
          </button>
          <button
            className="approval-accept"
            type="button"
            onClick={() => void respond("accept")}
          >
            Run this command
          </button>
        </div>
      ) : approval.status === "responding" ? (
        <p className="approval-result" aria-live="polite">
          Sending {approval.decision === "accept" ? "approval" : "refusal"}…
        </p>
      ) : (
        <p className={`approval-result ${approvalResultClass(approval)}`}>
          <Icon
            name={approval.decision === "accept" ? "check" : "warning"}
            size={13}
          />
          {approvalResultLabel(approval)}
        </p>
      )}
    </article>
  );
}

function approvalResultClass(approval: ApprovalCardState): string {
  return approval.decision === "accept" ||
    approval.decision === "acceptForSession"
    ? "accepted"
    : "not-run";
}

function approvalResultLabel(approval: ApprovalCardState): string {
  switch (approval.decision) {
    case "accept":
      return "Approved — the command may run.";
    case "acceptForSession":
      return "Approved for this session.";
    case "decline":
      return "Declined — the command was not run.";
    case "cancel":
    case null:
      return "Resolved without running the command.";
  }
}

function ItemView({ item }: { item: ThreadItem }) {
  if (item.type === "userMessage") {
    return (
      <article className="message-item user-message">
        <div className="message-author">
          <span className="avatar user-avatar">You</span>
          <strong>You</strong>
        </div>
        <div className="user-bubble">
          {item.content.map((content) => content.text).join("\n")}
        </div>
      </article>
    );
  }
  if (item.type === "agentMessage") {
    return (
      <article className="message-item agent-message">
        <div className="message-author">
          <span className="avatar agent-avatar">Z</span>
          <strong>Zen</strong>
        </div>
        <div className="agent-copy">
          {item.text}
          {item.text.length === 0 ? <span className="stream-cursor" /> : null}
        </div>
      </article>
    );
  }
  if (item.type === "reasoning") {
    return (
      <details className="reasoning-item">
        <summary>
          <Icon name="reasoning" size={13} /> Reasoning
        </summary>
        {item.summary.map((summary, index) => (
          <p key={index}>{summary}</p>
        ))}
      </details>
    );
  }
  return <CommandItemView item={item} />;
}

function CommandItemView({
  item,
}: {
  item: Extract<ThreadItem, { type: "commandExecution" }>;
}) {
  return (
    <article className={`command-item ${item.status}`}>
      <div className="command-heading">
        {item.status === "inProgress" ? (
          <span className="mini-spinner" />
        ) : (
          <Icon
            name={item.status === "completed" ? "check" : "warning"}
            size={13}
          />
        )}
        <strong>shell</strong>
        <code>{item.command}</code>
        <span>{commandStatus(item.status)}</span>
      </div>
      {item.aggregatedOutput === null ||
      item.aggregatedOutput.length === 0 ? null : (
        <pre>{item.aggregatedOutput}</pre>
      )}
    </article>
  );
}

function turnLabel(turn: Turn): string {
  switch (turn.status) {
    case "inProgress":
      return "Running";
    case "completed":
      return "Complete";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
  }
}

function commandStatus(
  status: Extract<ThreadItem, { type: "commandExecution" }>["status"],
): string {
  switch (status) {
    case "inProgress":
      return "Running";
    case "completed":
      return "Complete";
    case "failed":
      return "Failed";
    case "declined":
      return "Declined";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
