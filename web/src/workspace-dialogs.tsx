import * as React from 'react';
import { FolderOpen } from 'lucide-react';

import type { ProjectSnapshot, ThreadSnapshot } from '#zen/product';
import type { WorkspaceThread } from '#zen/presentation';
import { Button } from './components/ui/button';

export function ProjectDialog(props: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    rootPath: string;
    policy: ProjectSnapshot['policy'];
  }) => Promise<void>;
}): React.ReactElement | null {
  const [name, setName] = React.useState('');
  const [rootPath, setRootPath] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  if (!props.open) return null;
  return (
    <Modal title="Create project" onClose={props.onClose}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void props
            .onSubmit({
              name,
              rootPath,
              policy: {
                maxActiveExecutions: 2,
                maxThreadDepth: 4,
                agentCanCreateThreads: true,
                agentCanMessagePeers: true,
              },
            })
            .finally(() => setBusy(false));
        }}
      >
        <label className="grid gap-1 text-sm">
          Name
          <input
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Root path
          <div className="flex gap-2">
            <input
              required
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2"
            />
            {window.zenDesktop ? (
              <Button
                type="button"
                variant="ghost"
                aria-label="Choose project directory"
                title="Choose project directory"
                disabled={busy}
                onClick={() => {
                  void window.zenDesktop
                    ?.pickProjectDirectory()
                    .then((path) => {
                      if (path) setRootPath(path);
                    })
                    .catch(() => undefined);
                }}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ThreadDialog(props: {
  open: boolean;
  threads: readonly WorkspaceThread[];
  onClose: () => void;
  onSubmit: (input: {
    objective: string;
    parentThreadId?: string;
    modelProfile?: string;
  }) => Promise<void>;
}): React.ReactElement | null {
  const [objective, setObjective] = React.useState('');
  const [parentThreadId, setParentThreadId] = React.useState('');
  const [modelProfile, setModelProfile] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  if (!props.open) return null;
  return (
    <Modal title="New thread" onClose={props.onClose}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void props
            .onSubmit({
              objective,
              ...(parentThreadId ? { parentThreadId } : {}),
              ...(modelProfile ? { modelProfile } : {}),
            })
            .finally(() => setBusy(false));
        }}
      >
        <label className="grid gap-1 text-sm">
          Objective
          <textarea
            required
            autoFocus
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            className="min-h-20 rounded-md border border-zinc-700 bg-zinc-900 p-2"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Parent thread
          <select
            value={parentThreadId}
            onChange={(event) => setParentThreadId(event.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2"
          >
            <option value="">None</option>
            {props.threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.objective ?? thread.id}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Model profile
          <input
            value={modelProfile}
            onChange={(event) => setModelProfile(event.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2"
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function HandoffDialog(props: {
  open: boolean;
  source?: ThreadSnapshot;
  threads: readonly WorkspaceThread[];
  onClose: () => void;
  onSubmit: (targetThreadId: string, content: string) => Promise<void>;
}): React.ReactElement | null {
  const [target, setTarget] = React.useState('');
  const [content, setContent] = React.useState('');
  if (!props.open) return null;
  return (
    <Modal title="Handoff thread" onClose={props.onClose}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void props.onSubmit(target, content);
        }}
      >
        <label className="grid gap-1 text-sm">
          Target
          <select
            required
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2"
          >
            <option value="">Select thread</option>
            {props.threads
              .filter((thread) => thread.id !== props.source?.id)
              .map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.objective ?? thread.id}
                </option>
              ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Context
          <textarea
            required
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="min-h-20 rounded-md border border-zinc-700 bg-zinc-900 p-2"
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Handoff
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Modal(props: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onClose();
        }}
        className="w-full max-w-md rounded-md border border-zinc-700 bg-zinc-950 p-4 text-zinc-100"
      >
        <h2 className="mb-4 text-base font-bold">{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}
