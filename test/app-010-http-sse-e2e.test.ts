import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createAgentAppProductionComposition,
  serveAgentAppHttpTransport,
  type ModelContext,
  type ProjectPolicy,
} from './test-exports.js';

describe('APP-010 real multi-project HTTP/SSE workflow', () => {
  it('covers queued execution, durable wait, handoff, archive, and reconnect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-app-010-http-'));
    const firstRoot = join(root, 'first');
    const secondRoot = join(root, 'second');
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    let waitTargetId = '';
    let active = 0;
    let maximumActive = 0;
    const composition = await createAgentAppProductionComposition({
      appDataRoot: join(root, 'app-data'),
      createModel: () => ({
        async *generate(context) {
          const input = latestUserContent(context);
          const gate =
            input === 'concurrency-one'
              ? firstGate
              : input === 'concurrency-two'
                ? secondGate
                : undefined;
          if (gate) {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            try {
              await gate.promise;
              yield { type: 'message.completed' as const, content: 'concurrency done' };
            } finally {
              active -= 1;
            }
            return;
          }
          if (input === 'wait-source') {
            yield {
              type: 'message.completed' as const,
              content: 'wait',
              toolCalls: [
                {
                  id: 'http-wait-call',
                  name: 'thread.wait',
                  input: {
                    threadIds: [waitTargetId],
                    mode: 'all',
                    idempotencyKey: 'http-wait',
                  },
                },
              ],
            };
            return;
          }
          yield { type: 'message.completed' as const, content: 'done' };
        },
      }),
    });
    const transport = await serveAgentAppHttpTransport({
      agentAppServer: composition.agentAppServer,
    });
    const streamAbort = new AbortController();
    try {
      const stream = await openEventStream(transport.url, transport.capability, streamAbort);
      expect((await stream.next()).event).toBe('sync');
      const first = await request(transport.url, transport.capability, {
        method: 'project/create',
        params: {
          name: 'First',
          rootPath: firstRoot,
          policy: policy({ maxActiveExecutions: 1 }),
          idempotencyKey: 'first-project',
        },
      });
      const second = await request(transport.url, transport.capability, {
        method: 'project/create',
        params: {
          name: 'Second',
          rootPath: secondRoot,
          policy: policy(),
          idempotencyKey: 'second-project',
        },
      });
      const firstProjectId = nestedId(first, 'project');
      const secondProjectId = nestedId(second, 'project');
      const concurrencyOne = await createThread(
        transport.url,
        transport.capability,
        firstProjectId,
        'concurrency-one'
      );
      const concurrencyTwo = await createThread(
        transport.url,
        transport.capability,
        firstProjectId,
        'concurrency-two'
      );
      const waitSource = await createThread(
        transport.url,
        transport.capability,
        firstProjectId,
        'wait-source'
      );
      waitTargetId = await createThread(
        transport.url,
        transport.capability,
        firstProjectId,
        'wait-target'
      );
      const handoffTarget = await createThread(
        transport.url,
        transport.capability,
        firstProjectId,
        'handoff-target'
      );
      const archivedThread = await createThread(
        transport.url,
        transport.capability,
        firstProjectId,
        'archive-target'
      );
      await createThread(
        transport.url,
        transport.capability,
        secondProjectId,
        'second-project-thread'
      );

      await startTurn(
        transport.url,
        transport.capability,
        firstProjectId,
        concurrencyOne,
        'concurrency-one',
        'concurrency-turn-one'
      );
      await startTurn(
        transport.url,
        transport.capability,
        firstProjectId,
        concurrencyTwo,
        'concurrency-two',
        'concurrency-turn-two'
      );
      await expect.poll(() => active).toBe(1);
      expect(
        (await readThread(transport.url, transport.capability, firstProjectId, concurrencyTwo))
          .turns[0]?.status
      ).toBe('queued');
      firstGate.resolve();
      await expect.poll(() => active).toBe(1);
      secondGate.resolve();
      await expect
        .poll(
          async () =>
            (await readThread(transport.url, transport.capability, firstProjectId, concurrencyTwo))
              .turns[0]?.status
        )
        .toBe('completed');
      expect(maximumActive).toBe(1);

      await startTurn(
        transport.url,
        transport.capability,
        firstProjectId,
        waitSource,
        'wait-source',
        'wait-source-turn'
      );
      await expect
        .poll(
          async () =>
            (await readThread(transport.url, transport.capability, firstProjectId, waitSource))
              .turns[0]?.status
        )
        .toBe('waiting');
      await startTurn(
        transport.url,
        transport.capability,
        firstProjectId,
        waitTargetId,
        'finish-wait-target',
        'wait-target-turn'
      );
      await expect
        .poll(async () => {
          const turns = (
            await readThread(transport.url, transport.capability, firstProjectId, waitSource)
          ).turns;
          return turns.length === 2 ? turns[1]?.status : undefined;
        })
        .toBe('completed');

      const handoff = await request(transport.url, transport.capability, {
        method: 'thread/handoff',
        params: {
          projectId: firstProjectId,
          sourceThreadId: waitTargetId,
          threadId: handoffTarget,
          content: 'HTTP handoff',
          idempotencyKey: 'http-handoff',
        },
      });
      expect(handoff).toMatchObject({ ok: true });
      await expect
        .poll(
          async () =>
            (await readThread(transport.url, transport.capability, firstProjectId, handoffTarget))
              .turns.length
        )
        .toBe(1);

      const archive = await request(transport.url, transport.capability, {
        method: 'thread/archive',
        params: {
          projectId: firstProjectId,
          threadId: archivedThread,
          idempotencyKey: 'http-archive',
        },
      });
      expect(archive).toMatchObject({ ok: true });
      await expect(
        request(transport.url, transport.capability, {
          method: 'thread/read',
          params: { projectId: firstProjectId, threadId: archivedThread },
        })
      ).resolves.toMatchObject({ ok: true });
      await expect(
        request(transport.url, transport.capability, {
          method: 'turn/start',
          params: {
            projectId: firstProjectId,
            threadId: archivedThread,
            input: 'denied',
            idempotencyKey: 'http-archive-denied',
          },
        })
      ).resolves.toMatchObject({ ok: false });

      const observedProjects = new Set<string>();
      for (let index = 0; index < 40 && observedProjects.size < 2; index += 1) {
        const event = await stream.next();
        if (event.event === 'notification') {
          observedProjects.add(String(JSON.parse(event.data).projectId));
        }
      }
      expect(observedProjects).toEqual(new Set([firstProjectId, secondProjectId]));

      streamAbort.abort();
      const reconnectAbort = new AbortController();
      const reconnected = await openEventStream(
        transport.url,
        transport.capability,
        reconnectAbort,
        'foreign-stream:1'
      );
      expect((await reconnected.next()).event).toBe('reset');
      expect((await reconnected.next()).event).toBe('sync');
      reconnectAbort.abort();
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      streamAbort.abort();
      await transport.close();
      await composition.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function policy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    maxActiveExecutions: 2,
    maxThreadDepth: 4,
    maxThreads: 100,
    maxQueuedMessages: 100,
    maxWaitTargets: 16,
    maxMessageBytes: 16_384,
    idempotencyRetention: 1_000,
    agentCanCreateThreads: true,
    agentCanMessagePeers: true,
    ...overrides,
  };
}

