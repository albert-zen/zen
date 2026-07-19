import { describe, expect, it } from 'vitest';

import type {
  AgentAppClient,
  AgentAppMethod,
  AgentAppNotification,
  AgentAppNotificationEnvelope,
  AgentAppNotificationListener,
  AgentAppRequest,
  AgentAppResponse,
  AgentAppSubscription,
  JsonObject,
  ProjectSnapshot,
  ThreadSnapshot,
} from './test-exports.js';
import {
  BrowserAgentAppTransportClient,
  WebUiClient,
  WebUiLifecycleCanceledError,
} from './test-exports.js';

const PROJECT_ONE = 'project-1';
const PROJECT_TWO = 'project-2';

describe('BrowserAgentAppTransportClient', () => {
  it('uses same-origin routes and sends a project-scoped request', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();

    await client.request(threadListRequest());
    const unsubscribe = client.subscribe(() => undefined);

    expect(harness.requests).toEqual([threadListRequest()]);
    expect(harness.requestUrls).toEqual(['/request']);
    expect(harness.eventUrl).toBe('/events');
    unsubscribe();
  });

  it('waits for first EventSource open before posting a request', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();
    const unsubscribe = client.subscribe(() => undefined);

    const pending = client.request(threadCreateRequest());
    await Promise.resolve();
    expect(harness.requests).toEqual([]);

    harness.events.open();
    await pending;
    expect(harness.requests).toEqual([threadCreateRequest()]);
    unsubscribe();
  });

  it('rejects first-open waiters when EventSource fails without posting', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();
    const unsubscribe = client.subscribe(() => undefined);
    const pending = client.request(threadListRequest());

    harness.events.fail(new Event('error'));

    await expect(pending).rejects.toThrow('Browser event subscription failed before request');
    expect(harness.requests).toEqual([]);
    unsubscribe();
  });

  it('reports HTTP errors, subscription lifecycle, and project envelopes', async () => {
    const statuses: Array<{ status: string; error?: unknown }> = [];
    const received: AgentAppNotificationEnvelope[] = [];
    const harness = new BrowserHarness(() => new Response('upstream unavailable', { status: 503 }));
    const client = harness.client({
      onSubscriptionStatus: (status, error) => statuses.push({ status, error }),
    });
    const unsubscribe = client.subscribe((envelope) => received.push(envelope));

    harness.events.open();
    await expect(client.request(threadListRequest())).rejects.toThrow(
      'Agent App request failed with HTTP 503: upstream unavailable'
    );
    harness.events.emitNotification(PROJECT_ONE, {
      type: 'thread/started',
      thread: thread('thread-1'),
    });
    const failure = new Event('error');
    harness.events.fail(failure);
    unsubscribe();

    expect(received).toEqual([
      {
        projectId: PROJECT_ONE,
        notification: { type: 'thread/started', thread: thread('thread-1') },
      },
    ]);
    expect(statuses).toEqual([
      { status: 'connected' },
      { status: 'failed', error: failure },
      { status: 'disconnected' },
    ]);
  });

  it('blocks requests while reconnect replay is incomplete', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();
    const unsubscribe = client.subscribe(() => undefined);
    harness.events.open();
    harness.events.fail(new Event('error'));

    const pending = client.request(threadCreateRequest());
    harness.events.open();
    await Promise.resolve();
    expect(harness.requests).toEqual([]);

    harness.events.emitSync(2);
    await pending;
    expect(harness.requests).toEqual([threadCreateRequest()]);
    unsubscribe();
  });

  it('replays buffered notification envelopes before reopening requests', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();
    const received: string[] = [];
    const unsubscribe = client.subscribe((envelope) => received.push(envelope.notification.type));
    harness.events.open();
    harness.events.fail(new Event('error'));
    const pending = client.request(threadCreateRequest());
    harness.events.open();

    harness.events.emitNotification(PROJECT_ONE, itemNotification('item-1'));
    harness.events.emitNotification(PROJECT_ONE, approvalNotification('approval-1'));
    harness.events.emitNotification(PROJECT_ONE, completedNotification('turn-1'));
    expect(received).toEqual(['item/appended', 'approval/requested', 'turn/completed']);

    harness.events.emitSync(3);
    await pending;
    expect(received).toEqual(['item/appended', 'approval/requested', 'turn/completed']);
    unsubscribe();
  });

  it('installs an authoritative project reset before releasing effects after a gap', async () => {
    const snapshot = deferred<Response>();
    const harness = new BrowserHarness(async (request) => {
      if (request.method === 'thread/list') return await snapshot.promise;
      return successResponse(request.method, { thread: thread('created') });
    });
    const client = harness.client();
    const received: AgentAppNotificationEnvelope[] = [];
    const unsubscribe = client.subscribe((envelope) => received.push(envelope));
    harness.events.open();
    harness.events.fail(new Event('error'));
    const effect = client.request(threadCreateRequest());
    harness.events.open();
    harness.events.emitReset(9);
    harness.events.emitSync(9);
    await Promise.resolve();

    expect(harness.requests).toEqual([threadListRequest()]);
    snapshot.resolve(threadListResponse('recovered'));
    await effect;

    expect(harness.requests).toEqual([threadListRequest(), threadCreateRequest()]);
    expect(received).toContainEqual({
      projectId: PROJECT_ONE,
      notification: { type: 'sync/reset', threads: [thread('recovered')] },
    });
    unsubscribe();
  });

  it('keeps the effect gate closed when reconnect resnapshot fails', async () => {
    const harness = new BrowserHarness(async (request) =>
      request.method === 'thread/list'
        ? new Response('resnapshot failed', { status: 503 })
        : successResponse(request.method, {})
    );
    const client = harness.client();
    const unsubscribe = client.subscribe(() => undefined);
    harness.events.open();
    harness.events.fail(new Event('error'));
    const effect = client.request(threadCreateRequest());
    harness.events.open();
    harness.events.emitReset(9);
    harness.events.emitSync(9);

    await expect(effect).rejects.toThrow('Reconnect resnapshot failed');
    expect(harness.requests).toEqual([threadListRequest()]);
    unsubscribe();
  });

  it('retains reset debt until a later reconnect installs a successful snapshot', async () => {
    let attempts = 0;
    const harness = new BrowserHarness(async (request) => {
      if (request.method !== 'thread/list') return successResponse(request.method, {});
      attempts += 1;
      return attempts === 1
        ? new Response('resnapshot failed', { status: 503 })
        : threadListResponse('recovered');
    });
    const client = harness.client();
    const unsubscribe = client.subscribe(() => undefined);
    harness.events.open();
    harness.events.fail(new Event('first-error'));
    const first = client.request(threadCreateRequest());
    harness.events.open();
    harness.events.emitReset(9);
    harness.events.emitSync(9);
    await expect(first).rejects.toThrow('Reconnect resnapshot failed');

    harness.events.fail(new Event('second-error'));
    const second = client.request(threadCreateRequest());
    harness.events.open();
    harness.events.emitSync(10);
    await second;

    expect(harness.requests.map((request) => request.method)).toEqual([
      'thread/list',
      'thread/list',
      'thread/create',
    ]);
    unsubscribe();
  });

  it('ignores stale generation snapshots and installs only the current reset', async () => {
    const firstSnapshot = deferred<Response>();
    const secondSnapshot = deferred<Response>();
    const snapshots = [firstSnapshot, secondSnapshot];
    const harness = new BrowserHarness(async (request) => {
      if (request.method === 'project/read')
        return successResponse(request.method, { project: project(PROJECT_ONE) });
      if (request.method === 'thread/list') return await snapshots.shift()!.promise;
      return successResponse(request.method, { thread: thread('created') });
    });
    const client = harness.client();
    await client.request(projectReadRequest());
    harness.clearRequests();
    const installed: string[] = [];
    const unsubscribe = client.subscribe((envelope) => {
      if (envelope.notification.type === 'sync/reset') {
        installed.push(...envelope.notification.threads.map((entry) => entry.id));
      }
    });
    harness.events.open();
    harness.events.fail(new Event('first-error'));
    harness.events.open();
    harness.events.emitReset(1);
    harness.events.emitSync(1);
    await Promise.resolve();

    harness.events.fail(new Event('second-error'));
    const effect = client.request(threadCreateRequest());
    harness.events.open();
    harness.events.emitReset(2);
    harness.events.emitSync(2);
    await Promise.resolve();
    firstSnapshot.resolve(threadListResponse('stale'));
    await Promise.resolve();
    expect(installed).toEqual([]);

    secondSnapshot.resolve(threadListResponse('current'));
    await effect;
    expect(installed).toEqual(['current']);
    unsubscribe();
  });

  it('rejects an open-generation request invalidated synchronously by reconnect', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();
    const unsubscribe = client.subscribe(() => undefined);
    harness.events.open();

    const invalidated = client.request(threadListRequest());
    harness.events.fail(new Event('error'));
    harness.events.open();

    await expect(invalidated).rejects.toThrow('Browser event subscription changed before request');
    expect(harness.requests).toEqual([]);
    harness.events.emitSync(2);
    unsubscribe();
  });

  it('rejects an open-generation request invalidated synchronously by unsubscribe', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();
    const unsubscribe = client.subscribe(() => undefined);
    harness.events.open();

    const invalidated = client.request(threadListRequest());
    unsubscribe();

    await expect(invalidated).rejects.toThrow('Browser event subscription changed before request');
    expect(harness.requests).toEqual([]);
  });

  it('does not POST when reconnect invalidates the outer-await continuation', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();
    const unsubscribe = client.subscribe(() => undefined);
    harness.events.open();

    const invalidated = client.request(threadListRequest());
    queueMicrotask(() =>
      queueMicrotask(() => {
        harness.events.fail(new Event('error'));
        harness.events.open();
      })
    );

    await expect(invalidated).rejects.toThrow('Browser event subscription changed before request');
    expect(harness.requests).toEqual([]);
    harness.events.emitSync(2);
    unsubscribe();
  });

  it('does not POST when unsubscribe invalidates the outer-await continuation', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();
    const unsubscribe = client.subscribe(() => undefined);
    harness.events.open();

    const invalidated = client.request(threadListRequest());
    queueMicrotask(() => queueMicrotask(unsubscribe));

    await expect(invalidated).rejects.toThrow('Browser event subscription changed before request');
    expect(harness.requests).toEqual([]);
  });

  it('disconnect rejects pending readiness and a stale open cannot revive it', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();
    const received: AgentAppNotificationEnvelope[] = [];
    const unsubscribe = client.subscribe((envelope) => received.push(envelope));
    const pending = client.request(threadListRequest());

    unsubscribe();
    harness.events.open();
    harness.events.emitNotification(PROJECT_ONE, {
      type: 'thread/started',
      thread: thread('stale'),
    });

    await expect(pending).rejects.toThrow('Browser event subscription disconnected');
    expect(harness.requests).toEqual([]);
    expect(received).toEqual([]);
  });

  it('resnapshots the most recently requested project and envelopes its reset', async () => {
    const harness = new BrowserHarness();
    const client = harness.client();
    await client.request(threadListRequest(PROJECT_ONE));
    await client.request(threadListRequest(PROJECT_TWO));
    harness.clearRequests();
    const received: AgentAppNotificationEnvelope[] = [];
    const unsubscribe = client.subscribe((envelope) => received.push(envelope));
    harness.events.open();
    harness.events.fail(new Event('error'));
    harness.events.open();
    harness.events.emitReset(5);
    harness.events.emitSync(5);
    await waitFor(() => received.length === 1);

    expect(harness.requests).toEqual([threadListRequest(PROJECT_TWO)]);
    expect(received[0]?.projectId).toBe(PROJECT_TWO);
    expect(received[0]?.notification.type).toBe('sync/reset');
    unsubscribe();
  });
});

