import * as React from 'react';
import { FolderKanban, MessagesSquare, PanelRight } from 'lucide-react';

import {
  AgentWorkspaceClient,
  BrowserAgentAppTransportClient,
  type AgentWorkspaceSnapshot,
} from '#zen/presentation';
import { Button } from './components/ui/button';
import { createBrowserDemoAppServer } from './demo-app-server';
import { ProjectNavigator } from './project-navigator';
import { ThreadNavigator } from './thread-navigator';
import { ThreadView } from './thread-view';
import { HandoffDialog, ProjectDialog, ThreadDialog } from './workspace-dialogs';

type RuntimeMode = 'real' | 'demo';
type MobileView = 'projects' | 'threads' | 'thread';
type Dialog = 'project' | 'thread' | 'handoff' | undefined;

export type AgentWorkspaceProps = {
  readonly createClient?: (mode: RuntimeMode) => AgentWorkspaceClient;
  readonly initialMode?: RuntimeMode;
};

export function AgentWorkspace(props: AgentWorkspaceProps = {}): React.ReactElement {
  const params = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const mode = props.initialMode ?? (params.get('mode') === 'demo' ? 'demo' : 'real');
  const client = React.useMemo(
    () => (props.createClient ?? createWorkspaceClient)(mode),
    [mode, props.createClient]
  );
  const snapshot = useWorkspaceSnapshot(client);
  const [dialog, setDialog] = React.useState<Dialog>();
  const [mobileView, setMobileView] = React.useState<MobileView>('thread');
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let active = true;
    void client
      .connect({
        projectId: params.get('project') ?? undefined,
        threadId: params.get('thread') ?? undefined,
      })
      .catch((cause) => active && setError(readError(cause)));
    return () => {
      active = false;
      client.dispose();
    };
  }, [client, params]);

  React.useEffect(() => {
    const onPopState = () => {
      const url = new URLSearchParams(window.location.search);
      const projectId = url.get('project');
      if (projectId)
        void client
          .selectProject(projectId, url.get('thread') ?? undefined)
          .catch((cause) => setError(readError(cause)));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [client]);

  const selectProject = (projectId: string) => {
    void client
      .selectProject(projectId)
      .then(() => updateUrl(client.getSnapshot()))
      .catch((cause) => setError(readError(cause)));
    setMobileView('threads');
  };
  const selectThread = (threadId: string) => {
    void client
      .selectThread(threadId)
      .then(() => updateUrl(client.getSnapshot()))
      .catch((cause) => setError(readError(cause)));
    setMobileView('thread');
  };
  const selectedSummary = snapshot.threads.find(
    (thread) => thread.id === snapshot.selectedThread?.id
  );
  const invoke = (operation: () => Promise<void>) =>
    void operation()
      .then(() => updateUrl(client.getSnapshot()))
      .catch((cause) => setError(readError(cause)));

  return (
    <div className="grid h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-teal-400 text-xs font-black text-zinc-950">
            Z
          </div>
          <div className="truncate text-sm font-bold">Zen control plane</div>
        </div>
        <div className="truncate text-xs text-zinc-400">
          {snapshot.selectedProject
            ? `${snapshot.threads.filter((thread) => thread.status === 'running').length} active agents · ${snapshot.threads.length} threads · ${snapshot.selectedProject.policy.maxConcurrentAgents} concurrent`
            : snapshot.connection.status}
        </div>
      </header>
      {error ? (
        <div
          role="alert"
          className="border-b border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-200"
        >
          {error}
        </div>
      ) : null}
      <div className="grid min-h-0 grid-cols-[220px_300px_minmax(0,1fr)] max-md:grid-cols-1">
        <div className={mobileView === 'projects' ? 'min-h-0' : 'hidden min-h-0 md:block'}>
          <ProjectNavigator
            projects={snapshot.projects}
            selectedProjectId={snapshot.selectedProject?.id}
            onSelect={selectProject}
            onCreate={() => setDialog('project')}
            onArchive={() => {
              if (window.confirm('Archive this project?')) invoke(() => client.archiveProject());
            }}
          />
        </div>
        <div className={mobileView === 'threads' ? 'min-h-0' : 'hidden min-h-0 md:block'}>
          <ThreadNavigator
            threads={snapshot.threads}
            selectedThreadId={snapshot.selectedThread?.id}
            onSelect={selectThread}
            onCreate={() => setDialog('thread')}
          />
        </div>
        <div className={mobileView === 'thread' ? 'min-h-0' : 'hidden min-h-0 md:block'}>
          {snapshot.selectedProject ? (
            <ThreadView
              connection={snapshot.connection}
              thread={snapshot.selectedThread}
              summary={selectedSummary}
              state={snapshot.state}
              onSend={(input) =>
                client.sendHumanTurn(input).then(() => updateUrl(client.getSnapshot()))
              }
              onCancel={() => {
                if (window.confirm('Cancel this thread?')) invoke(() => client.cancelThread());
              }}
              onArchive={() => {
                if (window.confirm('Archive this thread?')) invoke(() => client.archiveThread());
              }}
              onHandoff={() => setDialog('handoff')}
            />
          ) : (
            <main className="grid min-h-0 place-items-center px-6">
              <div className="grid max-w-sm gap-3 text-center">
                <h1 className="text-lg font-bold">Create a project</h1>
                <p className="text-sm leading-6 text-zinc-400">
                  Projects establish the work boundary and policy for coordinated threads.
                </p>
                <Button variant="primary" onClick={() => setDialog('project')}>
                  Create project
                </Button>
              </div>
            </main>
          )}
        </div>
      </div>
      <nav
        aria-label="Mobile workspace views"
        className="fixed bottom-0 left-0 right-0 grid grid-cols-3 border-t border-zinc-800 bg-zinc-950 p-1 md:hidden"
      >
        <MobileTab
          label="Projects"
          icon={<FolderKanban className="h-4 w-4" />}
          active={mobileView === 'projects'}
          onClick={() => setMobileView('projects')}
        />
        <MobileTab
          label="Threads"
          icon={<MessagesSquare className="h-4 w-4" />}
          active={mobileView === 'threads'}
          onClick={() => setMobileView('threads')}
        />
        <MobileTab
          label="Thread"
          icon={<PanelRight className="h-4 w-4" />}
          active={mobileView === 'thread'}
          onClick={() => setMobileView('thread')}
        />
      </nav>
      <ProjectDialog
        open={dialog === 'project'}
        onClose={() => setDialog(undefined)}
        onSubmit={async (input) => {
          await client.createProject(input);
          setDialog(undefined);
          updateUrl(client.getSnapshot());
        }}
      />
      <ThreadDialog
        open={dialog === 'thread'}
        threads={snapshot.threads}
        onClose={() => setDialog(undefined)}
        onSubmit={async (input) => {
          await client.createThread(input);
          setDialog(undefined);
          updateUrl(client.getSnapshot());
        }}
      />
      <HandoffDialog
        open={dialog === 'handoff'}
        source={snapshot.selectedThread}
        threads={snapshot.threads}
        onClose={() => setDialog(undefined)}
        onSubmit={async (target, content) => {
          await client.handoff(target, content);
          setDialog(undefined);
        }}
      />
    </div>
  );
}

function MobileTab(props: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <Button variant={props.active ? 'subtle' : 'ghost'} onClick={props.onClick}>
      {props.icon}
      {props.label}
    </Button>
  );
}

export function useWorkspaceSnapshot(client: AgentWorkspaceClient): AgentWorkspaceSnapshot {
  const subscribe = React.useCallback(
    (notify: () => void) => client.subscribe(() => notify()),
    [client]
  );
  const getSnapshot = React.useCallback(() => client.getSnapshot(), [client]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function createWorkspaceClient(mode: RuntimeMode): AgentWorkspaceClient {
  return new AgentWorkspaceClient({
    mode,
    client: mode === 'demo' ? createBrowserDemoAppServer() : new BrowserAgentAppTransportClient({}),
  });
}
function updateUrl(snapshot: AgentWorkspaceSnapshot): void {
  const url = new URL(window.location.href);
  if (snapshot.selectedProject) url.searchParams.set('project', snapshot.selectedProject.id);
  else url.searchParams.delete('project');
  if (snapshot.selectedThread) url.searchParams.set('thread', snapshot.selectedThread.id);
  else url.searchParams.delete('thread');
  window.history.pushState({}, '', url);
}
function readError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
