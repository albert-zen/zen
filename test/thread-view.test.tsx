// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebUiState } from './test-exports.js';
import { ThreadView } from '../web/src/thread-view.tsx';

describe('ThreadView', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
  });

  it('keeps history visible while disabling every execution mutation', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ThreadView
          connection={{ status: 'connected' }}
          thread={{ id: 'thread-1', status: 'idle', turns: [], items: [] }}
          summary={{
            id: 'thread-1',
            projectId: 'project-1',
            status: 'archived',
            depth: 0,
          }}
          state={createWebUiState()}
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          onArchive={vi.fn()}
          onHandoff={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain('Archived history is read-only.');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    for (const label of ['Handoff thread', 'Interrupt current Turn', 'Archive thread']) {
      expect(
        (container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).disabled
      ).toBe(true);
    }
  });

  it('resolves command approvals with the complete request tuple and disabled actions', async () => {
    let settle!: () => void;
    const onResolveApproval = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const base = createWebUiState();
    await act(async () => {
      root?.render(
        <ThreadView
          connection={{ status: 'running' }}
          thread={{ id: 'thread-1', status: 'running', turns: [], items: [] }}
          summary={{ id: 'thread-1', status: 'running', depth: 0 }}
          state={{
            ...base,
            timelineRows: [
              {
                type: 'tool-call',
                itemId: 'tool-item',
                seq: 1,
                turnId: 'turn-1',
                toolCallId: 'call-1',
                toolName: 'codex.command',
                input: { command: 'git status', cwd: 'D:\\workspace' },
              },
              {
                type: 'approval-pending',
                itemId: 'approval-item',
                seq: 2,
                turnId: 'turn-1',
                approvalId: 'approval-1',
                threadId: 'thread-1',
                toolCallId: 'call-1',
                reason: 'Inspect repository status',
              },
            ],
          }}
          onResolveApproval={onResolveApproval}
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          onArchive={vi.fn()}
          onHandoff={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain('Command approval');
    expect(container.textContent).toContain('git status');
    const approve = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Approve once'
    ) as HTMLButtonElement;
    await act(async () => approve.click());

    expect(onResolveApproval).toHaveBeenCalledWith(
      { approvalId: 'approval-1', threadId: 'thread-1', turnId: 'turn-1' },
      'approveOnce'
    );
    expect(
      [...container.querySelectorAll('button')]
        .filter((button) => ['Approving...', 'Decline'].includes(button.textContent ?? ''))
        .every((button) => button.disabled)
    ).toBe(true);

    await act(async () => settle());
    await act(async () => {
      root?.render(
        <ThreadView
          connection={{ status: 'connected' }}
          thread={{ id: 'thread-1', status: 'idle', turns: [], items: [] }}
          summary={{ id: 'thread-1', status: 'completed', depth: 0 }}
          state={{
            ...base,
            timelineRows: [
              {
                type: 'approval-resolved',
                itemId: 'resolved-item',
                seq: 3,
                turnId: 'turn-1',
                approvalId: 'approval-1',
                decision: 'approveOnce',
              },
            ],
          }}
          onResolveApproval={onResolveApproval}
          onSend={vi.fn()}
          onInterrupt={vi.fn()}
          onArchive={vi.fn()}
          onHandoff={vi.fn()}
        />
      );
    });
    expect(container.textContent).toContain('Approval resolved');
    expect(container.textContent).toContain('Approved once');
  });

  it('interrupts only an active Turn and keeps a canceled Turn Thread usable', async () => {
    const onInterrupt = vi.fn(async () => undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const activeTurn = { id: 'turn-1', runId: 'run-1', status: 'inProgress' as const, itemIds: [] };
    await act(async () => {
      root?.render(
        <ThreadView
          connection={{ status: 'running' }}
          thread={{ id: 'thread-1', status: 'running', turns: [activeTurn], items: [] }}
          summary={{ id: 'thread-1', status: 'running', depth: 0 }}
          state={createWebUiState()}
          onSend={vi.fn()}
          onInterrupt={onInterrupt}
          onArchive={vi.fn()}
          onHandoff={vi.fn()}
        />
      );
    });

    const stop = container.querySelector(
      '[aria-label="Interrupt current Turn"]'
    ) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    await act(async () => stop.click());
    expect(onInterrupt).toHaveBeenCalledWith(expect.stringMatching(/^turn-interrupt:/));
    expect(container.querySelector('[aria-label="Cancel thread"]')).toBeNull();

    await act(async () => {
      root?.render(
        <ThreadView
          connection={{ status: 'connected' }}
          thread={{
            id: 'thread-1',
            status: 'canceled',
            turns: [{ ...activeTurn, status: 'canceled' }],
            items: [],
          }}
          summary={{ id: 'thread-1', status: 'canceled', depth: 0 }}
          state={createWebUiState()}
          onSend={vi.fn()}
          onInterrupt={onInterrupt}
          onArchive={vi.fn()}
          onHandoff={vi.fn()}
        />
      );
    });
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false);
    expect(
      (container.querySelector('[aria-label="Interrupt current Turn"]') as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it('preserves a failed composer message and operation key for retry', async () => {
    const keys: string[] = [];
    const committedTurns = new Set<string>();
    let loseResponse = true;
    const onSend = vi.fn(async (_input: string, operationKey: string) => {
      keys.push(operationKey);
      committedTurns.add(operationKey);
      if (loseResponse) {
        loseResponse = false;
        throw new Error('Turn response lost');
      }
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ThreadView
          connection={{ status: 'connected' }}
          thread={{ id: 'thread-1', status: 'idle', turns: [], items: [] }}
          summary={{ id: 'thread-1', status: 'completed', depth: 0 }}
          state={createWebUiState()}
          onSend={onSend}
          onInterrupt={vi.fn()}
          onArchive={vi.fn()}
          onHandoff={vi.fn()}
        />
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Do this once'
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(textarea.value).toBe('Do this once');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Turn response lost');

    await act(async () => {
      container?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(committedTurns.size).toBe(1);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(textarea.value).toBe('');
  });
});