describe('project-scoped WebUiClient', () => {
  it('bootstraps no-project state through project/create before thread/create', async () => {
    const client = new FakeAgentAppClient([]);
    const webUi = new WebUiClient({ client, projectRoot: '/workspace', projectName: 'Workspace' });

    await webUi.connect();

    expect(client.requests.map((request) => request.method)).toEqual([
      'project/list',
      'project/create',
      'thread/create',
    ]);
    expect(client.requests[1]?.params).toMatchObject({ name: 'Workspace', rootPath: '/workspace' });
    expect(client.requests[2]?.params.projectId).toBe('created-project');
  });

  it('selects the requested active project and scopes the initial thread read', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE), project(PROJECT_TWO)]);
    const webUi = new WebUiClient({ client });

    await webUi.connect({ projectId: PROJECT_TWO, threadId: 'thread-2' });

    expect(client.requests.at(-1)).toEqual({
      method: 'thread/read',
      params: { projectId: PROJECT_TWO, threadId: 'thread-2' },
    });
    expect(webUi.getSnapshot().state.currentThread?.id).toBe('thread-2');
  });

  it('replays selected-project notifications that arrive during snapshot handoff', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const pending = client.deferNext('thread/read');
    const webUi = new WebUiClient({ client });
    const connecting = webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });
    await waitFor(() => client.subscribeCalls === 1);
    client.emit(PROJECT_ONE, itemNotification('item-2'));
    pending.resolve(
      success('thread/read', {
        thread: thread('thread-1', {
          status: 'running',
          items: [protocolItem('item-1', 1, 'user.message.completed')],
        }),
      })
    );
    await connecting;

    expect([...webUi.getSnapshot().state.items].map((item) => item.id)).toEqual([
      'item-1',
      'item-2',
    ]);
  });

  it('switches projects through an authoritative snapshot without stale notification leakage', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE), project(PROJECT_TWO)]);
    const webUi = new WebUiClient({ client });
    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });
    client.emit(PROJECT_ONE, itemNotification('local'));
    const staleListener = client.lastListener;
    const nextRead = client.deferNext('thread/read');

    const switching = webUi.connect({ projectId: PROJECT_TWO, threadId: 'thread-2' });
    expect([...webUi.getSnapshot().state.items]).toEqual([]);
    staleListener?.({ projectId: PROJECT_ONE, notification: itemNotification('stale') });
    client.emit(PROJECT_ONE, itemNotification('foreign'));
    await waitFor(() => client.subscribeCalls === 2);
    client.emit(PROJECT_TWO, itemNotification('buffered', 'thread-2'));
    await waitFor(() => client.requests.at(-1)?.method === 'thread/read');
    nextRead.resolve(
      success('thread/read', {
        thread: thread('thread-2', {
          items: [protocolItem('authoritative', 1, 'user.message.completed')],
        }),
      })
    );
    await switching;

    expect([...webUi.getSnapshot().state.items].map((item) => item.id)).toEqual([
      'authoritative',
      'buffered',
    ]);
    expect(webUi.getSnapshot().state.currentThread?.id).toBe('thread-2');
    expect(client.activeSubscriptions).toBe(1);
  });

  it('adds projectId and idempotency keys to thread, turn, and approval mutations', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    await webUi.connect({ projectId: PROJECT_ONE });
    await webUi.startThread();
    await webUi.submitMessage('hello');
    await webUi.interruptThread();
    await webUi.retryTurn('turn-1');
    await webUi.resolveApproval(
      { approvalId: 'approval-1', threadId: 'thread-1', turnId: 'turn-1' },
      'decline'
    );

    for (const request of client.requests.filter((entry) => isScopedMethod(entry.method))) {
      expect(request.params.projectId).toBe(PROJECT_ONE);
    }
    for (const request of client.requests.filter((entry) => isMutation(entry.method))) {
      expect(request.params.idempotencyKey).toEqual(expect.any(String));
    }
  });

  it('disconnects the stream and ignores a captured stale callback', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });
    const stale = client.lastListener;

    webUi.disconnect();
    stale?.({ projectId: PROJECT_ONE, notification: itemNotification('stale') });

    expect(webUi.getSnapshot().connection.status).toBe('disconnected');
    expect([...webUi.getSnapshot().state.items]).toEqual([]);
    expect(client.activeSubscriptions).toBe(0);
  });

  it('rejects superseded connect completions and keeps the newer project lifecycle', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE), project(PROJECT_TWO)]);
    const firstList = client.deferNext('project/list');
    const secondList = client.deferNext('project/list');
    const webUi = new WebUiClient({ client });
    const stale = webUi.connect({ projectId: PROJECT_ONE });
    const current = webUi.connect({ projectId: PROJECT_TWO, threadId: 'thread-2' });

    secondList.resolve(success('project/list', { projects: client.projects }));
    await current;
    firstList.resolve(success('project/list', { projects: client.projects }));

    await expect(stale).rejects.toBeInstanceOf(WebUiLifecycleCanceledError);
    expect(webUi.getSnapshot().state.currentThread?.id).toBe('thread-2');
    expect(client.activeSubscriptions).toBe(1);
  });

  it('cancels stale public start and resume loads across lifecycle replacement', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });
    expect(client.subscribeCalls).toBe(1);
    const staleCreate = client.deferNext('thread/create');
    const start = webUi.startThread();
    webUi.disconnect();
    staleCreate.resolve(success('thread/create', { thread: thread('stale') }));
    await expect(start).rejects.toBeInstanceOf(WebUiLifecycleCanceledError);

    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-2' });
    expect(client.subscribeCalls).toBe(2);
    const staleRead = client.deferNext('thread/read');
    const resume = webUi.resumeThread('thread-3');
    webUi.dispose();
    staleRead.resolve(success('thread/read', { thread: thread('stale') }));
    await expect(resume).rejects.toBeInstanceOf(WebUiLifecycleCanceledError);
    expect(client.activeSubscriptions).toBe(0);
  });

  it('does not publish repeated identical create or read snapshots', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    let calls = 0;
    webUi.subscribe(() => (calls += 1));
    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });
    const connected = webUi.getSnapshot();
    const connectedCalls = calls;

    await webUi.startThread();
    await webUi.resumeThread('thread-1');

    expect(webUi.getSnapshot()).toBe(connected);
    expect(calls).toBe(connectedCalls);
  });

  it('does not publish duplicate terminal notifications', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    let calls = 0;
    webUi.subscribe(() => (calls += 1));
    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });
    const completed = completedNotification('turn-1');
    client.emit(PROJECT_ONE, completed);
    const snapshot = webUi.getSnapshot();
    const completedCalls = calls;

    client.emit(PROJECT_ONE, completed);

    expect(webUi.getSnapshot()).toBe(snapshot);
    expect(calls).toBe(completedCalls);
  });

  it('submits a project-scoped turn and projects its immediate start notification once', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });

    await webUi.submitMessage(' hello ');

    const request = client.requests.at(-1);
    expect(request).toMatchObject({
      method: 'turn/start',
      params: { projectId: PROJECT_ONE, threadId: 'thread-1', input: 'hello' },
    });
    expect(webUi.getSnapshot().connection.status).toBe('running');
  });

  it('allows the same project-scoped approval to be retried after rejection', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });
    client.rejectNext('approval/resolve', 'stale approval');
    const approval = { approvalId: 'approval-7', threadId: 'thread-1', turnId: 'turn-9' };

    await expect(webUi.resolveApproval(approval, 'approveOnce')).rejects.toThrow('stale approval');
    await expect(webUi.resolveApproval(approval, 'approveOnce')).resolves.toBeUndefined();

    const requests = client.requests.filter((entry) => entry.method === 'approval/resolve');
    expect(requests).toHaveLength(2);
    expect(requests.every((entry) => entry.params.projectId === PROJECT_ONE)).toBe(true);
  });

  it('sends project-scoped interrupt and retry commands for the active thread', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });

    await webUi.interruptThread();
    await webUi.retryTurn('turn-9');

    expect(client.requests.slice(-2)).toEqual([
      expect.objectContaining({
        method: 'turn/interrupt',
        params: expect.objectContaining({ projectId: PROJECT_ONE, threadId: 'thread-1' }),
      }),
      expect.objectContaining({
        method: 'turn/retry',
        params: expect.objectContaining({
          projectId: PROJECT_ONE,
          threadId: 'thread-1',
          turnId: 'turn-9',
        }),
      }),
    ]);
  });

  it('lists and reads threads only through the selected project', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });

    await expect(webUi.listThreads()).resolves.toHaveLength(2);
    await webUi.resumeThread('thread-2');

    expect(client.requests.slice(-2)).toEqual([
      { method: 'thread/list', params: { projectId: PROJECT_ONE } },
      { method: 'thread/read', params: { projectId: PROJECT_ONE, threadId: 'thread-2' } },
    ]);

    const unexpected = client.deferNext('thread/list');
    const listing = webUi.listThreads();
    unexpected.resolve(success('project/list', { projects: client.projects }));
    await expect(listing).rejects.toThrow('Expected thread/list response, received project/list');

    client.rejectNext('thread/read', 'archived thread is read-only');
    await expect(webUi.resumeThread('thread-2')).rejects.toThrow('archived thread is read-only');
    expect(webUi.getSnapshot().state.currentThread?.id).toBe('thread-2');

    const unexpectedRead = client.deferNext('thread/read');
    const resuming = webUi.resumeThread('thread-1');
    unexpectedRead.resolve(success('thread/list', { threads: [] }));
    await expect(resuming).rejects.toThrow('Expected thread/read response, received thread/list');
    expect(webUi.getSnapshot().state.currentThread?.id).toBe('thread-2');
  });

  it('derives connection and projection from an authoritative selected-project reset', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });
    client.emit(PROJECT_ONE, {
      type: 'sync/reset',
      threads: [
        thread('thread-1', {
          status: 'failed',
          turns: [
            {
              id: 'turn-1',
              runId: 'run-1',
              status: 'failed',
              itemIds: [],
              error: { message: 'snapshot failure' },
            },
          ],
        }),
      ],
    });

    expect(webUi.getSnapshot().connection).toEqual({
      mode: 'real',
      status: 'failed',
      message: 'snapshot failure',
    });
  });

  it('keeps no-op actions silent and exposes rejected runtime actions as failures', async () => {
    const client = new FakeAgentAppClient([project(PROJECT_ONE)]);
    const webUi = new WebUiClient({ client });
    await webUi.submitMessage('   ');
    await webUi.interruptThread();
    await webUi.retryTurn();
    expect(client.requests).toEqual([]);

    await webUi.connect({ projectId: PROJECT_ONE, threadId: 'thread-1' });
    client.rejectNext('turn/start', 'turn start rejected');
    await expect(webUi.submitMessage('start')).rejects.toThrow('turn start rejected');
    expect(webUi.getSnapshot().connection).toMatchObject({
      status: 'failed',
      message: 'turn start rejected',
    });
  });
});

