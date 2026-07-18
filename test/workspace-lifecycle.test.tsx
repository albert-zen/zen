// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentAppClient,
  AgentAppNotificationListener,
  AgentAppRequest,
  AgentAppResponse,
  ProjectSnapshot,
} from './test-exports.js';
import { AgentWorkspaceClient } from './test-exports.js';
import { AgentWorkspace } from '../web/src/workspace.tsx';

describe('AgentWorkspace', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
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
    expect(container.querySelector('.grid-cols-3')).not.toBeNull();
  });
});

class WorkspaceTransport implements AgentAppClient {
  private listener?: AgentAppNotificationListener;
  private projects: ProjectSnapshot[] = [];
  async request(request: AgentAppRequest): Promise<AgentAppResponse> {
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
          maxConcurrentAgents: 2,
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
