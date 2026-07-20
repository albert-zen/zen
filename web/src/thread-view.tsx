import * as React from 'react';
import { Archive, CornerUpRight, Send, Square } from 'lucide-react';

import type {
  ApprovalPendingTimelineRow,
  TimelineRow,
  ToolCallTimelineRow,
  WebUiConnectionState,
  WebUiState,
  WorkspaceThread,
} from '#zen/presentation';
import type { ApprovalDecision, ProjectSnapshot, ThreadSnapshot } from '#zen/product';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';

export function ThreadView(props: {
  connection: WebUiConnectionState;
  project?: ProjectSnapshot;
  thread?: ThreadSnapshot;
  summary?: WorkspaceThread;
  state: WebUiState;
  providerAuthenticated?: boolean;
  onOpenProvider?: () => void;
  onResolveApproval?: (
    approval: { readonly approvalId: string; readonly threadId: string; readonly turnId: string },
    decision: ApprovalDecision
  ) => Promise<void>;
  onSend: (input: string, operationKey: string) => Promise<void>;
  onInterrupt: (operationKey: string) => Promise<void>;
  onArchive: () => void;
  onHandoff: () => void;
}): React.ReactElement {
  const [input, setInput] = React.useState('');
  const [sendOperationKey, setSendOperationKey] = React.useState(() =>
    nextOperationKey('turn-start')
  );
  const [interruptOperationKey, setInterruptOperationKey] = React.useState(() =>
    nextOperationKey('turn-interrupt')
  );
  const [sending, setSending] = React.useState(false);
  const [interrupting, setInterrupting] = React.useState(false);
  const [interruptedTurnId, setInterruptedTurnId] = React.useState<string>();
  const [sendError, setSendError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const readOnly = props.summary?.status === 'archived';
  const enabled =
    !!props.thread &&
    !readOnly &&
    !sending &&
    ['connected', 'running', 'failed'].includes(props.connection.status);
  const rows = [...props.state.timelineRows].filter((row) => row.type !== 'trace');
  const status = props.summary?.status ?? (props.thread ? props.connection.status : 'ready');
  const model =
    props.summary?.modelProfile ?? props.project?.policy.defaultModelProfile ?? 'provider default';
  const latestTurn = props.thread?.turns.at(-1);
  const canInterrupt =
    latestTurn?.id !== interruptedTurnId &&
    (latestTurn?.status === 'queued' || latestTurn?.status === 'inProgress');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    setSending(true);
    setSendError('');
    try {
      await props.onSend(value, sendOperationKey);
      setInput('');
      setSendOperationKey(nextOperationKey('turn-start'));
    } catch (cause) {
      setSendError(readError(cause));
    } finally {
      setSending(false);
    }
  };
  const interrupt = async () => {
    if (!canInterrupt || interrupting) return;
    setInterrupting(true);
    setActionError('');
    try {
      await props.onInterrupt(interruptOperationKey);
      setInterruptedTurnId(latestTurn?.id);
      setInterruptOperationKey(nextOperationKey('turn-interrupt'));
    } catch (cause) {
      setActionError(readError(cause));
    } finally {
      setInterrupting(false);
    }
  };
  return (
    <main className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-zinc-950">
      <header className="flex min-w-0 items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold">
            {props.summary?.objective ?? props.thread?.id ?? 'Select a thread'}
          </h1>
          <p className="truncate text-xs text-zinc-400">
            {props.summary
              ? `${status} · ${model}${props.summary.parentThreadId ? ` · child thread` : ''}`
              : props.project
                ? 'Choose a thread or start a new one'
                : 'No active project'}
          </p>
        </div>
        {props.thread ? (
          <div className="flex shrink-0 gap-1">
            <Button
              aria-label="Handoff thread"
              title="Handoff thread"
              size="icon"
              variant="subtle"
              disabled={readOnly}
              onClick={props.onHandoff}
            >
              <CornerUpRight className="h-4 w-4" />
            </Button>
            <Button
              aria-label="Interrupt current Turn"
              title="Interrupt current Turn"
              size="icon"
              variant="subtle"
              disabled={!canInterrupt || interrupting}
              onClick={() => void interrupt()}
            >
              <Square className="h-4 w-4" />
            </Button>
            <Button
              aria-label="Archive thread"
              title="Archive thread"
              size="icon"
              variant="subtle"
              disabled={readOnly}
              onClick={props.onArchive}
            >
              <Archive className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </header>
      <div>
        {actionError ? (
          <div
            role="alert"
            className="border-b border-rose-900 bg-rose-950/40 px-5 py-2 text-xs text-rose-200"
          >
            {actionError}
          </div>
        ) : null}
        {props.thread && status === 'running' ? (
          <div className="flex items-center gap-2 border-b border-teal-900/70 bg-teal-950/30 px-5 py-2 text-xs text-teal-200">
            <span className="h-2 w-2 animate-pulse rounded-full bg-teal-300" aria-hidden />
            Agent is working on this Turn.
          </div>
        ) : null}
        {props.thread && status === 'queued' ? (
          <div className="border-b border-amber-900/70 bg-amber-950/20 px-5 py-2 text-xs text-amber-200">
            Turn queued for an available execution slot.
          </div>
        ) : null}
      </div>
      <section aria-live="polite" className="min-h-0 overflow-auto px-5 py-5">
        <div className="mx-auto grid w-full max-w-4xl gap-4">
          {rows.length ? (
            rows.map((row) => (
              <TimelineEntry
                key={`${row.itemId}:${row.type}`}
                row={row}
                toolCall={findApprovalToolCall(row, rows)}
                onResolveApproval={props.onResolveApproval}
              />
            ))
          ) : (
            <div className="mx-auto grid max-w-md gap-2 py-20 text-center">
              <div className="text-sm font-semibold text-zinc-300">
                {emptyTitle(props.thread, status)}
              </div>
              <div className="text-sm leading-6 text-zinc-500">
                {emptyBody(props.thread, status)}
              </div>
              {!props.thread && !props.providerAuthenticated ? (
                <div className="mt-3 grid gap-2 rounded-md border border-amber-900/70 bg-amber-950/20 p-3 text-left">
                  <div className="text-sm font-semibold text-amber-100">
                    Connect ChatGPT to run agent Turns
                  </div>
                  <div className="text-xs leading-5 text-amber-200/70">
                    Projects and existing thread history remain available.
                  </div>
                  <Button type="button" variant="ghost" onClick={props.onOpenProvider}>
                    Set up provider
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
      <div className="border-t border-zinc-800 px-5 py-3">
        {readOnly ? (
          <div className="mx-auto mb-2 w-full max-w-4xl text-xs font-medium text-zinc-400">
            Archived history is read-only.
          </div>
        ) : null}
        <form
          onSubmit={(event) => void submit(event)}
          className="mx-auto grid w-full max-w-4xl grid-cols-[minmax(0,1fr)_auto] items-end gap-2"
        >
          <Textarea
            aria-label="Message selected thread"
            rows={2}
            value={input}
            disabled={!enabled}
            placeholder={
              readOnly
                ? 'Archived thread is read-only'
                : props.thread
                  ? props.connection.status === 'running'
                    ? 'Queue another Turn'
                    : 'Message this thread'
                  : 'Select a thread'
            }
            onChange={(event) => {
              const next = event.target.value;
              if (next.trim() !== input.trim()) {
                setSendOperationKey(nextOperationKey('turn-start'));
              }
              setInput(next);
              setSendError('');
            }}
          />
          <Button type="submit" variant="primary" disabled={!enabled || !input.trim()}>
            <Send className="h-4 w-4" />
            {sending ? 'Sending...' : 'Send'}
          </Button>
        </form>
        {sendError ? (
          <div role="alert" className="mx-auto mt-2 w-full max-w-4xl text-xs text-rose-300">
            {sendError}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function emptyTitle(thread: ThreadSnapshot | undefined, status: string): string {
  if (!thread) return 'No thread selected';
  if (status === 'running') return 'Agent is working';
  if (status === 'queued') return 'Turn is queued';
  if (status === 'waiting') return 'Waiting on another thread';
  if (status === 'blocked') return 'Thread is blocked';
  return 'Ready for the first Turn';
}

function emptyBody(thread: ThreadSnapshot | undefined, status: string): string {
  if (!thread) return 'Select a thread from the sidebar or start a new one.';
  if (status === 'running') return 'New Item activity will appear as the Turn progresses.';
  if (status === 'queued') return 'The scheduler will start this Turn when capacity is available.';
  if (status === 'waiting') return 'This Turn will resume when its dependency is resolved.';
  if (status === 'blocked') return 'Review the latest coordination activity before retrying.';
  return 'Your prompt will appear here as durable Item activity.';
}

function TimelineEntry(props: {
  row: TimelineRow;
  toolCall?: ToolCallTimelineRow;
  onResolveApproval?: (
    approval: { readonly approvalId: string; readonly threadId: string; readonly turnId: string },
    decision: ApprovalDecision
  ) => Promise<void>;
}): React.ReactElement {
  const { row } = props;
  if (row.type === 'approval-pending') {
    return (
      <ApprovalPanel row={row} toolCall={props.toolCall} onResolve={props.onResolveApproval} />
    );
  }
  if (row.type === 'approval-resolved') {
    return (
      <article className="flex items-center justify-between gap-3 border-l-2 border-zinc-700 py-1 pl-3 text-sm">
        <span className="text-zinc-400">Approval resolved</span>
        <span className="font-medium text-zinc-200">
          {row.decision === 'approveOnce'
            ? 'Approved once'
            : row.decision === 'decline'
              ? 'Declined'
              : 'Resolved'}
        </span>
      </article>
    );
  }
  const label =
    row.type === 'assistant' || row.type === 'assistant-progress'
      ? 'Agent'
      : row.type === 'user'
        ? 'Human'
        : row.type.replaceAll('-', ' ');
  const content =
    'content' in row ? row.content : row.type === 'trace' ? row.event : JSON.stringify(row);
  return (
    <article
      className={
        row.type === 'user'
          ? 'justify-self-end rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2'
          : 'max-w-full border-l-2 border-teal-500/70 pl-3'
      }
    >
      <div className="mb-1 text-xs font-semibold uppercase text-zinc-500">{label}</div>
      <div className="whitespace-pre-wrap break-words text-sm leading-6 text-zinc-200">
        {typeof content === 'string' ? content : JSON.stringify(content)}
      </div>
      {'sourceThreadId' in row || 'targetThreadId' in row ? (
        <div className="mt-2 text-xs text-zinc-500">source/target coordination</div>
      ) : null}
    </article>
  );
}

function ApprovalPanel(props: {
  row: ApprovalPendingTimelineRow;
  toolCall?: ToolCallTimelineRow;
  onResolve?: (
    approval: { readonly approvalId: string; readonly threadId: string; readonly turnId: string },
    decision: ApprovalDecision
  ) => Promise<void>;
}): React.ReactElement {
  const [busy, setBusy] = React.useState<ApprovalDecision>();
  const [error, setError] = React.useState('');
  const fileChange = props.toolCall?.toolName === 'codex.fileChange';
  const resolve = (decision: ApprovalDecision) => {
    if (!props.onResolve) return;
    setBusy(decision);
    setError('');
    void props
      .onResolve(
        {
          approvalId: props.row.approvalId,
          threadId: props.row.threadId,
          turnId: props.row.turnId,
        },
        decision
      )
      .catch((cause) => setError(readError(cause)))
      .finally(() => setBusy(undefined));
  };
  return (
    <article className="grid gap-3 rounded-md border border-amber-800/80 bg-amber-950/20 p-3">
      <div className="grid min-w-0 gap-1">
        <div className="text-xs font-bold uppercase text-amber-300">
          {fileChange ? 'File change approval' : 'Command approval'}
        </div>
        <div className="break-words font-mono text-sm leading-6 text-zinc-100">
          {approvalTarget(props.toolCall, fileChange)}
        </div>
        {props.row.reason ? (
          <div className="text-xs leading-5 text-zinc-400">{props.row.reason}</div>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="text-xs text-rose-300">
          {error}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          disabled={Boolean(busy) || !props.onResolve}
          onClick={() => resolve('decline')}
        >
          {busy === 'decline' ? 'Declining...' : 'Decline'}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={Boolean(busy) || !props.onResolve}
          onClick={() => resolve('approveOnce')}
        >
          {busy === 'approveOnce' ? 'Approving...' : 'Approve once'}
        </Button>
      </div>
    </article>
  );
}

function findApprovalToolCall(
  row: TimelineRow,
  rows: readonly TimelineRow[]
): ToolCallTimelineRow | undefined {
  if (row.type !== 'approval-pending' || !row.toolCallId) return undefined;
  return rows.find(
    (candidate): candidate is ToolCallTimelineRow =>
      candidate.type === 'tool-call' && candidate.toolCallId === row.toolCallId
  );
}

function approvalTarget(toolCall: ToolCallTimelineRow | undefined, fileChange: boolean): string {
  if (!toolCall || !isRecord(toolCall.input)) {
    return fileChange ? 'Apply requested file changes' : 'Run requested command';
  }
  if (!fileChange && typeof toolCall.input.command === 'string') return toolCall.input.command;
  for (const key of ['path', 'filePath', 'cwd']) {
    if (typeof toolCall.input[key] === 'string') return toolCall.input[key];
  }
  return fileChange ? 'Apply requested file changes' : 'Run requested command';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

let operationKeySequence = 0;
function nextOperationKey(scope: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++operationKeySequence}`;
  return `${scope}:${id}`;
}
