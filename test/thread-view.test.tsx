// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebUiState } from './test-exports.js';
import { ThreadView } from '../web/src/thread-view.tsx';

describe('ThreadView archived state', () => {
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
          onCancel={vi.fn()}
          onArchive={vi.fn()}
          onHandoff={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain('Archived history is read-only.');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    for (const label of ['Handoff thread', 'Cancel thread', 'Archive thread']) {
      expect(
        (container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).disabled
      ).toBe(true);
    }
  });
});