class BrowserHarness {
  readonly events = new ControllableEventSource();
  readonly requests: AgentAppRequest[] = [];
  readonly requestUrls: string[] = [];
  eventUrl?: string;

  constructor(
    private readonly responder: (request: AgentAppRequest) => Promise<Response> | Response = (
      request
    ) => defaultHttpResponse(request)
  ) {}

  client(
    options: {
      readonly onSubscriptionStatus?: (
        status: 'connected' | 'disconnected' | 'failed',
        error?: unknown
      ) => void;
    } = {}
  ): BrowserAgentAppTransportClient {
    return new BrowserAgentAppTransportClient({
      fetch: (async (input, init) => {
        this.requestUrls.push(String(input));
        const request = JSON.parse(String(init?.body)) as AgentAppRequest;
        this.requests.push(request);
        return await this.responder(request);
      }) as typeof fetch,
      createEventSource: (url) => {
        this.eventUrl = url;
        return this.events;
      },
      onSubscriptionStatus: options.onSubscriptionStatus,
    });
  }

  clearRequests(): void {
    this.requests.splice(0);
    this.requestUrls.splice(0);
  }
}

class FakeAgentAppClient implements AgentAppClient {
  readonly requests: AgentAppRequest[] = [];
  readonly projects: ProjectSnapshot[];
  activeSubscriptions = 0;
  subscribeCalls = 0;
  lastListener?: AgentAppNotificationListener;
  private readonly listeners = new Set<AgentAppNotificationListener>();
  private readonly deferred = new Map<
    AgentAppMethod,
    Array<ReturnType<typeof deferred<AgentAppResponse>>>
  >();
  private readonly rejections = new Map<AgentAppMethod, string[]>();

