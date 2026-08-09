import { useEffect, useRef, useState } from "react";

import type { ApprovalDecision } from "../../main/app-server-manager.js";
import type { Thread, ThreadItem, Turn } from "../../protocol-client/index.js";
import type { ApprovalCardState } from "./approval-state.js";
import {
  defaultComposerIntent,
  type ComposerIntent,
  type ComposerState,
} from "./composer-state.js";
import { Icon } from "./icons.js";
import { Markdown } from "./Markdown.js";
import type { TriggerHistoryEntry } from "../../main/trigger-types.js";
import { activeTurn } from "./thread-view-state.js";

interface ThreadViewProps {
  approvals: readonly ApprovalCardState[];
  composer: ComposerState;
  thread: Thread;
  wakeups?: readonly TriggerHistoryEntry[];
  watching?: boolean;
  onDraftChange(draft: string): void;
  onInterrupt(turnId: string): Promise<void>;
  onRespondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  onSubmit(
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ): Promise<void>;
}

export function ThreadView({
  approvals,
  composer,
  thread,
  wakeups = [],
  watching = false,
  onDraftChange,
  onInterrupt,
  onRespondToApproval,
  onSubmit,
}: ThreadViewProps) {
  const [interrupting, setInterrupting] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const runningTurn = activeTurn(thread);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll !== null) scroll.scrollTop = scroll.scrollHeight;
  }, [thread.turns]);

  const submit = (intent: ComposerIntent) => {
    if (composer.draft.trim().length === 0 || isSubmitting(composer)) return;
    if (intent === "start" && runningTurn !== null) return;
    if (intent !== "start" && runningTurn === null) return;
    void onSubmit(intent, runningTurn?.id ?? null);
  };

  const interrupt = async () => {
    if (runningTurn === null || interrupting) return;
    setInterrupting(true);
    setInterruptError(null);
    try {
      await onInterrupt(runningTurn.id);
    } catch (requestError) {
      setInterruptError(describeError(requestError));
    } finally {
      setInterrupting(false);
    }
  };
  const pendingApproval =
    runningTurn !== null &&
    approvals.some(
      (approval) =>
        approval.params.turnId === runningTurn.id &&
        approval.status === "pending",
    );
  const submitting = isSubmitting(composer);

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
                wakeups={wakeups}
              />
            ))
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            aria-label="Message"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(defaultComposerIntent(runningTurn !== null));
              }
            }}
            placeholder={
              runningTurn === null
                ? watching
                  ? "Send a message to wake this thread…"
                  : "Send a message…"
                : "Steer the active turn…"
            }
            rows={1}
            value={composer.draft}
          />
          <div className="composer-row">
            <span
              className={
                composer.submission?.status === "failed" ||
                interruptError !== null
                  ? "composer-error"
                  : undefined
              }
              role={
                composer.submission?.status === "failed" ||
                interruptError !== null
                  ? "alert"
                  : undefined
              }
            >
              {composerStatus(
                composer,
                runningTurn !== null,
                pendingApproval,
                interruptError,
                watching,
              )}
            </span>
            {runningTurn === null ? (
              <button
                className="send-button"
                type="button"
                disabled={composer.draft.trim().length === 0 || submitting}
                onClick={() => submit("start")}
              >
                {submitting ? "Starting…" : "Send"}
              </button>
            ) : (
              <div className="active-turn-actions">
                <button
                  className="stop-button"
                  type="button"
                  aria-label="Interrupt without sending the draft"
                  disabled={interrupting || submitting}
                  onClick={() => void interrupt()}
                >
                  <Icon name="stop" size={12} />
                  {interrupting ? "Stopping…" : "Interrupt"}
                </button>
                <button
                  className="replace-button"
                  type="button"
                  aria-label="Interrupt the active turn and send this draft as a new turn"
                  disabled={composer.draft.trim().length === 0 || submitting}
                  onClick={() => submit("replace")}
                >
                  {submitting && composer.submission?.intent === "replace"
                    ? "Replacing…"
                    : "Interrupt & send"}
                </button>
                <button
                  className="send-button"
                  type="button"
                  aria-label="Steer the active turn with this message"
                  disabled={composer.draft.trim().length === 0 || submitting}
                  onClick={() => submit("steer")}
                >
                  {submitting && composer.submission?.intent === "steer"
                    ? "Steering…"
                    : "Steer now"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function isSubmitting(composer: ComposerState): boolean {
  return composer.submission?.status === "pending";
}

function composerStatus(
  composer: ComposerState,
  active: boolean,
  pendingApproval: boolean,
  interruptError: string | null,
  watching: boolean,
): string {
  if (interruptError !== null) return interruptError;
  if (composer.submission?.status === "failed") {
    return `${composer.submission.error ?? "Send failed"} Draft kept; retry uses the same message ID.`;
  }
  if (composer.submission?.status === "pending") {
    return composer.submission.intent === "replace"
      ? "Interrupting the current turn, then starting the replacement…"
      : composer.submission.intent === "steer"
        ? "Adding guidance to the current turn…"
        : "Starting a new turn…";
  }
  if (!active)
    return watching
      ? "A direct message wakes this thread; registered triggers stay active"
      : "Enter to send · Shift+Enter for a new line";
  if (pendingApproval) {
    return "Steering adds guidance but does not approve the pending command. Interrupt & send cancels it.";
  }
  return "Enter steers this turn · Interrupt stops only · Interrupt & send starts a replacement turn";
}

function TurnBlock({
  turn,
  index,
  approvals,
  onRespondToApproval,
  wakeups,
}: {
  turn: Turn;
  index: number;
  approvals: readonly ApprovalCardState[];
  onRespondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  wakeups: readonly TriggerHistoryEntry[];
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
          <ItemView
            item={item}
            wakeup={
              item.type === "userMessage"
                ? wakeups.find(
                    (entry) => entry.clientUserMessageId === item.clientId,
                  )
                : undefined
            }
          />
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

function ItemView({
  item,
  wakeup,
}: {
  item: ThreadItem;
  wakeup?: TriggerHistoryEntry;
}) {
  if (item.type === "userMessage") {
    if (wakeup !== undefined) {
      return (
        <article className={`wakeup-card ${wakeup.status}`}>
          <header>
            <Icon name="trigger" size={14} />
            <strong>Trigger wakeup</strong>
            <span>{kindLabel(wakeup.kind)}</span>
            <time>
              {new Date(wakeup.startedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </header>
          <p>{wakeup.reason}</p>
          <div>
            <span>Injected prompt</span>
            <Markdown text={wakeup.prompt} />
          </div>
          {wakeup.error ? <small>{wakeup.error}</small> : null}
        </article>
      );
    }
    return (
      <article className="message-item user-message">
        <div className="message-author">
          <span className="avatar user-avatar">You</span>
          <strong>You</strong>
        </div>
        <div className="user-bubble">
          <Markdown
            text={item.content.map((content) => content.text).join("\n")}
          />
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
          <Markdown text={item.text} />
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

function kindLabel(kind: TriggerHistoryEntry["kind"]): string {
  return {
    timer: "Timer",
    thread: "Thread event",
    roomMention: "Room mention",
    signal: "External signal",
  }[kind];
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
