import type * as React from 'react';
import { Archive, MoreHorizontal, Plus } from 'lucide-react';

import type { ProjectSnapshot } from '#zen/product';
import { Button } from './components/ui/button';

export function ProjectNavigator(props: {
  projects: readonly ProjectSnapshot[];
  selectedProjectId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onArchive: () => void;
}): React.ReactElement {
  return (
    <aside className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-zinc-800 bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-3">
        <div className="text-xs font-bold uppercase tracking-[0.08em] text-zinc-400">Projects</div>
        <Button
          aria-label="Create project"
          title="Create project"
          size="icon"
          variant="subtle"
          onClick={props.onCreate}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </header>
      <nav aria-label="Projects" className="min-h-0 overflow-auto p-2">
        {props.projects
          .filter((project) => project.status === 'active')
          .map((project) => {
            const active = project.id === props.selectedProjectId;
            return (
              <div
                key={project.id}
                className={
                  active
                    ? 'mb-1 flex items-center gap-1 rounded-md bg-zinc-800 p-1'
                    : 'mb-1 flex items-center gap-1 p-1'
                }
              >
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => props.onSelect(project.id)}
                  className="min-w-0 flex-1 rounded-md px-2 py-2 text-left hover:bg-zinc-800"
                >
                  <div className="truncate text-sm font-semibold text-zinc-100">{project.name}</div>
                  <div className="truncate text-xs text-zinc-500" title={project.rootPath}>
                    {project.rootPath}
                  </div>
                </button>
                {active ? (
                  <Button
                    aria-label="Archive current project"
                    title="Archive current project"
                    size="icon"
                    variant="subtle"
                    onClick={props.onArchive}
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <MoreHorizontal aria-hidden className="mr-2 h-4 w-4 text-zinc-600" />
                )}
              </div>
            );
          })}
      </nav>
    </aside>
  );
}
