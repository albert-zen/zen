// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentAppClient,
  AgentAppNotificationListener,
  AgentAppRequest,
  AgentAppResponse,
  ProjectSnapshot,
} from './test-exports.js';
import { AgentWorkspaceClient } from './test-exports.js';
import { AgentWorkspace } from '../apps/web/src/workspace.tsx';
import { ThreadDialog } from '../apps/web/src/workspace-dialogs.tsx';

describe('AgentWorkspace', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    delete window.zenDesktop;
  });

  it('offers project creation from an empty bootstrap and closes the dialog with Escape', async () => {
    const transport = new WorkspaceTransport();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <AgentWorkspace createClient={() => new AgentWorkspaceClient({ client: transport })} />
      );
    });

    const create = container.querySelector('[aria-label="Create project"]') as HTMLButtonElement;
    await act(async () => create.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () =>
      container
        ?.querySelector('[role="dialog"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('.grid-cols-2')).not.toBeNull();
  });

  it('uses the desktop directory picker when the bridge is available', async () => {
    const transport = new WorkspaceTransport();
    window.zenDesktop = {
      platform: 'win32',
      version: '43.1.1',
      pickProjectDirectory: async () => 'C:\\work\\zen',
      showNotification: async () => undefined,
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <AgentWorkspace createClient={() => new AgentWorkspaceClient({ client: transport })} />
      );
    });

    await act(async () => {
      (container?.querySelector('[aria-label="Create project"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (
        container?.querySelector('[aria-label="Choose project directory"]') as HTMLButtonElement
      ).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect((container?.querySelectorAll('input')[0] as HTMLInputElement).value).toBe(
      'C:\\work\\zen'
    );
  });

  it('creates the thread once and preserves the prompt when the first Turn fails', async () => {
    let createCalls = 0;
    let startCalls = 0;
    const startKeys: string[] = [];
    const committedTurns = new Set<string>();
    let failStart = true;
    const onClose = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <ThreadDialog
          open
          threads={[]}
          models={[
            {
              id: 'gpt-5.4',
              model: 'gpt-5.4',
              displayName: 'GPT-5.4',
              hidden: false,
            },
          ]}
          onClose={onClose}
          onCreate={async ({ objective, modelProfile }) => {
            createCalls += 1;
            expect(objective).toBe('Investigate the scheduler');
            expect(modelProfile).toBe('gpt-5.4');
            return 'thread-1';
          }}
          onStart={async (input, operationKey) => {
            startCalls += 1;
            startKeys.push(operationKey);
            committedTurns.add(operationKey);
            expect(input).toBe('Investigate the scheduler');
            if (failStart) throw new Error('Turn could not start');
            onClose();
          }}
        />
      );
    });

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Advanced thread options'))
        ?.click();
    });
    const modelSelect = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
        modelSelect,
        'gpt-5.4'
      );
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Investigate the scheduler'
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Investigate the scheduler'
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Turn could not start'
    );
    expect(createCalls).toBe(1);
    expect(startCalls).toBe(1);

    failStart = false;
    await act(async () => {
      container?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });

    expect(createCalls).toBe(1);
    expect(startCalls).toBe(2);
    expect(committedTurns.size).toBe(1);
    expect(startKeys[0]).toBe(startKeys[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reuses the Thread create key after a committed response is lost', async () => {
    const createKeys: string[] = [];
    const committedThreads = new Map<string, string>();
    let loseResponse = true;
    let startCalls = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <ThreadDialog
          open
          threads={[]}
          models={[]}
          onClose={vi.fn()}
          onCreate={async ({ objective }, operationKey) => {
            expect(objective).toBe('Create exactly once');
            createKeys.push(operationKey);
            if (!committedThreads.has(operationKey)) {
              committedThreads.set(operationKey, 'thread-once');
            }
            if (loseResponse) {
              loseResponse = false;
              throw new Error('Create response lost');
            }
            return committedThreads.get(operationKey)!;
          }}
          onStart={async () => {
            startCalls += 1;
          }}
        />
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Create exactly once'
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(textarea.value).toBe('Create exactly once');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Create response lost'
    );

    await act(async () => {
      container?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(committedThreads.size).toBe(1);
    expect(createKeys).toHaveLength(2);
    expect(createKeys[0]).toBe(createKeys[1]);
    expect(startCalls).toBe(1);
  });

  it('opens provider account details with the actual available models', async () => {
    const transport = new WorkspaceTransport();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <AgentWorkspace createClient={() => new AgentWorkspaceClient({ client: transport })} />
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('user@example.test');
    await act(async () => {
      (container?.querySelector('[aria-label="Provider account"]') as HTMLButtonElement).click();
    });

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('GPT-5.4');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Pro');
    expect(container.querySelector('[role="dialog"]')?.textContent).not.toContain('token');
  });
});

class WorkspaceTransport implements AgentAppClient {
  private listener?: AgentAppNotificationListener;
  private projects: ProjectSnapshot[] = [];
  async request(request: AgentAppRequest): Promise<AgentAppResponse> {
    if (request.method === 'provider/read' || request.method === 'provider/refresh')
      return success(request.method, {
        status: {
          state: 'ready',
          cli: { state: 'ready', command: 'codex' },
          account: {
            state: 'authenticated',
            account: { type: 'chatgpt', email: 'user@example.test', plan: 'Pro' },
          },
          models: {
            state: 'ready',
            items: [
              {
                id: 'gpt-5.4',
                model: 'gpt-5.4',
                displayName: 'GPT-5.4',
                hidden: false,
              },
            ],
          },
        },
      });
    if (request.method === 'project/list')
      return success(request.method, { projects: this.projects });
    if (request.method === 'project/create') {
      const project: ProjectSnapshot = {
        id: 'project-1',
        name: 'Created',
        rootPath: '/created',
        createdAtMs: 0,
        updatedAtMs: 0,
        status: 'active',
        policy: {
          maxActiveExecutions: 2,
          maxThreadDepth: 4,
          agentCanCreateThreads: true,
          agentCanMessagePeers: true,
        },
      };
      this.projects = [project];
      return success(request.method, { project });
    }
    if (request.method === 'thread/list') return success(request.method, { threads: [] });
    throw new Error(`Unexpected request: ${request.method}`);
  }
  subscribe(listener: AgentAppNotificationListener) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
}

function success(method: string, result: Record<string, unknown>): AgentAppResponse {
  return { method: method as never, ok: true, result };
}
