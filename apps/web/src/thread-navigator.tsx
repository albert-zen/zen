import type * as React from 'react';
import { Plus } from 'lucide-react';

import type { WorkspaceThread } from '@zen/framework/presentation';
import { Button } from './components/ui/button';
import { cn } from './lib/utils';

export function ThreadNavigator(props: {
  threads: readonly WorkspaceThread[];
  selectedThreadId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}): React.ReactElement {
  return (
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-3">
        <div className="text-xs font-bold uppercase tracking-[0.08em] text-zinc-400">Threads</div>
        <Button
          aria-label="New thread"
          title="New thread"
          size="icon"
          variant="subtle"
          onClick={props.onCreate}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </header>
      <nav aria-label="Threads" className="min-h-0 overflow-auto p-2">
        {props.threads.length === 0 ? (
          <div className="grid gap-3 px-2 py-8 text-center">
            <p className="text-sm text-zinc-500">No threads yet.</p>
            <Button variant="ghost" onClick={props.onCreate}>
              <Plus className="h-4 w-4" />
              Start a thread
            </Button>
          </div>
        ) : null}
        {props.threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            aria-current={thread.id === props.selectedThreadId ? 'page' : undefined}
            onClick={() => props.onSelect(thread.id)}
            className={cn(
              'mb-1 grid w-full min-w-0 gap-1 rounded-md border border-transparent px-3 py-2 text-left hover:bg-zinc-800',
              thread.id === props.selectedThreadId && 'border-zinc-700 bg-zinc-800'
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              {thread.depth > 0 ? (
                <span aria-hidden className="text-[10px] uppercase text-teal-400">
                  child
                </span>
              ) : null}
              <div className="truncate text-sm font-semibold text-zinc-100">
                {thread.objective ?? thread.id}
              </div>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-zinc-400">
              <span className="truncate">{thread.modelProfile ?? 'project default'}</span>
              <span className="shrink-0 capitalize">{thread.status}</span>
            </div>
          </button>
        ))}
      </nav>
    </section>
  );
}