  constructor(projects: readonly ProjectSnapshot[]) {
    this.projects = [...projects];
  }

  deferNext(method: AgentAppMethod): ReturnType<typeof deferred<AgentAppResponse>> {
    const value = deferred<AgentAppResponse>();
    const queue = this.deferred.get(method) ?? [];
    queue.push(value);
    this.deferred.set(method, queue);
    return value;
  }

  rejectNext(method: AgentAppMethod, message: string): void {
    const queue = this.rejections.get(method) ?? [];
    queue.push(message);
    this.rejections.set(method, queue);
  }

  async request(request: AgentAppRequest): Promise<AgentAppResponse> {
    assertProjectScope(request);
    this.requests.push(request);
    const deferredQueue = this.deferred.get(request.method);
    const pending = deferredQueue?.shift();
    if (pending) return await pending.promise;
    const rejection = this.rejections.get(request.method)?.shift();
    if (rejection) return failure(request.method, 'INVALID_REQUEST', rejection);

    if (request.method === 'project/list')
      return success(request.method, { projects: this.projects });
    if (request.method === 'project/create') {
      const created = project('created-project', String(request.params.name ?? 'Created'));
      this.projects.push(created);
      return success(request.method, { project: created });
    }
    if (request.method === 'thread/list')
      return success(request.method, { threads: [thread('thread-1'), thread('thread-2')] });
    if (request.method === 'thread/read')
      return success(request.method, { thread: thread(String(request.params.threadId)) });
    if (request.method === 'thread/create')
      return success(request.method, { thread: thread('thread-1') });
    if (request.method === 'turn/start') {
      this.emit(String(request.params.projectId), {
        type: 'turn/started',
        threadId: String(request.params.threadId),
        turn: turn('turn-1', 'inProgress'),
      });
      return success(request.method, { turn: turn('turn-1', 'inProgress') });
    }
    return success(request.method, { ok: true });
  }

