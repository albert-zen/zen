import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createAgentAppProductionComposition,
  projectRuntimeDirectory,
  serveAgentAppHttpTransport,
} from './test-exports.js';

describe('Agent App Node integration', () => {
  it('serves two projects through one authenticated JSON/SSE transport without replay mixing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-agent-app-worker-'));
    const composition = await createAgentAppProductionComposition({ appDataRoot: root });
    const transport = await serveAgentAppHttpTransport({
      agentAppServer: composition.agentAppServer,
    });
    const firstEvents = new AbortController();

    try {
      const one = await request(transport.url, transport.capability, {
        method: 'project/create',
        params: { name: 'One', rootPath: join(root, 'one'), idempotencyKey: 'one' },
      });
      const two = await request(transport.url, transport.capability, {
        method: 'project/create',
        params: { name: 'Two', rootPath: join(root, 'two'), idempotencyKey: 'two' },
      });
      const oneId = projectId(one);
      const twoId = projectId(two);
      const stream = await fetch(new URL('/events', transport.url), {
        headers: { authorization: `Bearer ${transport.capability}` },
        signal: firstEvents.signal,
      });
      const events = createEventReader(stream.body!);
      const sync = await events.next();
      expect(sync.event).toBe('sync');

      const firstThread = await request(transport.url, transport.capability, {
        method: 'thread/create',
        params: { projectId: oneId, idempotencyKey: 'thread-one' },
      });
      const secondThread = await request(transport.url, transport.capability, {
        method: 'thread/create',
        params: { projectId: twoId, idempotencyKey: 'thread-two' },
      });
      expect(threadId(firstThread)).toBeTruthy();
      expect(threadId(secondThread)).toBeTruthy();
      const oneEvent = await events.next();
      const twoEvent = await events.next();
      expect(oneEvent.event).toBe('notification');
      expect(twoEvent.event).toBe('notification');
      expect(
        [JSON.parse(oneEvent.data).projectId, JSON.parse(twoEvent.data).projectId].sort()
      ).toEqual([oneId, twoId].sort());

      firstEvents.abort();
      const reset = await fetch(new URL('/events', transport.url), {
        headers: {
          authorization: `Bearer ${transport.capability}`,
          'last-event-id': 'other-stream:1',
        },
      });
      expect((await createEventReader(reset.body!).next()).event).toBe('reset');

      const invalid = await fetch(new URL('/request', transport.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${transport.capability}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'thread/list', params: {} }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    } finally {
      firstEvents.abort();
      await transport.close();
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reopens registry, coordination, and thread journals from the fixed project directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-agent-app-worker-'));
    let projectIdValue = '';
    try {
      const first = await createAgentAppProductionComposition({ appDataRoot: root });
      const created = await first.agentAppServer.request({
        method: 'project/create',
        params: { name: 'Restart', rootPath: join(root, 'workspace'), idempotencyKey: 'project' },
      });
      projectIdValue = projectId(created);
      const thread = await first.agentAppServer.request({
        method: 'thread/create',
        params: { projectId: projectIdValue, idempotencyKey: 'thread' },
      });
      expect(threadId(thread)).toBeTruthy();
      await first.close();

      const restarted = await createAgentAppProductionComposition({ appDataRoot: root });
      try {
        const projects = await restarted.agentAppServer.request({
          method: 'project/list',
          params: {},
        });
        expect(projects).toMatchObject({
          ok: true,
          result: { projects: [{ id: projectIdValue }] },
        });
        const threads = await restarted.agentAppServer.request({
          method: 'thread/list',
          params: { projectId: projectIdValue },
        });
        expect(threads).toMatchObject({
          ok: true,
          result: { threads: [{ projectId: projectIdValue }] },
        });
      } finally {
        await restarted.close();
      }
    } finally {
      if (projectIdValue) {
        expect(projectRuntimeDirectory(root, projectIdValue)).toContain(join(root, 'projects'));
      }
      expect(() => projectRuntimeDirectory(root, '../escape')).not.toThrow();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('injects trusted project/thread tool authority and exposes all eight thread definitions to a model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-agent-app-worker-'));
    let modelCalls = 0;
    let names: readonly string[] = [];
    const composition = await createAgentAppProductionComposition({
      appDataRoot: root,
      createModel: (_project, tools) => {
        names = tools.map((tool) => tool.function.name);
        return {
          async *generate() {
            modelCalls += 1;
            yield { type: 'message.completed' as const, content: 'done' };
          },
        };
      },
    });
    try {
      const project = await composition.agentAppServer.request({
        method: 'project/create',
        params: { name: 'Tools', rootPath: join(root, 'workspace'), idempotencyKey: 'project' },
      });
      const id = projectId(project);
      const thread = await composition.agentAppServer.request({
        method: 'thread/create',
        params: { projectId: id, idempotencyKey: 'thread' },
      });
      await composition.agentAppServer.request({
        method: 'turn/start',
        params: {
          projectId: id,
          threadId: threadId(thread),
          input: 'hello',
          idempotencyKey: 'turn',
        },
      });
      await expect.poll(() => modelCalls).toBe(1);
      expect(names.filter((name) => name.startsWith('thread.'))).toHaveLength(8);
    } finally {
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function request(url: string, capability: string, body: unknown): Promise<unknown> {
  const response = await fetch(new URL('/request', url), {
    method: 'POST',
    headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return await response.json();
}

function projectId(value: unknown): string {
  return readNestedId(value, 'project');
}

function threadId(value: unknown): string {
  return readNestedId(value, 'thread');
}

function readNestedId(value: unknown, key: string): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('result' in value) ||
    typeof value.result !== 'object' ||
    value.result === null ||
    !(key in value.result) ||
    typeof value.result[key as keyof typeof value.result] !== 'object' ||
    value.result[key as keyof typeof value.result] === null ||
    !('id' in (value.result[key as keyof typeof value.result] as object))
  ) {
    throw new Error(`Missing ${key} id`);
  }
  const id = (value.result[key as keyof typeof value.result] as { id?: unknown }).id;
  if (typeof id !== 'string') throw new Error(`Invalid ${key} id`);
  return id;
}

function createEventReader(body: ReadableStream<Uint8Array>): {
  next(): Promise<{
    readonly event: string;
    readonly id?: string;
    readonly data: string;
  }>;
} {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    async next() {
      for (;;) {
        while (!text.includes('\n\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('SSE stream ended before an event');
          text += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
        }
        const raw = text.slice(0, text.indexOf('\n\n'));
        text = text.slice(text.indexOf('\n\n') + 2);
        const data = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data.length === 0) continue;
        return {
          event:
            raw
              .split('\n')
              .find((line) => line.startsWith('event:'))
              ?.slice(6)
              .trim() ?? 'message',
          id: raw
            .split('\n')
            .find((line) => line.startsWith('id:'))
            ?.slice(3)
            .trim(),
          data,
        };
      }
    },
  };
}
