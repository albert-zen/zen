import * as React from 'react';
import { Archive, CornerUpRight, Send, Square } from 'lucide-react';

import type {
  TimelineRow,
  WebUiConnectionState,
  WebUiState,
  WorkspaceThread,
} from '#zen/presentation';
import type { ThreadSnapshot } from '#zen/product';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';

export function ThreadView(props: {
  connection: WebUiConnectionState;
  thread?: ThreadSnapshot;
  summary?: WorkspaceThread;
  state: WebUiState;
  onSend: (input: string) => Promise<void>;
  onCancel: () => void;
  onArchive: () => void;
  onHandoff: () => void;
}): React.ReactElement {
  const [input, setInput] = React.useState('');
  const enabled =
    !!props.thread &&
    (props.connection.status === 'connected' || props.connection.status === 'running');
  const rows = [...props.state.timelineRows].filter((row) => row.type !== 'trace');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!input.trim()) return;
    const value = input;
    setInput('');
    await props.onSend(value);
  };
  return (
    <main className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-zinc-950">
      <header className="flex min-w-0 items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold">
            {props.summary?.objective ?? props.thread?.id ?? 'Select a thread'}
          </h1>
          <p className="truncate text-xs text-zinc-400">
            {props.summary
              ? `${props.summary.status} · ${props.summary.modelProfile ?? 'default profile'}${props.summary.parentThreadId ? ` · parent ${props.summary.parentThreadId}` : ''}`
              : 'No active thread'}
          </p>
        </div>
        {props.thread ? (
          <div className="flex shrink-0 gap-1">
            <Button
              aria-label="Handoff thread"
              title="Handoff thread"
              size="icon"
              variant="subtle"
              onClick={props.onHandoff}
            >
              <CornerUpRight className="h-4 w-4" />
            </Button>
            <Button
              aria-label="Cancel thread"
              title="Cancel thread"
              size="icon"
              variant="subtle"
              onClick={props.onCancel}
            >
              <Square className="h-4 w-4" />
            </Button>
            <Button
              aria-label="Archive thread"
              title="Archive thread"
              size="icon"
              variant="subtle"
              onClick={props.onArchive}
            >
              <Archive className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </header>
      <section aria-live="polite" className="min-h-0 overflow-auto px-5 py-5">
        <div className="mx-auto grid w-full max-w-4xl gap-4">
          {rows.length ? (
            rows.map((row) => <TimelineEntry key={`${row.itemId}:${row.type}`} row={row} />)
          ) : (
            <div className="py-16 text-center text-sm text-zinc-500">
              This thread has no Item-derived activity yet.
            </div>
          )}
        </div>
      </section>
      <div className="border-t border-zinc-800 px-5 py-3">
        <form
          onSubmit={(event) => void submit(event)}
          className="mx-auto grid w-full max-w-4xl grid-cols-[minmax(0,1fr)_auto] items-end gap-2"
        >
          <Textarea
            aria-label="Message selected thread"
            rows={2}
            value={input}
            disabled={!enabled}
            placeholder={props.thread ? 'Message this thread' : 'Select a thread'}
            onChange={(event) => setInput(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!enabled || !input.trim()}>
            <Send className="h-4 w-4" />
            Send
          </Button>
        </form>
      </div>
    </main>
  );
}

function TimelineEntry({ row }: { row: TimelineRow }): React.ReactElement {
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
