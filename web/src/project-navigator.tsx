import type * as React from 'react';
import { Archive, Plus, Settings2 } from 'lucide-react';

import type { ProjectSnapshot } from '#zen/product';
import { Button } from './components/ui/button';

export function ProjectNavigator(props: {
  projects: readonly ProjectSnapshot[];
  selectedProjectId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onSettings: () => void;
  onArchive: () => void;
}): React.ReactElement {
  const selectedProject = props.projects.find((project) => project.id === props.selectedProjectId);
  const activeProjects = props.projects.filter((project) => project.status === 'active');

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-zinc-500">
          Project
        </div>
        <Button
          aria-label="Create project"
          title="Create project"
          size="icon"
          variant="subtle"
          onClick={props.onCreate}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1">
        <select
          aria-label="Select project"
          value={props.selectedProjectId ?? ''}
          onChange={(event) => {
            if (event.target.value) props.onSelect(event.target.value);
          }}
          className="h-9 min-w-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm font-semibold text-zinc-100 outline-none focus:border-teal-400"
        >
          {!selectedProject ? <option value="">Select a project</option> : null}
          {activeProjects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <Button
          aria-label="Project settings"
          title="Project settings"
          size="icon"
          variant="subtle"
          disabled={!selectedProject}
          onClick={props.onSettings}
        >
          <Settings2 className="h-4 w-4" />
        </Button>
        <Button
          aria-label="Archive current project"
          title="Archive current project"
          size="icon"
          variant="subtle"
          disabled={!selectedProject}
          onClick={props.onArchive}
        >
          <Archive className="h-4 w-4" />
        </Button>
      </div>
      <div className="mt-2 truncate text-xs text-zinc-500" title={selectedProject?.rootPath}>
        {selectedProject?.rootPath ?? 'Choose a project to view its threads'}
      </div>
    </section>
  );
}