  subscribe(listener: AgentAppNotificationListener): AgentAppSubscription {
    this.listeners.add(listener);
    this.lastListener = listener;
    this.activeSubscriptions += 1;
    this.subscribeCalls += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      this.activeSubscriptions -= 1;
    };
  }

  emit(projectId: string, notification: AgentAppNotification): void {
    this.listeners.forEach((listener) => listener({ projectId, notification }));
  }
}

class RecordingEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  addEventListener(_type: string, _listener: (event: MessageEvent<string>) => void): void {}
  close(): void {}
}

class ControllableEventSource extends RecordingEventSource {
  private notificationListener?: (event: MessageEvent<string>) => void;
  private resetListener?: (event: MessageEvent<string>) => void;
  private syncListener?: (event: MessageEvent<string>) => void;

  override addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    if (type === 'notification') this.notificationListener = listener;
    if (type === 'reset') this.resetListener = listener;
    if (type === 'sync') this.syncListener = listener;
  }

  open(): void {
    this.onopen?.(new Event('open'));
  }

  fail(event: Event): void {
    this.onerror?.(event);
  }

  emitNotification(projectId: string, notification: AgentAppNotification): void {
    this.notificationListener?.({
      data: JSON.stringify({ projectId, notification }),
    } as MessageEvent<string>);
  }

  emitReset(cursor: number): void {
    this.resetListener?.({
      data: JSON.stringify({ streamId: 'stream', cursor }),
    } as MessageEvent<string>);
  }

  emitSync(cursor: number): void {
    this.syncListener?.({
      data: JSON.stringify({ streamId: 'stream', cursor }),
    } as MessageEvent<string>);
  }
}