async function request(url: string, capability: string, body: unknown) {
  const response = await fetch(new URL('/request', url), {
    method: 'POST',
    headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as HttpResponseBody;
}

async function createThread(url: string, capability: string, projectId: string, key: string) {
  return nestedId(
    await request(url, capability, {
      method: 'thread/create',
      params: { projectId, idempotencyKey: `thread-${key}` },
    }),
    'thread'
  );
}

async function startTurn(
  url: string,
  capability: string,
  projectId: string,
  threadId: string,
  input: string,
  idempotencyKey: string
) {
  const response = await request(url, capability, {
    method: 'turn/start',
    params: { projectId, threadId, input, idempotencyKey },
  });
  expect(response).toMatchObject({ ok: true });
}

async function readThread(url: string, capability: string, projectId: string, threadId: string) {
  const response = await request(url, capability, {
    method: 'thread/read',
    params: { projectId, threadId },
  });
  if (response.ok !== true || !isRecord(response.result) || !isRecord(response.result.thread)) {
    throw new Error(readHttpError(response));
  }
  return response.result.thread as {
    readonly turns: readonly { readonly id: string; readonly status: string }[];
  };
}

function nestedId(response: HttpResponseBody, key: string): string {
  const nested = isRecord(response.result) ? response.result[key] : undefined;
  const id = isRecord(nested) ? nested.id : undefined;
  if (typeof id !== 'string') throw new Error(`Missing ${key} id`);
  return id;
}

type HttpResponseBody = {
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readHttpError(response: HttpResponseBody): string {
  if (isRecord(response.error) && typeof response.error.message === 'string') {
    return response.error.message;
  }
  return 'HTTP Agent App request failed';
}

function latestUserContent(context: ModelContext): unknown {
  return context.parts.filter((part) => part.type === 'message' && part.role === 'user').at(-1)
    ?.content;
}

async function openEventStream(
  url: string,
  capability: string,
  controller: AbortController,
  lastEventId?: string
) {
  const response = await fetch(new URL('/events', url), {
    headers: {
      authorization: `Bearer ${capability}`,
      ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
    },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    async next(): Promise<{ readonly event: string; readonly data: string }> {
      for (;;) {
        while (!text.includes('\n\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('SSE stream ended');
          text += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
        }
        const separator = text.indexOf('\n\n');
        const raw = text.slice(0, separator);
        text = text.slice(separator + 2);
        const event = raw
          .split('\n')
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        const data = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (event && data) return { event, data };
      }
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve: (value?: T) => resolve(value as T) };
}
