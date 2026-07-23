import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpAgentAppClient } from '@zen/framework/node';
import { afterEach, describe, expect, it } from 'vitest';

import type { ImZenConfig } from '../apps/imzen/src/config.js';
import { ImZenStateStore } from '../apps/imzen/src/state-store.js';
import type { QQInboundMessage, QQOutboundMessage } from '../apps/imzen/src/types.js';
import { ImZenBridge } from '../apps/imzen/src/zen-bridge.js';
import { serveDesktopStaticHost } from '../apps/zenx/src/static-host.js';
import {
  createAgentAppProductionComposition,
  serveAgentAppHttpTransport,
  type ModelContext,
} from './test-exports.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))
  );
});

describe('shared ZenX and IMZen App Server', () => {
  it('continues one durable Thread through one runtime and ZenX SSE', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-shared-clients-'));
    roots.push(root);
    const projectRoot = join(root, 'project');
    const staticRoot = join(root, 'web');
    await mkdir(projectRoot);
    await mkdir(staticRoot);
    await writeFile(join(staticRoot, 'index.html'), '<div id="root"></div>');

    let compositionCount = 0;
    compositionCount += 1;
    const composition = await createAgentAppProductionComposition({
      appDataRoot: join(root, 'app-data'),
      createModel: () => ({
        async *generate(context: ModelContext) {
          yield {
            type: 'message.completed' as const,
            content: `reply:${latestUserContent(context)}`,
          };
        },
      }),
    });
    const transport = await serveAgentAppHttpTransport({
      agentAppServer: composition.agentAppServer,
    });
    const zenxHost = await serveDesktopStaticHost({
      apiTarget: transport.url,
      capability: transport.capability,
      staticRoot,
    });
    const streamAbort = new AbortController();
    const imzenClient = new HttpAgentAppClient({
      baseUrl: transport.url,
      capability: transport.capability,
    });
    let bridge: ImZenBridge | undefined;

    try {
      expect(compositionCount).toBe(1);
      const streamResponse = await fetch(new URL('/events', zenxHost.url), {
        headers: zenxHeaders(zenxHost.url, { accept: 'text/event-stream' }),
        signal: streamAbort.signal,
      });
      expect(streamResponse.status).toBe(200);
      const events = createEventReader(streamResponse.body!);
      expect((await events.next()).event).toBe('sync');

      const project = await zenxRequest(zenxHost.url, {
        method: 'project/create',
        params: {
          name: 'Shared',
          rootPath: projectRoot,
          idempotencyKey: 'zenx-project',
        },
      });
      const projectId = nestedId(project, 'project');
      const createdThread = await zenxRequest(zenxHost.url, {
        method: 'thread/create',
        params: {
          projectId,
          objective: 'Started in ZenX',
          idempotencyKey: 'zenx-thread',
        },
      });
      const threadId = nestedId(createdThread, 'thread');
      await zenxRequest(zenxHost.url, {
        method: 'turn/start',
        params: {
          projectId,
          threadId,
          input: 'first from zenx',
          idempotencyKey: 'zenx-turn',
        },
      });
      await waitUntil(async () => {
        const thread = nestedRecord(
          await zenxRequest(zenxHost.url, {
            method: 'thread/read',
            params: { projectId, threadId },
          }),
          'thread'
        );
        return completedTurns(thread).length === 1;
      });

      const state = await ImZenStateStore.open(join(root, 'imzen', 'state.json'));
      const delivered: QQOutboundMessage[] = [];
      bridge = new ImZenBridge({
        client: imzenClient,
        config: config(root, projectRoot, projectId, transport.url, transport.capability),
        deliver: async (message) => {
          delivered.push(message);
        },
        pollIntervalMs: 5,
        state,
      });
      await bridge.start();
      await bridge.accept(qqMessage('threads', '/threads'));
      await bridge.accept(qqMessage('bind', `/bind ${threadId}`));
      expect(state.binding('c2c:owner')).toEqual({ projectId, threadId });
      await bridge.accept(qqMessage('continue', 'second from imzen'));
      await waitUntil(async () =>
        delivered.some((message) => message.text === 'reply:second from imzen')
      );

      const durableThread = nestedRecord(
        await zenxRequest(zenxHost.url, {
          method: 'thread/read',
          params: { projectId, threadId },
        }),
        'thread'
      );
      const durableTurns = completedTurns(durableThread);
      expect(durableTurns).toHaveLength(2);
      const firstTurnId = stringField(durableTurns[0]!, 'id');
      const continuationTurn = durableTurns[1]!;
      const continuationTurnId = stringField(continuationTurn, 'id');
      const continuationItemIds = stringArrayField(continuationTurn, 'itemIds');
      expect(continuationTurnId).not.toBe(firstTurnId);
      expect(continuationItemIds.length).toBeGreaterThan(0);
      expect(itemContents(durableThread)).toEqual(
        expect.arrayContaining([
          'first from zenx',
          'reply:first from zenx',
          'second from imzen',
          'reply:second from imzen',
        ])
      );

      let observedContinuation: Record<string, unknown> | undefined;
      for (let index = 0; index < 30 && !observedContinuation; index += 1) {
        const event = await events.next();
        if (event.event !== 'notification') continue;
        const envelope = JSON.parse(event.data) as Record<string, unknown>;
        const notification = isRecord(envelope.notification) ? envelope.notification : {};
        const turn = isRecord(notification.turn) ? notification.turn : undefined;
        if (
          envelope.projectId === projectId &&
          notification.type === 'turn/completed' &&
          notification.threadId === threadId &&
          turn?.id === continuationTurnId
        ) {
          observedContinuation = notification;
        }
      }
      expect(observedContinuation).toMatchObject({
        threadId,
        turn: {
          id: continuationTurnId,
          itemIds: continuationItemIds,
          status: 'completed',
        },
        type: 'turn/completed',
      });
    } finally {
      streamAbort.abort();
      await bridge?.stop();
      await imzenClient.close();
      await zenxHost.close();
      await transport.close();
      await composition.close();
    }
  }, 30_000);
});