function project(id: string, name = id): ProjectSnapshot {
  return {
    id,
    name,
    rootPath: `/${id}`,
    createdAtMs: 1,
    updatedAtMs: 1,
    status: 'active',
    policy: {
      maxActiveExecutions: 2,
      maxThreadDepth: 4,
      agentCanCreateThreads: true,
      agentCanMessagePeers: true,
    },
  };
}

function thread(id: string, overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return { id, status: 'idle', turns: [], items: [], ...overrides };
}

function turn(id: string, status: 'inProgress' | 'completed' | 'failed' | 'canceled') {
  return { id, runId: `run-${id}`, status, itemIds: [] } as const;
}

function protocolItem(id: string, seq: number, type: string) {
  return {
    id,
    seq,
    type,
    createdAtMs: seq,
    runId: 'run-1',
    turnId: 'turn-1',
    payload: {},
  };
}

function itemNotification(id: string, threadId = 'thread-1'): AgentAppNotification {
  return {
    type: 'item/appended',
    threadId,
    turnId: 'turn-1',
    item: protocolItem(id, 2, 'assistant.message.completed'),
  };
}

function approvalNotification(id: string): AgentAppNotification {
  return {
    type: 'approval/requested',
    threadId: 'thread-1',
    turnId: 'turn-1',
    approvalId: id,
    item: protocolItem('approval-item', 3, 'approval.requested'),
  };
}

