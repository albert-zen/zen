import * as React from 'react';
import { CircleUserRound, MessagesSquare, PanelRight } from 'lucide-react';

import {
  AgentWorkspaceClient,
  BrowserAgentAppTransportClient,
  type AgentWorkspaceSnapshot,
} from '@zen/framework/presentation';
import { Button } from './components/ui/button';
import { ProjectNavigator } from './project-navigator';
import { ThreadNavigator } from './thread-navigator';
import { ThreadView } from './thread-view';
import {
  HandoffDialog,
  ProjectDialog,
  ProjectSettingsDialog,
  ProviderDialog,
  ThreadDialog,
} from './workspace-dialogs';

type MobileView = 'threads' | 'thread';
type Dialog = 'project' | 'settings' | 'provider' | 'thread' | 'handoff' | undefined;

export type AgentWorkspaceProps = {
  readonly createClient?: () => AgentWorkspaceClient;
};

export function AgentWorkspace(props: AgentWorkspaceProps = {}): React.ReactElement {
  const params = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const client = React.useMemo(
    () => (props.createClient ?? createWorkspaceClient)(),
    [props.createClient]
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
    <div className="grid h-dvh min-h-0 max-w-full grid-rows-[auto_minmax(0,1fr)] overflow-x-hidden bg-zinc-950 text-zinc-100">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-zinc-800 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-teal-400 text-xs font-black text-zinc-950">
            ZX
          </div>
          <div className="truncate text-sm font-bold">ZenX</div>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <div className="hidden text-xs leading-5 text-zinc-400 sm:block">
            {resourceSummary(snapshot)}
          </div>
          <Button
            type="button"
            variant="subtle"
            aria-label="Provider account"
            title="Provider account"
            className="max-w-56"
            onClick={() => setDialog('provider')}
          >
            <span aria-hidden className={`h-2 w-2 rounded-full ${providerIndicator(snapshot)}`} />
            <CircleUserRound className="h-4 w-4" />
            <span className="truncate">{providerLabel(snapshot)}</span>
          </Button>
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
      <div className="grid min-h-0 grid-cols-[300px_minmax(0,1fr)] max-md:grid-cols-1 max-md:pb-14">
        <aside
          className={
            mobileView === 'threads'
              ? 'grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-zinc-800 bg-zinc-900'
              : 'hidden min-h-0 md:grid md:grid-rows-[auto_minmax(0,1fr)] md:border-r md:border-zinc-800 md:bg-zinc-900'
          }
        >
          <ProjectNavigator
            projects={snapshot.projects}
            selectedProjectId={snapshot.selectedProject?.id}
            onSelect={selectProject}
            onCreate={() => setDialog('project')}
            onSettings={() => setDialog('settings')}
            onArchive={() => {
              if (window.confirm('Archive this project?')) invoke(() => client.archiveProject());
            }}
          />
          <ThreadNavigator
            threads={snapshot.threads}
            selectedThreadId={snapshot.selectedThread?.id}
            onSelect={selectThread}
            onCreate={() => setDialog('thread')}
          />
        </aside>
        <div className={mobileView === 'thread' ? 'min-h-0' : 'hidden min-h-0 md:block'}>
          {snapshot.selectedProject ? (
            <ThreadView
              key={`${snapshot.selectedProject.id}:${snapshot.selectedThread?.id ?? 'none'}`}
              connection={snapshot.connection}
              project={snapshot.selectedProject}
              thread={snapshot.selectedThread}
              summary={selectedSummary}
              state={snapshot.state}
              providerAuthenticated={providerAuthenticated(snapshot)}
              onOpenProvider={() => setDialog('provider')}
              onResolveApproval={(approval, decision) => client.resolveApproval(approval, decision)}
              onSend={(input, operationKey) =>
                client
                  .sendHumanTurn(input, operationKey)
                  .then(() => updateUrl(client.getSnapshot()))
              }
              onInterrupt={(operationKey) =>
                client.interruptTurn(operationKey).then(() => updateUrl(client.getSnapshot()))
              }
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
                {!providerAuthenticated(snapshot) ? (
                  <ProviderSetupCallout onOpen={() => setDialog('provider')} />
                ) : null}
              </div>
            </main>
          )}
        </div>
      </div>
      <nav
        aria-label="Mobile workspace views"
        className="fixed bottom-0 left-0 right-0 grid grid-cols-2 border-t border-zinc-800 bg-zinc-950 p-1 md:hidden"
      >
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
        key={dialog === 'project' ? 'project-open' : 'project-closed'}
        open={dialog === 'project'}
        models={snapshot.provider.models.items}
        onClose={() => setDialog(undefined)}
        onSubmit={async (input) => {
          await client.createProject(input);
          setDialog(undefined);
          setMobileView('threads');
          updateUrl(client.getSnapshot());
        }}
      />
      {snapshot.selectedProject ? (
        <ProjectSettingsDialog
          key={`${snapshot.selectedProject.id}:${dialog === 'settings' ? 'open' : 'closed'}`}
          open={dialog === 'settings'}
          project={snapshot.selectedProject}
          models={snapshot.provider.models.items}
          onClose={() => setDialog(undefined)}
          onSubmit={async (input) => {
            await client.updateProject(input);
            setDialog(undefined);
            updateUrl(client.getSnapshot());
          }}
        />
      ) : null}
      <ThreadDialog
        key={dialog === 'thread' ? 'thread-open' : 'thread-closed'}
        open={dialog === 'thread'}
        threads={snapshot.threads}
        models={snapshot.provider.models.items}
        projectDefaultModelProfile={snapshot.selectedProject?.policy.defaultModelProfile}
        onClose={() => setDialog(undefined)}
        onCreate={async (input, operationKey) => {
          await client.createThread(input, operationKey);
          updateUrl(client.getSnapshot());
          const threadId = client.getSnapshot().selectedThread?.id;
          if (!threadId) throw new Error('Thread was created but could not be selected');
          return threadId;
        }}
        onStart={async (input, operationKey) => {
          await client.sendHumanTurn(input, operationKey);
          setDialog(undefined);
          updateUrl(client.getSnapshot());
        }}
      />
      <ProviderDialog
        key={dialog === 'provider' ? 'provider-open' : 'provider-closed'}
        open={dialog === 'provider'}
        provider={snapshot.provider}
        onClose={() => setDialog(undefined)}
        onRefresh={() => client.refreshProvider()}
        onStartLogin={async (type) => {
          await client.startProviderLogin(type);
        }}
        onCancelLogin={() => client.cancelProviderLogin()}
        onLogout={() => client.logoutProvider()}
      />
      <HandoffDialog
        key={dialog === 'handoff' ? 'handoff-open' : 'handoff-closed'}
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

function createWorkspaceClient(): AgentWorkspaceClient {
  return new AgentWorkspaceClient({
    client: new BrowserAgentAppTransportClient({}),
  });
}

function ProviderSetupCallout({ onOpen }: { onOpen: () => void }): React.ReactElement {
  return (
    <div className="mt-3 grid gap-2 rounded-md border border-amber-900/70 bg-amber-950/20 p-3 text-left">
      <div className="text-sm font-semibold text-amber-100">Connect ChatGPT to run agent Turns</div>
      <div className="text-xs leading-5 text-amber-200/70">
        Project navigation and history remain available without an account.
      </div>
      <Button type="button" variant="ghost" onClick={onOpen}>
        Set up provider
      </Button>
    </div>
  );
}

function resourceSummary(snapshot: AgentWorkspaceSnapshot): string {
  if (!snapshot.selectedProject) return snapshot.connection.status;
  const active = snapshot.threads.filter((thread) => thread.status === 'running').length;
  const count = snapshot.threads.length;
  const limit = snapshot.selectedProject.policy.maxThreads;
  const threads = limit
    ? `${count} of ${limit} threads`
    : `${count} ${count === 1 ? 'thread' : 'threads'}`;
  return active ? `${active} running · ${threads}` : threads;
}

function providerLabel(snapshot: AgentWorkspaceSnapshot): string {
  const provider = snapshot.provider;
  if (provider.error || provider.state === 'error') return 'Provider error';
  if (provider.auth.state === 'expired') return 'ChatGPT session expired';
  if (providerAuthenticated(snapshot)) {
    return provider.account.email ?? 'ChatGPT connected';
  }
  if (provider.refreshing) return 'Checking provider';
  return 'Connect ChatGPT';
}

function providerIndicator(snapshot: AgentWorkspaceSnapshot): string {
  const provider = snapshot.provider;
  if (provider.error || provider.state === 'error') return 'bg-rose-400';
  if (providerAuthenticated(snapshot)) return 'bg-emerald-400';
  return 'bg-amber-400';
}

function providerAuthenticated(snapshot: AgentWorkspaceSnapshot): boolean {
  return (
    snapshot.provider.account.state === 'authenticated' &&
    snapshot.provider.auth.state === 'authenticated'
  );
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
