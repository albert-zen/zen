import type * as React from 'react';
import { Plus } from 'lucide-react';

import type { WorkspaceThread } from '#zen/presentation';
import { Button } from './components/ui/button';
import { cn } from './lib/utils';

export function ThreadNavigator(props: {
  threads: readonly WorkspaceThread[];
  selectedThreadId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}): React.ReactElement {
  return (
    <aside className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] border-r border-zinc-800 bg-zinc-900">
      <header className="border-b border-zinc-800 px-4 py-3">
        <div className="text-xs font-bold uppercase tracking-[0.08em] text-zinc-400">Threads</div>
      </header>
      <div className="p-2">
        <Button className="w-full justify-start" variant="ghost" onClick={props.onCreate}>
          <Plus className="h-4 w-4" />
          New thread
        </Button>
      </div>
      <nav aria-label="Threads" className="min-h-0 overflow-auto px-2 pb-3">
        {props.threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            aria-current={thread.id === props.selectedThreadId ? 'page' : undefined}
            onClick={() => props.onSelect(thread.id)}
            style={{ marginLeft: `${Math.min(thread.depth, 3) * 12}px` }}
            className={cn(
              'mb-1 grid w-[calc(100%-36px)] min-w-0 gap-1 rounded-md border border-transparent px-3 py-2 text-left hover:bg-zinc-800',
              thread.id === props.selectedThreadId && 'border-zinc-700 bg-zinc-800'
            )}
          >
            <div className="truncate text-sm font-semibold text-zinc-100">
              {thread.objective ?? thread.id}
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-zinc-400">
              <span className="truncate">{thread.modelProfile ?? 'default'}</span>
              <span className="shrink-0 capitalize">{thread.status}</span>
            </div>
          </button>
        ))}
      </nav>
    </aside>
  );
}
