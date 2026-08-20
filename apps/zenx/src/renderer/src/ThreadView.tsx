import { useEffect, useMemo, useRef, useState } from "react";

import type { ApprovalDecision } from "../../main/app-server-manager.js";
import type { TriggerHistoryEntry } from "../../main/trigger-types.js";
import type {
  ModelSummary,
  Thread,
  ThreadItem,
  Turn,
} from "../../protocol-client/index.js";
import type { ApprovalCardState } from "./approval-state.js";
import type { ComposerIntent, ComposerState } from "./composer-state.js";
import { Icon } from "./icons.js";
import { Markdown } from "./Markdown.js";
import { modelOptions } from "./model-settings.js";
import { activeTurn } from "./thread-view-state.js";
import {
  commandLabel,
  projectTurn,
  type TurnDisplayNode,
} from "./turn-projection.js";

interface ThreadViewProps {
  approvals: readonly ApprovalCardState[];
  composer: ComposerState;
  composerDisabled?: boolean;
  modelDisabled?: boolean;
  modelError?: string | null;
  models?: readonly ModelSummary[];
  permissionLabel?: string;
  selectedModel?: string;
  switchingModel?: boolean;
  thread: Thread;
  wakeups?: readonly TriggerHistoryEntry[];
  watching?: boolean;
  onDraftChange(draft: string): void;
  onInterrupt(turnId: string): Promise<void>;
  onModelChange?(model: string): void;
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
  composerDisabled = false,
  modelDisabled = false,
  modelError = null,
  models = [],
  permissionLabel = "Full access",
  selectedModel,
  switchingModel = false,
  thread,
  wakeups = [],
  watching = false,
  onDraftChange,
  onInterrupt,
  onModelChange,
  onRespondToApproval,
  onSubmit,
}: ThreadViewProps) {
  const [interrupting, setInterrupting] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [atLive, setAtLive] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const runningTurn = activeTurn(thread);
  const pendingApprovals = approvals.filter(
    (approval) => approval.status === "pending",
  );
  const submitting = composer.submission?.status === "pending";
  const draft = composer.draft.trim();

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll !== null && shouldFollowRef.current) {
      scroll.scrollTop = scroll.scrollHeight;
      setAtLive(true);
    }
  }, [thread.turns, approvals]);

  const submit = (intent: ComposerIntent) => {
    if (composerDisabled || draft.length === 0 || submitting) return;
    if (intent === "start" && runningTurn !== null) return;
    if (intent !== "start" && runningTurn === null) return;
    void onSubmit(intent, runningTurn?.id ?? null);
  };

  const interrupt = async () => {
    if (composerDisabled || runningTurn === null || interrupting || submitting)
      return;
    setInterrupting(true);
    setInterruptError(null);
    try {
      await onInterrupt(runningTurn.id);
    } catch (error) {
      setInterruptError(describeError(error));
    } finally {
      setInterrupting(false);
    }
  };

  const primaryMode =
    runningTurn === null ? "send" : draft.length === 0 ? "stop" : "replace";
  const primaryLabel =
    primaryMode === "send"
      ? "Send"
      : primaryMode === "stop"
        ? "Stop"
        : "Interrupt and send";
  const primary = () => {
    if (primaryMode === "stop") void interrupt();
    else submit(primaryMode === "replace" ? "replace" : "start");
  };

  return (
    <div className="thread-view">
      <div
        className="messages"
        ref={scrollRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          const live =
            target.scrollHeight - target.scrollTop - target.clientHeight < 80;
          shouldFollowRef.current = live;
          setAtLive(live);
        }}
      >
        <div className="messages-inner">
          {thread.turns.length === 0 ? (
            <div className="thread-empty">
              <div className="empty-glyph" aria-hidden="true">
                <Icon name="compose" size={20} />
              </div>
              <h2>Start a new thread</h2>
              <p>
                Describe the outcome you want. ZenX will use this Thread’s
                workspace, model, and permission policy.
              </p>
            </div>
          ) : (
            thread.turns.map((turn, index) => (
              <TurnBlock
                index={index}
                key={turn.id}
                turn={turn}
                wakeups={wakeups}
              />
            ))
          )}
        </div>
      </div>

      {atLive ? null : (
        <button
          className="back-live"
          type="button"
          onClick={() => {
            const scroll = scrollRef.current;
            if (scroll === null) return;
            shouldFollowRef.current = true;
            scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
            setAtLive(true);
          }}
        >
          <Icon name="arrow-down" size={14} />
          Back to live
        </button>
      )}

      <div className="bottom-zone">
        {pendingApprovals.map((approval) => (
          <ApprovalBar
            approval={approval}
            key={approval.requestId}
            onRespond={onRespondToApproval}
          />
        ))}
        <div className="composer">
          <label className="sr-only" htmlFor="thread-composer">
            Message ZenX
          </label>
          <textarea
            id="thread-composer"
            aria-label="Message"
            disabled={composerDisabled}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              submit(runningTurn === null ? "start" : "steer");
            }}
            placeholder={
              runningTurn === null
                ? watching
                  ? "Send a message to wake this thread…"
                  : "Ask ZenX anything…"
                : "Steer the current run…"
            }
            rows={1}
            value={composer.draft}
          />
          <div className="composer-rail">
            <div className="composer-tools">
              <button
                className="composer-tool icon-only"
                type="button"
                aria-label="Attachments are not available in this build"
                disabled
              >
                <Icon name="paperclip" />
              </button>
              {selectedModel === undefined ? null : (
                <label className="composer-model">
                  <span className="provider-mark generic" aria-hidden="true">
                    ◇
                  </span>
                  <span className="sr-only">Thread model</span>
                  <select
                    aria-describedby={
                      modelError === null ? undefined : "composer-model-error"
                    }
                    disabled={
                      composerDisabled || modelDisabled || switchingModel
                    }
                    onChange={(event) => onModelChange?.(event.target.value)}
                    value={selectedModel}
                  >
                    {modelOptions(models, selectedModel).map((model) => (
                      <option
                        disabled={model.unavailable}
                        key={model.id}
                        value={model.id}
                      >
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                className="composer-tool permission-control"
                type="button"
                aria-label={`Permission policy: ${permissionLabel}`}
                disabled
              >
                <Icon name="lock" size={14} />
                <span>{permissionLabel}</span>
              </button>
            </div>
            <div className="composer-actions">
              {runningTurn !== null && draft.length > 0 ? (
                <button
                  className="steer-button"
                  type="button"
                  disabled={composerDisabled || submitting}
                  onClick={() => submit("steer")}
                >
                  {submitting && composer.submission?.intent === "steer"
                    ? "Steering…"
                    : "Steer"}
                </button>
              ) : null}
              <button
                className={`action-orb ${primaryMode}`}
                type="button"
                aria-label={primaryLabel}
                title={primaryLabel}
                disabled={
                  composerDisabled ||
                  interrupting ||
                  submitting ||
                  (primaryMode === "send" && draft.length === 0)
                }
                onClick={primary}
              >
                <Icon
                  name={primaryMode === "stop" ? "stop" : "send"}
                  size={18}
                />
              </button>
            </div>
          </div>
          {composer.submission?.status === "failed" ||
          interruptError !== null ||
          modelError !== null ? (
            <p className="composer-error" role="alert">
              {interruptError ?? composer.submission?.error ?? modelError}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TurnBlock({
  turn,
  index,
  wakeups,
}: {
  turn: Turn;
  index: number;
  wakeups: readonly TriggerHistoryEntry[];
}) {
  const projection = useMemo(() => projectTurn(turn), [turn]);
  const [expanded, setExpanded] = useState(false);
  const complete = turn.status !== "inProgress";
  return (
    <section className={`turn ${turn.status}`} aria-label={`Turn ${index + 1}`}>
      {projection.userItems.map((item) => {
        const wakeup = wakeups.find(
          (entry) => entry.clientUserMessageId === item.clientId,
        );
        return wakeup === undefined ? (
          <UserMessage item={item} key={item.id} />
        ) : (
          <WakeupCard entry={wakeup} key={item.id} />
        );
      })}
      {complete ? (
        <button
          className="turn-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{completedTurnLabel(turn)}</span>
          <Icon name="chevron-down" size={14} />
        </button>
      ) : (
        <div className="turn-running-label" aria-live="polite">
          <span className="mini-spinner" aria-hidden="true" />
          <span>Working</span>
        </div>
      )}
      {!complete || expanded ? (
        <div className="turn-history">
          {projection.history.map((node) => (
            <DisplayNode
              key={node.kind === "agent" ? node.item.id : node.id}
              node={node}
            />
          ))}
          {!complete && projection.finalItem !== null ? (
            <AgentMessage item={projection.finalItem} />
          ) : null}
        </div>
      ) : null}
      {complete && projection.finalItem !== null ? (
        <div className="turn-final">
          <AgentMessage item={projection.finalItem} />
        </div>
      ) : projection.terminalFallback === null ? null : (
        <div className="turn-terminal" role="status">
          {projection.terminalFallback}
        </div>
      )}
    </section>
  );
}

function DisplayNode({ node }: { node: TurnDisplayNode }) {
  return node.kind === "agent" ? (
    <AgentMessage item={node.item} />
  ) : (
    <TraceGroup node={node} />
  );
}

function TraceGroup({
  node,
}: {
  node: Extract<TurnDisplayNode, { kind: "trace" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  return (
    <section className="trace-group">
      <button
        className="trace-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((value) => !value);
          if (expanded) setOpenItems(new Set());
        }}
      >
        <Icon name="layers" size={15} />
        <span>{node.summary}</span>
        <small>{node.items.length} items</small>
        <Icon name="chevron-down" size={13} />
      </button>
      {expanded ? (
        <div className="trace-items">
          {node.items.map((item) => {
            const open = openItems.has(item.id);
            return (
              <div className="trace-item" key={item.id}>
                <button
                  className="trace-item-toggle"
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setOpenItems((current) => {
                      const next = new Set(current);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    })
                  }
                >
                  <Icon
                    name={item.type === "reasoning" ? "reasoning" : "terminal"}
                    size={14}
                  />
                  <strong>
                    {item.type === "reasoning" ? "Think" : "Tool"}
                  </strong>
                  <span>{traceItemLabel(item)}</span>
                  <StatusMark item={item} />
                  <Icon name="chevron-down" size={13} />
                </button>
                {open ? <TraceDetail item={item} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function StatusMark({ item }: { item: ThreadItem }) {
  if (item.type !== "commandExecution") return null;
  return item.status === "inProgress" ? (
    <span className="mini-spinner" aria-label="Running" />
  ) : (
    <small className={`tool-status ${item.status}`}>
      {commandStatus(item.status)}
    </small>
  );
}

function TraceDetail({ item }: { item: ThreadItem }) {
  if (item.type === "reasoning") {
    return (
      <div className="trace-detail">
        {item.summary.length === 0
          ? "No reasoning summary was provided."
          : item.summary.join("\n")}
      </div>
    );
  }
  if (item.type !== "commandExecution") return null;
  return (
    <div className="trace-detail">
      <code>{item.command}</code>
      {item.aggregatedOutput ? <pre>{item.aggregatedOutput}</pre> : null}
      {item.exitCode === null ? null : <small>Exit code {item.exitCode}</small>}
    </div>
  );
}

function UserMessage({
  item,
}: {
  item: Extract<ThreadItem, { type: "userMessage" }>;
}) {
  return (
    <article className="user-row">
      <div className="user-bubble">
        <Markdown
          text={item.content.map((content) => content.text).join("\n")}
        />
      </div>
    </article>
  );
}

function AgentMessage({
  item,
}: {
  item: Extract<ThreadItem, { type: "agentMessage" }>;
}) {
  return (
    <article className="agent-copy">
      <Markdown text={item.text} />
      {item.text.length === 0 ? <span className="stream-cursor" /> : null}
    </article>
  );
}

function WakeupCard({ entry }: { entry: TriggerHistoryEntry }) {
  return (
    <article className={`wakeup-card ${entry.status}`}>
      <header>
        <Icon name="trigger" size={14} />
        <strong>Trigger wakeup</strong>
        <span>{entry.kind}</span>
      </header>
      <p>{entry.reason}</p>
      <Markdown text={entry.prompt} />
      {entry.error ? <small>{entry.error}</small> : null}
    </article>
  );
}

function ApprovalBar({
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
    } catch (reason) {
      setError(describeError(reason));
    }
  };
  return (
    <div className="approval-bar">
      <span className="approval-icon" aria-hidden="true">
        <Icon name="warning" size={15} />
      </span>
      <div>
        <strong>Allow this command for the current step?</strong>
        <span title={approval.params.command}>{approval.params.command}</span>
        {error ? <small role="alert">{error}</small> : null}
      </div>
      <div className="approval-actions">
        <button type="button" onClick={() => void respond("decline")}>
          Deny
        </button>
        <button
          className="allow"
          type="button"
          onClick={() => void respond("accept")}
        >
          Allow once
        </button>
      </div>
    </div>
  );
}

function traceItemLabel(item: ThreadItem): string {
  if (item.type === "reasoning") {
    return item.summary[0] ?? "Reasoning details";
  }
  return item.type === "commandExecution"
    ? commandLabel(item.command)
    : "Item details";
}

function completedTurnLabel(turn: Turn): string {
  const duration = turn.durationMs;
  const result =
    turn.status === "completed"
      ? "Worked"
      : turn.status === "interrupted"
        ? "Interrupted"
        : "Failed";
  if (duration === null) return result;
  return `${result} for ${formatDuration(duration)}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function commandStatus(
  status: Extract<ThreadItem, { type: "commandExecution" }>["status"],
): string {
  return {
    inProgress: "Running",
    completed: "Done",
    failed: "Failed",
    declined: "Declined",
  }[status];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