function completedNotification(id: string): AgentAppNotification {
  return {
    type: 'turn/completed',
    threadId: 'thread-1',
    turn: turn(id, 'completed'),
  };
}

function request(method: AgentAppMethod, params: JsonObject): AgentAppRequest {
  return { method, params };
}

function threadListRequest(projectId = PROJECT_ONE): AgentAppRequest {
  return request('thread/list', { projectId });
}

function threadCreateRequest(projectId = PROJECT_ONE): AgentAppRequest {
  return request('thread/create', { projectId, idempotencyKey: `create-${projectId}` });
}

function projectReadRequest(projectId = PROJECT_ONE): AgentAppRequest {
  return request('project/read', { projectId });
}

function success(method: AgentAppMethod, result: Record<string, unknown>): AgentAppResponse {
  return { method, ok: true, result };
}

function failure(
  method: AgentAppMethod,
  code: 'INVALID_REQUEST',
  message: string
): AgentAppResponse {
  return { method, ok: false, error: { code, message } };
}

function successResponse(method: AgentAppMethod, result: Record<string, unknown>): Response {
  return new Response(JSON.stringify(success(method, result)));
}

function defaultHttpResponse(request: AgentAppRequest): Response {
  if (request.method === 'thread/list') return successResponse(request.method, { threads: [] });
  if (request.method === 'project/read')
    return successResponse(request.method, { project: project(String(request.params.projectId)) });
  return successResponse(request.method, { thread: thread('thread-1') });
}

function threadListResponse(threadId: string): Response {
  return successResponse('thread/list', { threads: [thread(threadId)] });
}

function assertProjectScope(request: AgentAppRequest): void {
  if (!isScopedMethod(request.method)) return;
  if (typeof request.params.projectId !== 'string' || request.params.projectId.length === 0) {
    throw new Error(`${request.method} missing projectId`);
  }
}

function isScopedMethod(method: AgentAppMethod): boolean {
  return method !== 'project/list' && method !== 'project/create';
}

function isMutation(method: AgentAppMethod): boolean {
  return [
    'project/create',
    'project/update',
    'project/archive',
    'thread/create',
    'thread/send',
    'thread/wait',
    'thread/cancel',
    'thread/archive',
    'thread/handoff',
    'turn/start',
    'turn/interrupt',
    'turn/retry',
    'approval/resolve',
  ].includes(method);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition did not settle');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
