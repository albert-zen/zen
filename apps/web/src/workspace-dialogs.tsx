import * as React from 'react';
import { ChevronDown, ExternalLink, FolderOpen, LogOut, RefreshCw, X } from 'lucide-react';

import type { ProjectSnapshot, ThreadSnapshot } from '@zen/framework/product';
import type { AgentWorkspaceSnapshot, WorkspaceThread } from '@zen/framework/presentation';
import { Button } from './components/ui/button';

type ProviderStatus = AgentWorkspaceSnapshot['provider'];
type ProviderModel = ProviderStatus['models']['items'][number];

export function ProjectDialog(props: {
  open: boolean;
  models: readonly ProviderModel[];
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    rootPath: string;
    policy: ProjectSnapshot['policy'];
  }) => Promise<void>;
}): React.ReactElement | null {
  const [name, setName] = React.useState('');
  const [rootPath, setRootPath] = React.useState('');
  const [advanced, setAdvanced] = React.useState(false);
  const [modelProfile, setModelProfile] = React.useState('');
  const [maxActiveExecutions, setMaxActiveExecutions] = React.useState('2');
  const [maxThreadDepth, setMaxThreadDepth] = React.useState('4');
  const [agentCanCreateThreads, setAgentCanCreateThreads] = React.useState(true);
  const [agentCanMessagePeers, setAgentCanMessagePeers] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState('');

  if (!props.open) return null;

  return (
    <Modal title="Create project" onClose={props.onClose}>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setFormError('');
          const activeExecutions = positiveInteger(maxActiveExecutions);
          const threadDepth = positiveInteger(maxThreadDepth);
          if (!rootPath.trim()) {
            setFormError('Choose a project directory.');
            return;
          }
          if (activeExecutions === undefined) {
            setFormError('Active executions must be a positive whole number.');
            return;
          }
          if (threadDepth === undefined) {
            setFormError('Thread depth must be a positive whole number.');
            return;
          }
          setBusy(true);
          void props
            .onSubmit({
              name: name.trim() || deriveProjectName(rootPath),
              rootPath: rootPath.trim(),
              policy: {
                maxActiveExecutions: activeExecutions,
                maxThreadDepth: threadDepth,
                agentCanCreateThreads,
                agentCanMessagePeers,
                ...(modelProfile ? { defaultModelProfile: modelProfile } : {}),
              },
            })
            .catch((cause) => setFormError(readError(cause)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="grid gap-1 text-sm">
          Project directory
          <div className="flex gap-2">
            <input
              required
              autoFocus
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2"
              placeholder="C:\\work\\my-project"
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
          <span className="text-xs text-zinc-500">
            The folder name is used when Project name is blank.
          </span>
        </label>
        <label className="grid gap-1 text-sm">
          Project name <span className="text-xs font-normal text-zinc-500">Optional</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2"
            placeholder="Derived from the directory"
          />
        </label>
        <PolicyDisclosure
          open={advanced}
          onToggle={() => setAdvanced((value) => !value)}
          models={props.models}
          modelProfile={modelProfile}
          onModelProfileChange={setModelProfile}
          maxActiveExecutions={maxActiveExecutions}
          onMaxActiveExecutionsChange={setMaxActiveExecutions}
          maxThreadDepth={maxThreadDepth}
          onMaxThreadDepthChange={setMaxThreadDepth}
          agentCanCreateThreads={agentCanCreateThreads}
          onAgentCanCreateThreadsChange={setAgentCanCreateThreads}
          agentCanMessagePeers={agentCanMessagePeers}
          onAgentCanMessagePeersChange={setAgentCanMessagePeers}
        />
        {formError ? <InlineError message={formError} /> : null}
        <DialogActions busy={busy} onClose={props.onClose} submitLabel="Create project" />
      </form>
    </Modal>
  );
}

export function ProjectSettingsDialog(props: {
  open: boolean;
  project: ProjectSnapshot;
  models: readonly ProviderModel[];
  onClose: () => void;
  onSubmit: (input: { name: string; policy: ProjectSnapshot['policy'] }) => Promise<void>;
}): React.ReactElement | null {
  const [name, setName] = React.useState(props.project.name);
  const [modelProfile, setModelProfile] = React.useState(
    props.project.policy.defaultModelProfile ?? ''
  );
  const [maxActiveExecutions, setMaxActiveExecutions] = React.useState(
    String(props.project.policy.maxActiveExecutions)
  );
  const [maxThreadDepth, setMaxThreadDepth] = React.useState(
    String(props.project.policy.maxThreadDepth)
  );
  const [agentCanCreateThreads, setAgentCanCreateThreads] = React.useState(
    props.project.policy.agentCanCreateThreads
  );
  const [agentCanMessagePeers, setAgentCanMessagePeers] = React.useState(
    props.project.policy.agentCanMessagePeers
  );
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState('');

  if (!props.open) return null;

  return (
    <Modal title="Project settings" onClose={props.onClose}>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setFormError('');
          const activeExecutions = positiveInteger(maxActiveExecutions);
          const threadDepth = positiveInteger(maxThreadDepth);
          if (activeExecutions === undefined) {
            setFormError('Active executions must be a positive whole number.');
            return;
          }
          if (threadDepth === undefined) {
            setFormError('Thread depth must be a positive whole number.');
            return;
          }
          setBusy(true);
          void props
            .onSubmit({
              name: name.trim(),
              policy: {
                ...props.project.policy,
                maxActiveExecutions: activeExecutions,
                maxThreadDepth: threadDepth,
                agentCanCreateThreads,
                agentCanMessagePeers,
                ...(modelProfile
                  ? { defaultModelProfile: modelProfile }
                  : { defaultModelProfile: undefined }),
              },
            })
            .catch((cause) => setFormError(readError(cause)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="grid gap-1 text-sm">
          Project name
          <input
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2"
          />
        </label>
        <div className="grid gap-1 text-sm">
          Project directory
          <div
            className="truncate rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-xs text-zinc-500"
            title={props.project.rootPath}
          >
            {props.project.rootPath}
          </div>
          <span className="text-xs text-zinc-500">The project directory is immutable.</span>
        </div>
        <PolicyEditor
          models={props.models}
          modelProfile={modelProfile}
          onModelProfileChange={setModelProfile}
          maxActiveExecutions={maxActiveExecutions}
          onMaxActiveExecutionsChange={setMaxActiveExecutions}
          maxThreadDepth={maxThreadDepth}
          onMaxThreadDepthChange={setMaxThreadDepth}
          agentCanCreateThreads={agentCanCreateThreads}
          onAgentCanCreateThreadsChange={setAgentCanCreateThreads}
          agentCanMessagePeers={agentCanMessagePeers}
          onAgentCanMessagePeersChange={setAgentCanMessagePeers}
        />
        <p className="text-xs leading-5 text-zinc-500">
          Changes apply to the next Turn. An active Turn keeps its captured policy.
        </p>
        {formError ? <InlineError message={formError} /> : null}
        <DialogActions busy={busy} onClose={props.onClose} submitLabel="Save settings" />
      </form>
    </Modal>
  );
}

export function ThreadDialog(props: {
  open: boolean;
  threads: readonly WorkspaceThread[];
  models: readonly ProviderModel[];
  projectDefaultModelProfile?: string;
  onClose: () => void;
  onCreate: (
    input: {
      objective: string;
      parentThreadId?: string;
      modelProfile?: string;
    },
    operationKey: string
  ) => Promise<string>;
  onStart: (input: string, operationKey: string) => Promise<void>;
}): React.ReactElement | null {
  const [prompt, setPrompt] = React.useState('');
  const [parentThreadId, setParentThreadId] = React.useState('');
  const [modelProfile, setModelProfile] = React.useState('');
  const [advanced, setAdvanced] = React.useState(false);
  const [createdThreadId, setCreatedThreadId] = React.useState<string>();
  const [createOperationKey, setCreateOperationKey] = React.useState(() =>
    nextOperationKey('thread-create')
  );
  const [turnOperationKey, setTurnOperationKey] = React.useState(() =>
    nextOperationKey('turn-start')
  );
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState('');

  if (!props.open) return null;

  return (
    <Modal title={createdThreadId ? 'Start first Turn' : 'New thread'} onClose={props.onClose}>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const value = prompt.trim();
          if (!value) {
            setFormError('Describe the work you want the agent to do.');
            return;
          }
          setFormError('');
          setBusy(true);
          void (async () => {
            const threadId =
              createdThreadId ??
              (await props.onCreate(
                {
                  objective: value,
                  ...(advanced && parentThreadId ? { parentThreadId } : {}),
                  ...(advanced && modelProfile ? { modelProfile } : {}),
                },
                createOperationKey
              ));
            if (!createdThreadId) {
              setCreatedThreadId(threadId);
              setCreateOperationKey(nextOperationKey('thread-create'));
            }
            await props.onStart(value, turnOperationKey);
            setTurnOperationKey(nextOperationKey('turn-start'));
          })()
            .catch((cause) => setFormError(readError(cause)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="grid gap-1 text-sm">
          What should the agent work on?
          <textarea
            required
            autoFocus
            value={prompt}
            onChange={(event) => {
              const next = event.target.value;
              if (next.trim() !== prompt.trim()) {
                if (!createdThreadId) setCreateOperationKey(nextOperationKey('thread-create'));
                setTurnOperationKey(nextOperationKey('turn-start'));
              }
              setPrompt(next);
              setFormError('');
            }}
            className="min-h-32 rounded-md border border-zinc-700 bg-zinc-900 p-3 leading-6 outline-none focus:border-teal-400"
            placeholder="Describe the task, context, and expected result..."
          />
        </label>
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-500">
          Uses {modelLabel(props.models, props.projectDefaultModelProfile)} and the Project policy.
        </div>
        <DisclosureButton
          open={advanced}
          onClick={() => {
            if (!createdThreadId && (parentThreadId || modelProfile)) {
              setCreateOperationKey(nextOperationKey('thread-create'));
            }
            setAdvanced((value) => !value);
            setFormError('');
          }}
        >
          Advanced thread options
        </DisclosureButton>
        {advanced ? (
          <div className="grid gap-3">
            <ModelSelect
              label="Model for this thread"
              value={modelProfile}
              models={props.models}
              defaultLabel={`Project default (${modelLabel(props.models, props.projectDefaultModelProfile)})`}
              disabled={Boolean(createdThreadId)}
              onChange={(value) => {
                if (!createdThreadId && value !== modelProfile) {
                  setCreateOperationKey(nextOperationKey('thread-create'));
                }
                setModelProfile(value);
                setFormError('');
              }}
            />
            <label className="grid gap-1 text-sm">
              Parent thread <span className="text-xs font-normal text-zinc-500">Optional</span>
              <select
                value={parentThreadId}
                disabled={Boolean(createdThreadId)}
                onChange={(event) => {
                  if (!createdThreadId && event.target.value !== parentThreadId) {
                    setCreateOperationKey(nextOperationKey('thread-create'));
                  }
                  setParentThreadId(event.target.value);
                  setFormError('');
                }}
                className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2"
              >
                <option value="">Top-level thread</option>
                {props.threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.objective ?? thread.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        {createdThreadId ? (
          <p className="text-xs leading-5 text-amber-300">
            The thread exists. Retry starts its first Turn without creating another thread.
          </p>
        ) : null}
        {formError ? <InlineError message={formError} /> : null}
        <DialogActions
          busy={busy}
          onClose={props.onClose}
          submitLabel={createdThreadId ? 'Retry Turn' : 'Start Turn'}
        />
      </form>
    </Modal>
  );
}

export function ProviderDialog(props: {
  open: boolean;
  provider: ProviderStatus;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onStartLogin: (type: 'chatgpt' | 'chatgptDeviceCode') => Promise<void>;
  onCancelLogin: () => Promise<void>;
  onLogout: () => Promise<void>;
}): React.ReactElement | null {
  const [busy, setBusy] = React.useState('');
  const [formError, setFormError] = React.useState('');

  if (!props.open) return null;
  const authenticated = props.provider.account.state === 'authenticated';
  const run = (name: string, operation: () => Promise<void>) => {
    setBusy(name);
    setFormError('');
    void operation()
      .catch((cause) => setFormError(readError(cause)))
      .finally(() => setBusy(''));
  };

  return (
    <Modal title="Provider" onClose={props.onClose}>
      <div className="grid gap-4">
        <div className="grid gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 p-3">
          <ProviderStatusRow
            label="Codex CLI"
            status={props.provider.cli.state}
            value={
              props.provider.cli.state === 'ready'
                ? 'Connected'
                : props.provider.cli.state === 'error'
                  ? 'Connection error'
                  : capitalize(props.provider.cli.state)
            }
            title={props.provider.cli.command}
          />
          <ProviderStatusRow
            label="ChatGPT account"
            status={props.provider.account.state === 'authenticated' ? 'ready' : 'idle'}
            value={accountLabel(props.provider)}
          />
        </div>

        {props.provider.error ? <InlineError message={props.provider.error} /> : null}
        {formError && formError !== props.provider.error ? (
          <InlineError message={formError} />
        ) : null}

        {!authenticated ? (
          <div className="grid gap-3 rounded-md border border-amber-900/70 bg-amber-950/20 p-3">
            <div>
              <div className="text-sm font-semibold text-amber-100">Connect a ChatGPT account</div>
              <p className="mt-1 text-xs leading-5 text-amber-200/70">
                Projects and history remain available. Sign in to run agent Turns and load models.
              </p>
            </div>
            {!props.provider.login ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="primary"
                  disabled={Boolean(busy)}
                  onClick={() => run('browser-login', () => props.onStartLogin('chatgpt'))}
                >
                  Sign in with browser
                </Button>
                <Button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => run('device-login', () => props.onStartLogin('chatgptDeviceCode'))}
                >
                  Use device code
                </Button>
              </div>
            ) : (
              <ProviderLoginInstructions login={props.provider.login} />
            )}
          </div>
        ) : null}

        <section className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Available models</h3>
            <span className="text-xs text-zinc-500">
              {props.provider.models.items.filter((model) => !model.hidden).length} available
            </span>
          </div>
          <div className="max-h-40 overflow-auto rounded-md border border-zinc-800">
            {props.provider.models.items.filter((model) => !model.hidden).length ? (
              props.provider.models.items
                .filter((model) => !model.hidden)
                .map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2 last:border-b-0"
                  >
                    <span className="truncate text-sm text-zinc-200">{model.displayName}</span>
                    <code className="shrink-0 text-xs text-zinc-500">{model.id}</code>
                  </div>
                ))
            ) : (
              <div className="px-3 py-5 text-center text-xs text-zinc-500">
                Refresh after signing in to load models.
              </div>
            )}
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-3">
          <Button
            type="button"
            variant="ghost"
            disabled={Boolean(busy) || props.provider.refreshing}
            onClick={() => run('refresh', props.onRefresh)}
          >
            <RefreshCw
              className={`h-4 w-4 ${props.provider.refreshing || busy === 'refresh' ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
          <div className="flex gap-2">
            {props.provider.login ? (
              <Button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => run('cancel-login', props.onCancelLogin)}
              >
                Cancel sign-in
              </Button>
            ) : null}
            {authenticated ? (
              <Button
                type="button"
                variant="ghost"
                disabled={Boolean(busy)}
                onClick={() => run('logout', props.onLogout)}
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </Button>
            ) : null}
            <Button type="button" onClick={props.onClose} disabled={Boolean(busy)}>
              Done
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ProviderLoginInstructions({
  login,
}: {
  login: NonNullable<ProviderStatus['login']>;
}): React.ReactElement {
  if (login.type === 'chatgpt') {
    return (
      <a
        href={login.authUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-teal-500 bg-teal-500 px-3 text-sm font-medium text-zinc-950 hover:bg-teal-400"
      >
        Open sign-in page
        <ExternalLink className="h-4 w-4" />
      </a>
    );
  }
  return (
    <div className="grid gap-2">
      <div className="text-xs text-amber-200/70">Enter this code on the verification page:</div>
      <code className="rounded-md border border-amber-800 bg-zinc-950 px-3 py-2 text-center text-base font-bold text-amber-100">
        {login.userCode}
      </code>
      <a
        href={login.verificationUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center justify-center gap-2 text-sm font-medium text-teal-300 hover:text-teal-200"
      >
        Open verification page
        <ExternalLink className="h-4 w-4" />
      </a>
    </div>
  );
}

function ProviderStatusRow(props: {
  label: string;
  status: 'idle' | 'ready' | 'error' | 'closed';
  value: string;
  title?: string;
}): React.ReactElement {
  const color =
    props.status === 'ready'
      ? 'bg-emerald-400'
      : props.status === 'error'
        ? 'bg-rose-400'
        : 'bg-zinc-600';
  return (
    <div className="flex items-center justify-between gap-3 text-sm" title={props.title}>
      <span className="flex items-center gap-2 text-zinc-400">
        <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
        {props.label}
      </span>
      <span className="min-w-0 truncate text-zinc-200">{props.value}</span>
    </div>
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
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState('');

  if (!props.open) return null;
  return (
    <Modal title="Handoff thread" onClose={props.onClose}>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setFormError('');
          setBusy(true);
          void props
            .onSubmit(target, content)
            .catch((cause) => setFormError(readError(cause)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="grid gap-1 text-sm">
          Target thread
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
        {formError ? <InlineError message={formError} /> : null}
        <DialogActions busy={busy} onClose={props.onClose} submitLabel="Handoff" />
      </form>
    </Modal>
  );
}

function PolicyDisclosure(props: {
  open: boolean;
  onToggle: () => void;
  models: readonly ProviderModel[];
  modelProfile: string;
  onModelProfileChange: (value: string) => void;
  maxActiveExecutions: string;
  onMaxActiveExecutionsChange: (value: string) => void;
  maxThreadDepth: string;
  onMaxThreadDepthChange: (value: string) => void;
  agentCanCreateThreads: boolean;
  onAgentCanCreateThreadsChange: (value: boolean) => void;
  agentCanMessagePeers: boolean;
  onAgentCanMessagePeersChange: (value: boolean) => void;
}): React.ReactElement {
  return (
    <div className="grid gap-3 rounded-md border border-zinc-800 p-3">
      <DisclosureButton open={props.open} onClick={props.onToggle}>
        Advanced policy defaults
      </DisclosureButton>
      {props.open ? (
        <PolicyEditor
          models={props.models}
          modelProfile={props.modelProfile}
          onModelProfileChange={props.onModelProfileChange}
          maxActiveExecutions={props.maxActiveExecutions}
          onMaxActiveExecutionsChange={props.onMaxActiveExecutionsChange}
          maxThreadDepth={props.maxThreadDepth}
          onMaxThreadDepthChange={props.onMaxThreadDepthChange}
          agentCanCreateThreads={props.agentCanCreateThreads}
          onAgentCanCreateThreadsChange={props.onAgentCanCreateThreadsChange}
          agentCanMessagePeers={props.agentCanMessagePeers}
          onAgentCanMessagePeersChange={props.onAgentCanMessagePeersChange}
        />
      ) : null}
    </div>
  );
}

function PolicyEditor(props: {
  models: readonly ProviderModel[];
  modelProfile: string;
  onModelProfileChange: (value: string) => void;
  maxActiveExecutions: string;
  onMaxActiveExecutionsChange: (value: string) => void;
  maxThreadDepth: string;
  onMaxThreadDepthChange: (value: string) => void;
  agentCanCreateThreads: boolean;
  onAgentCanCreateThreadsChange: (value: boolean) => void;
  agentCanMessagePeers: boolean;
  onAgentCanMessagePeersChange: (value: boolean) => void;
}): React.ReactElement {
  return (
    <div className="grid gap-3">
      <ModelSelect
        label="Default model"
        value={props.modelProfile}
        models={props.models}
        defaultLabel="Provider default (account)"
        onChange={props.onModelProfileChange}
      />
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-sm">
          Active executions
          <input
            type="number"
            min="1"
            value={props.maxActiveExecutions}
            onChange={(event) => props.onMaxActiveExecutionsChange(event.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Thread depth
          <input
            type="number"
            min="1"
            value={props.maxThreadDepth}
            onChange={(event) => props.onMaxThreadDepthChange(event.target.value)}
            className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={props.agentCanCreateThreads}
          onChange={(event) => props.onAgentCanCreateThreadsChange(event.target.checked)}
        />
        Agents can create threads
      </label>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={props.agentCanMessagePeers}
          onChange={(event) => props.onAgentCanMessagePeersChange(event.target.checked)}
        />
        Agents can message peer threads
      </label>
    </div>
  );
}

function DisclosureButton(props: {
  open: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-expanded={props.open}
      onClick={props.onClick}
      className="flex items-center justify-between text-left text-sm font-medium text-zinc-300 hover:text-zinc-100"
    >
      {props.children}
      <ChevronDown className={`h-4 w-4 transition-transform ${props.open ? 'rotate-180' : ''}`} />
    </button>
  );
}

function DialogActions(props: {
  busy: boolean;
  onClose: () => void;
  submitLabel: string;
}): React.ReactElement {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" onClick={props.onClose} disabled={props.busy}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" disabled={props.busy}>
        {props.busy ? 'Working...' : props.submitLabel}
      </Button>
    </div>
  );
}

function InlineError({ message }: { message: string }): React.ReactElement {
  return (
    <div
      role="alert"
      className="rounded-md border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-200"
    >
      {message}
    </div>
  );
}

function Modal(props: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, textarea, select')?.focus();
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
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onClose();
        }}
        className="w-full max-w-lg rounded-md border border-zinc-700 bg-zinc-950 p-4 text-zinc-100 shadow-2xl"
      >
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-bold">
            {props.title}
          </h2>
          <Button
            type="button"
            aria-label="Close dialog"
            title="Close dialog"
            size="icon"
            variant="ghost"
            onClick={props.onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

function ModelSelect(props: {
  label: string;
  value: string;
  models: readonly ProviderModel[];
  defaultLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}): React.ReactElement {
  const visibleModels = props.models.filter((model) => !model.hidden);
  const currentAvailable = !props.value || visibleModels.some((model) => model.id === props.value);
  return (
    <label className="grid gap-1 text-sm">
      {props.label}
      <select
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2"
      >
        <option value="">{props.defaultLabel}</option>
        {!currentAvailable ? (
          <option value={props.value}>{props.value} (unavailable)</option>
        ) : null}
        {visibleModels.map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName} ({model.id})
          </option>
        ))}
      </select>
    </label>
  );
}

function modelLabel(models: readonly ProviderModel[], modelId: string | undefined): string {
  if (!modelId) return 'the account default model';
  return models.find((model) => model.id === modelId)?.displayName ?? modelId;
}

function accountLabel(provider: ProviderStatus): string {
  if (provider.account.state === 'authenticated') {
    const identity = provider.account.email ?? 'Connected';
    return provider.account.plan ? `${identity} · ${provider.account.plan}` : identity;
  }
  if (provider.account.state === 'unauthenticated') return 'Not signed in';
  return 'Unknown';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  return undefined;
}

function deriveProjectName(rootPath: string): string {
  const normalized = rootPath.trim().replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? 'New project';
}

function readError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

let operationKeySequence = 0;
function nextOperationKey(scope: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++operationKeySequence}`;
  return `${scope}:${id}`;
}
