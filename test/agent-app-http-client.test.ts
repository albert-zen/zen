import { randomBytes } from 'node:crypto';

import { HttpAgentAppClient, serveAgentAppHttpTransport } from '@zen/framework/node';
import type {
  AgentAppClient,
  AgentAppNotificationEnvelope,
  AgentAppRequest,
  AgentAppResponse,
} from '@zen/framework/product';
import { describe, expect, it } from 'vitest';

describe('HttpAgentAppClient', () => {
  it('uses the authenticated project-scoped transport and preserves notification envelopes', async () => {
    const listeners = new Set<(notification: AgentAppNotificationEnvelope) => void>();
    const server: AgentAppClient = {
      async request(request: AgentAppRequest): Promise<AgentAppResponse> {
        expect(request).toEqual({ method: 'project/list', params: {} });
        return {
          method: 'project/list',
          ok: true,
          result: { projects: [{ id: 'project-1' }] },
        };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const transport = await serveAgentAppHttpTransport({
      agentAppServer: server,
      capability: randomBytes(32).toString('base64url'),
      host: '127.0.0.1',
      port: 0,
    });
    const client = new HttpAgentAppClient({
      baseUrl: transport.url,
      capability: transport.capability,
    });
    const notifications: AgentAppNotificationEnvelope[] = [];
    const unsubscribe = client.subscribe((notification) => notifications.push(notification));

    await expect(client.request({ method: 'project/list', params: {} })).resolves.toMatchObject({
      method: 'project/list',
      ok: true,
      result: { projects: [{ id: 'project-1' }] },
    });
    const envelope: AgentAppNotificationEnvelope = {
      projectId: 'project-1',
      notification: { type: 'sync/reset', threads: [] },
    };
    listeners.forEach((listener) => listener(envelope));
    await waitUntil(() => notifications.length === 1);
    expect(notifications).toEqual([envelope]);

    unsubscribe();
    await client.close();
    await transport.close();
  });

  it('exposes an additive close lifecycle that settles an ignored in-flight fetch', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = ((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const client = new HttpAgentAppClient({
      baseUrl: 'http://127.0.0.1:1',
      capability: randomBytes(32).toString('base64url'),
      fetch: fetchImpl,
      requestTimeoutMs: 10_000,
    });
    const request = client.request({ method: 'project/list', params: {} });

    try {
      await waitUntil(() => signal !== undefined);
      await expect(client.close()).resolves.toBeUndefined();
      await expect(request).rejects.toMatchObject({
        name: 'AppServerTransportError',
        code: 'CLIENT_CLOSED',
      });
      expect(signal?.aborted).toBe(true);
    } finally {
      await client.close();
    }
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error('Timed out waiting for HTTP Agent App notification');
}
