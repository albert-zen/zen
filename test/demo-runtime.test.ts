import { describe, expect, it } from 'vitest';

import { createDemoAppServer } from './test-exports.js';

describe('demo runtime', () => {
  it('runs a normal turn through the App Server item path', async () => {
    const server = createDemoAppServer({
      appServerOptions: { threadManagerOptions: deterministicIds() },
    });
    const start = await server.request({ method: 'thread/start' });

    if (!start.ok || start.method !== 'thread/start') {
      throw new Error('thread did not start');
    }

    await server.request({
      method: 'turn/start',
      params: { threadId: start.result.thread.id, input: 'hello' },
    });
    await waitForTurn(server, start.result.thread.id);
    const read = await server.request({
      method: 'thread/read',
      params: { threadId: start.result.thread.id },
    });

    if (!read.ok || read.method !== 'thread/read') {
      throw new Error('thread did not read');
    }

    expect(read.result.thread.items.map((item) => item.type)).toContain(
      'assistant.message.completed'
    );
    expect(read.result.thread.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'assistant.message.completed',
          payload: expect.objectContaining({
            content: 'Zen demo response: hello',
          }),
        }),
      ])
    );
  });

  it('runs a fake tool cycle for tool requests', async () => {
    const server = createDemoAppServer({
      appServerOptions: { threadManagerOptions: deterministicIds() },
    });
    const start = await server.request({ method: 'thread/start' });

    if (!start.ok || start.method !== 'thread/start') {
      throw new Error('thread did not start');
    }

    await server.request({
      method: 'turn/start',
      params: { threadId: start.result.thread.id, input: 'use a tool for zen' },
    });
    await waitForTurn(server, start.result.thread.id);
    const read = await server.request({
      method: 'thread/read',
      params: { threadId: start.result.thread.id },
    });

    if (!read.ok || read.method !== 'thread/read') {
      throw new Error('thread did not read');
    }

    expect(read.result.thread.items.map((item) => item.type)).toEqual(
      expect.arrayContaining(['tool.call.started', 'tool.output.delta', 'tool.result.completed'])
    );
    expect(read.result.thread.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'assistant.message.completed',
          payload: expect.objectContaining({
            content: expect.stringContaining('Demo tool returned'),
          }),
        }),
      ])
    );
  });
});

async function waitForTurn(
  server: ReturnType<typeof createDemoAppServer>,
  threadId: string
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const read = await server.request({
      method: 'thread/read',
      params: { threadId },
    });

    if (read.ok && read.method === 'thread/read' && read.result.thread.status !== 'running') {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('Timed out waiting for turn');
}

function deterministicIds() {
  return {
    generateThreadId: sequence('thread'),
    generateRunId: sequence('run'),
    generateTurnId: sequence('turn'),
    generateItemId: sequence('item'),
    clock: () => 1000,
  };
}

function sequence(prefix: string): () => string {
  let nextId = 0;

  return () => `${prefix}-${++nextId}`;
}