async function zenxRequest(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL('/request', url), {
    method: 'POST',
    headers: zenxHeaders(url, {
      accept: 'application/json',
      'content-type': 'application/json',
    }),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function zenxHeaders(origin: string, extra: Record<string, string>): Record<string, string> {
  return {
    ...extra,
    origin,
    'sec-fetch-site': 'same-origin',
  };
}

function config(
  root: string,
  projectRoot: string,
  projectId: string,
  appServerUrl: string,
  appServerCapability: string
): ImZenConfig {
  return {
    allowedUserIds: new Set(['owner']),
    appServerCapability,
    appServerUrl,
    dataDir: join(root, 'imzen'),
    projectId,
    projectRoot,
    qqApiBase: 'https://api.sgroup.qq.com',
    qqCredential: { appId: '1', appSecret: 'test-only' },
    qqSecretFile: join(root, 'qq-secret.json'),
  };
}

function qqMessage(messageId: string, text: string): QQInboundMessage {
  return {
    conversationId: 'c2c:owner',
    kind: 'c2c',
    messageId,
    receivedAtMs: Date.now(),
    text,
    userId: 'owner',
  };
}

function nestedId(value: Record<string, unknown>, field: string): string {
  const nested = nestedRecord(value, field);
  const id =
    typeof nested.id === 'string'
      ? nested.id
      : typeof nested.threadId === 'string'
        ? nested.threadId
        : undefined;
  if (!id) throw new Error(`Missing ${field} id`);
  return id;
}

function nestedRecord(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const result = isRecord(value.result) ? value.result : undefined;
  const nested = result && isRecord(result[field]) ? result[field] : undefined;
  if (!nested) throw new Error(`Missing ${field}`);
  return nested;
}

function completedTurns(thread: Record<string, unknown>): readonly Record<string, unknown>[] {
  return Array.isArray(thread.turns)
    ? thread.turns.filter((turn) => isRecord(turn) && turn.status === 'completed')
    : [];
}

function itemContents(thread: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(thread.items)) return [];
  return thread.items.flatMap((item) => {
    if (!isRecord(item) || !isRecord(item.payload)) return [];
    return typeof item.payload.content === 'string' ? [item.payload.content] : [];
  });
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string') throw new Error(`Missing ${field}`);
  return result;
}

function stringArrayField(value: Record<string, unknown>, field: string): readonly string[] {
  const result = value[field];
  if (!Array.isArray(result) || result.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Missing ${field}`);
  }
  return result;
}

function latestUserContent(context: ModelContext): string {
  const content = context.parts
    .filter((part) => part.type === 'message' && part.role === 'user')
    .at(-1)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error('Timed out waiting for shared App Server state');
}

function createEventReader(body: ReadableStream<Uint8Array>): {
  next(): Promise<{ readonly event: string; readonly data: string }>;
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
        const separator = text.indexOf('\n\n');
        const raw = text.slice(0, separator);
        text = text.slice(separator + 2);
        const data = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!data) continue;
        const event =
          raw
            .split('\n')
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim() ?? 'message';
        return { event, data };
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
