import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AgentAppServer,
  AppServer,
  FileProjectCommandStore,
  FileProjectCoordinationJournal,
  FileThreadJournal,
  InMemoryProjectRegistry,
  ProjectCommandLedger,
  ProjectCoordinator,
  ProjectManager,
  ThreadManager,
  createAgentAppProductionComposition,
  replayThreadJournal,
  type AgentAppRequest,
  type AgentAppResponse,
  type ProjectCoordinationItem,
  type ProjectCoordinationJournal,
  type ProjectRuntime,
  type ProjectSnapshot,
} from './test-exports.js';

describe('APP-010 final blocker remediation', () => {
  it('re-enqueues one durably activated message Turn after real journal close/reopen', async () => {
    await withDurableProject(async ({ root, projects, project }) => {
      const firstExecutions = counter();
      const first = await openDurableRuntime(root, projects, project.id, {
        executions: firstExecutions,
        blockExecutionLease: true,
      });
      const source = await first.coordinator.createThread({
        projectId: project.id,
        idempotencyKey: 'source',
      });
      const target = await first.coordinator.createThread({
        projectId: project.id,
        idempotencyKey: 'target',
      });

      await first.coordinator.sendMessage({
        projectId: project.id,
        sourceThreadId: source.threadId,
        targetThreadId: target.threadId,
        content: 'resume this durable message',
        idempotencyKey: 'message',
      });
      await expect.poll(first.leaseAttempts).toBe(1);
      expect(first.manager.readThread(target.threadId).turns).toEqual([
        expect.objectContaining({ status: 'queued' }),
      ]);
      expect(firstExecutions.read()).toBe(0);
      await first.crashClose();

      const restartedExecutions = counter();
      const restarted = await openDurableRuntime(root, projects, project.id, {
        executions: restartedExecutions,
      });
      try {
        await expect.poll(restartedExecutions.read).toBe(1);
        await expect
          .poll(() => restarted.manager.readThread(target.threadId).turns.at(-1)?.status)
          .toBe('completed');
        await restarted.coordinator.recover(project.id);
        await Promise.resolve();
        expect(restartedExecutions.read()).toBe(1);
        expect(
          restarted.manager
            .readThread(target.threadId)
            .items.filter((item) => item.type === 'turn.repaired')
        ).toEqual([]);
      } finally {
        await restarted.close();
      }
    });
  });

  it('re-enqueues one resolved wait continuation after real journal close/reopen', async () => {
    await withDurableProject(async ({ root, projects, project }) => {
      const first = await openDurableRuntime(root, projects, project.id, {
        executions: counter(),
        blockExecutionLease: true,
      });
      const source = await first.coordinator.createThread({
        projectId: project.id,
        idempotencyKey: 'wait-source',
      });
      const target = await first.coordinator.createThread({
        projectId: project.id,
        idempotencyKey: 'wait-target',
      });
      await first.coordinator.startWait({
        projectId: project.id,
        sourceThreadId: source.threadId,
        targetThreadIds: [target.threadId],
        mode: 'all',
        idempotencyKey: 'wait',
      });
      await first.coordinator.recordExecutionSettled({
        projectId: project.id,
        threadId: target.threadId,
        turnId: 'target-terminal',
        status: 'completed',
      });
      await expect.poll(first.leaseAttempts).toBe(1);
      expect(first.manager.readThread(source.threadId).turns.at(-1)?.status).toBe('queued');
      await first.crashClose();

      const restartedExecutions = counter();
      const restarted = await openDurableRuntime(root, projects, project.id, {
        executions: restartedExecutions,
      });
      try {
        await expect.poll(restartedExecutions.read).toBe(1);
        await expect
          .poll(() => restarted.manager.readThread(source.threadId).turns.at(-1)?.status)
          .toBe('completed');
        await restarted.coordinator.recover(project.id);
        await Promise.resolve();
        expect(restartedExecutions.read()).toBe(1);
      } finally {
        await restarted.close();
      }
    });
  });

  it('resumes canceled conversations through new durable UI/Agent work but denies canceled sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zen-agent-blocker-cancel-'));
    let composition: Awaited<ReturnType<typeof createAgentAppProductionComposition>> | undefined;
    let project!: ProjectSnapshot;
    const observedStatuses: string[] = [];
    let expectedExecutingThreadId: string | undefined;
    let executorCalls = 0;
    try {
      await mkdir(join(root, 'workspace'));
      composition = await createAgentAppProductionComposition({
        appDataRoot: root,
        createModel: () => ({
          async *generate() {
            executorCalls += 1;
            const listed = await composition!.agentAppServer.request({
              method: 'thread/list',
              params: { projectId: project.id },
            });
            if (listed.ok) {
              const summaries = listed.result.threads as Array<{
                threadId: string;
                status?: unknown;
              }>;
              observedStatuses.push(
                String(
                  summaries.find((summary) => summary.threadId === expectedExecutingThreadId)
                    ?.status
                )
              );
            }
            yield { type: 'message.completed' as const, content: 'resumed' };
          },
        }),
      });
      const createdProject = await composition.agentAppServer.request({
        method: 'project/create',
        params: {
          name: 'Cancellation',
          rootPath: join(root, 'workspace'),
          idempotencyKey: 'project',
        },
      });
      project = readProject(createdProject);
      const uiThread = await createThread(composition.agentAppServer, project.id, 'ui');
      const source = await createThread(composition.agentAppServer, project.id, 'source');
      const target = await createThread(composition.agentAppServer, project.id, 'target');

      await cancelThread(composition.agentAppServer, project.id, uiThread, 'cancel-ui');
      expect(await summaryStatus(composition.agentAppServer, project.id, uiThread)).toBe(
        'canceled'
      );
      expect(executorCalls).toBe(0);
      expectedExecutingThreadId = uiThread;
      await expect(
        composition.agentAppServer.request({
          method: 'turn/start',
          params: {
            projectId: project.id,
            threadId: uiThread,
            input: 'new UI work',
            idempotencyKey: 'resume-ui',
          },
        })
      ).resolves.toMatchObject({ ok: true });
      await expect.poll(() => executorCalls).toBe(1);
      expect(observedStatuses).not.toContain('canceled');
      const resumed = await composition.agentAppServer.request({
        method: 'thread/read',
        params: { projectId: project.id, threadId: uiThread },
      });
      expect(readThread(resumed).items.map((item) => item.type)).toContain('turn.queued');

      await cancelThread(composition.agentAppServer, project.id, target, 'cancel-target');
      expectedExecutingThreadId = target;
      const handoff = await composition.agentAppServer.requestFromAgent(
        {
          method: 'thread/handoff',
          params: {
            projectId: project.id,
            sourceThreadId: source,
            threadId: target,
            content: 'resume canceled target',
            idempotencyKey: 'resume-target',
          },
        },
        agentContext(project, source)
      );
      expect(handoff).toMatchObject({ ok: true });
      await expect.poll(() => executorCalls).toBe(2);
      expect(await summaryStatus(composition.agentAppServer, project.id, target)).not.toBe(
        'canceled'
      );

      await cancelThread(composition.agentAppServer, project.id, source, 'cancel-source');
      await expect(
        composition.agentAppServer.requestFromAgent(
          {
            method: 'thread/send',
            params: {
              projectId: project.id,
              sourceThreadId: source,
              threadId: target,
              content: 'must be denied',
              idempotencyKey: 'canceled-source-send',
            },
          },
          agentContext(project, source)
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
      expect(executorCalls).toBe(2);
    } finally {
      await composition?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers a durable handoff outbox and completes the pending outer ledger exactly once', async () => {
    await withDurableProject(async ({ root, projects, project }) => {
      const blockingJournal = new BlockingNestedMessageJournal(
        new FileProjectCoordinationJournal({ filePath: join(root, 'coordination.jsonl') })
      );
      const first = await openDurableRuntime(root, projects, project.id, {
        executions: counter(),
        coordinationJournal: blockingJournal,
      });
      const source = await first.coordinator.createThread({
        projectId: project.id,
        idempotencyKey: 'handoff-source',
      });
      const target = await first.coordinator.createThread({
        projectId: project.id,
        idempotencyKey: 'handoff-target',
      });
      const request = handoffRequest(project.id, source.threadId, target.threadId);
      const commandPath = join(root, 'commands.json');
      const firstServer = new AgentAppServer({
        projectManager: projects,
        commandLedger: await ProjectCommandLedger.open(new FileProjectCommandStore(commandPath)),
        createRuntime: async () => coordinatorRuntime(first.coordinator),
      });

      blockingJournal.blockNestedMessages();
      const interrupted = firstServer.request(request);
      void interrupted.catch(() => undefined);
      await blockingJournal.waitUntilBlocked();
      expect(
        first.coordinator
          .listCoordinationItems(project.id)
          .filter((item) => item.type === 'thread.handoff')
      ).toHaveLength(1);
      expect(
        first.coordinator
          .listCoordinationItems(project.id)
          .filter((item) => item.type === 'thread.message.sent')
      ).toHaveLength(0);
      await first.crashClose();

      const restartedExecutions = counter();
      const restarted = await openDurableRuntime(root, projects, project.id, {
        executions: restartedExecutions,
      });
      const restartedServer = new AgentAppServer({
        projectManager: projects,
        commandLedger: await ProjectCommandLedger.open(new FileProjectCommandStore(commandPath)),
        createRuntime: async () => coordinatorRuntime(restarted.coordinator),
      });
      try {
        const recovered = await restartedServer.request(request);
        expect(recovered).toMatchObject({ ok: true });
        await expect(restartedServer.request(request)).resolves.toEqual(recovered);
        await expect.poll(restartedExecutions.read).toBe(1);
        const items = restarted.coordinator.listCoordinationItems(project.id);
        const handoff = items.find((item) => item.type === 'thread.handoff');
        expect(items.filter((item) => item.type === 'thread.handoff')).toHaveLength(1);
        expect(
          items.filter(
            (item) => item.type === 'thread.message.sent' && item.causeId === handoff?.id
          )
        ).toHaveLength(1);
        expect(
          items.filter(
            (item) => item.type === 'coordination.command.completed' && item.causeId === handoff?.id
          )
        ).toHaveLength(1);
      } finally {
        await restartedServer.close();
        await restarted.close();
      }
    });
  });

  it('coalesces identical in-flight payloads but conflicts on a different digest', async () => {
    const projects = await ProjectManager.open({ registry: new InMemoryProjectRegistry() });
    const project = await projects.create({ name: 'Concurrent', rootPath: 'C:\\concurrent' });
    const response = deferred<AgentAppResponse>();
    let runtimeCalls = 0;
    const server = new AgentAppServer({
      projectManager: projects,
      createRuntime: async () => ({
        async request(request) {
          runtimeCalls += 1;
          return await response.promise.then((value) => ({ ...value, method: request.method }));
        },
        async update() {},
        observe: () => () => undefined,
        async close() {},
      }),
    });
    const original = sendRequest(project.id, 'same-key', 'original');
    const first = server.request(original);
    await expect.poll(() => runtimeCalls).toBe(1);
    const identical = server.request(original);
    const conflicting = server.request(sendRequest(project.id, 'same-key', 'different'));
    response.resolve({ method: 'thread/send', ok: true, result: { accepted: true } });

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(identical).resolves.toMatchObject({ ok: true });
    await expect(conflicting).resolves.toMatchObject({
      ok: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(runtimeCalls).toBe(1);
    await server.close();
  });
});

type Counter = { readonly read: () => number; increment(): void };

function counter(): Counter {
  let value = 0;
  return { read: () => value, increment: () => void (value += 1) };
}

async function withDurableProject(
  run: (fixture: {
    readonly root: string;
    readonly projects: ProjectManager;
    readonly project: ProjectSnapshot;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'zen-agent-blocker-restart-'));
  await mkdir(join(root, 'workspace'));
  const projects = await ProjectManager.open({ registry: new InMemoryProjectRegistry() });
  const project = await projects.create({ name: 'Restart', rootPath: join(root, 'workspace') });
  try {
    await run({ root, projects, project });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function openDurableRuntime(
  root: string,
  projects: ProjectManager,
  projectId: string,
  options: {
    readonly executions: Counter;
    readonly blockExecutionLease?: boolean;
    readonly coordinationJournal?: ProjectCoordinationJournal;
  }
) {
  const threadJournal = new FileThreadJournal({ dir: join(root, 'threads') });
  const replay = await replayThreadJournal(threadJournal);
  let manager!: ThreadManager;
  let leaseAttempts = 0;
  const appServer = new AppServer({
    threadJournal,
    persistenceFailures: replay.persistenceFailures,
    createThreadManager: (managerOptions) => {
      manager = new ThreadManager({
        ...managerOptions,
        initialThreads: replay.initialThreads,
        runtimeFactory: () => ({
          model: {
            async *generate() {
              options.executions.increment();
              yield { type: 'message.completed' as const, content: 'done' };
            },
          },
        }),
        acquireExecutionLease: async ({ signal }) => {
          leaseAttempts += 1;
          if (options.blockExecutionLease) await rejectWhenAborted(signal);
          return { async settle() {} };
        },
      });
      return manager;
    },
  });
  const coordinator = await ProjectCoordinator.open({
    projectManager: projects,
    journal:
      options.coordinationJournal ??
      new FileProjectCoordinationJournal({ filePath: join(root, 'coordination.jsonl') }),
    createThreadManager: () => manager,
  });
  await coordinator.recover(projectId);
  return {
    coordinator,
    manager,
    leaseAttempts: () => leaseAttempts,
    crashClose: async () => {
      manager.failStop();
      await appServer.close();
      await coordinator.close();
    },
    close: async () => {
      await appServer.close();
      await coordinator.close();
    },
  };
}

async function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw new DOMException('crash', 'AbortError');
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('crash', 'AbortError')), {
      once: true,
    });
  });
}

class BlockingNestedMessageJournal implements ProjectCoordinationJournal {
  private block = false;
  private readonly blocked = deferred<void>();

  constructor(private readonly delegate: ProjectCoordinationJournal) {}

  blockNestedMessages(): void {
    this.block = true;
  }

  async waitUntilBlocked(): Promise<void> {
    await this.blocked.promise;
  }

  async append(item: ProjectCoordinationItem): Promise<void> {
    if (this.block && item.type === 'thread.message.sent') {
      this.blocked.resolve();
      return await new Promise<void>(() => undefined);
    }
    await this.delegate.append(item);
  }

  async replay(): Promise<readonly ProjectCoordinationItem[]> {
    return await this.delegate.replay();
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }
}

function coordinatorRuntime(coordinator: ProjectCoordinator): ProjectRuntime {
  return {
    async request(request) {
      if (request.method !== 'thread/handoff') throw new Error(`Unexpected ${request.method}`);
      return {
        method: request.method,
        ok: true,
        result: {
          handoff: await coordinator.handoff({
            projectId: String(request.params.projectId),
            sourceThreadId: String(request.params.sourceThreadId),
            targetThreadId: String(request.params.threadId),
            content: String(request.params.content),
            idempotencyKey: String(request.params.idempotencyKey),
          }),
        },
      };
    },
    async update() {},
    observe: () => () => undefined,
    async close() {},
  };
}

function handoffRequest(
  projectId: string,
  sourceThreadId: string,
  threadId: string
): AgentAppRequest {
  return {
    method: 'thread/handoff',
    params: {
      projectId,
      sourceThreadId,
      threadId,
      content: 'durable handoff',
      idempotencyKey: 'outer-handoff',
    },
  };
}

function sendRequest(projectId: string, idempotencyKey: string, content: string): AgentAppRequest {
  return {
    method: 'thread/send',
    params: {
      projectId,
      sourceThreadId: 'source',
      threadId: 'target',
      content,
      idempotencyKey,
    },
  };
}

async function createThread(
  server: AgentAppServer,
  projectId: string,
  idempotencyKey: string
): Promise<string> {
  return readThread(
    await server.request({
      method: 'thread/create',
      params: { projectId, idempotencyKey },
    })
  ).id;
}

async function cancelThread(
  server: AgentAppServer,
  projectId: string,
  threadId: string,
  idempotencyKey: string
): Promise<void> {
  await expect(
    server.request({
      method: 'thread/cancel',
      params: { projectId, threadId, idempotencyKey },
    })
  ).resolves.toMatchObject({ ok: true });
}

async function summaryStatus(
  server: AgentAppServer,
  projectId: string,
  threadId: string
): Promise<string | undefined> {
  const response = await server.request({ method: 'thread/list', params: { projectId } });
  if (!response.ok) throw new Error(response.error.message);
  return (response.result.threads as Array<{ threadId: string; status: string }>).find(
    (thread) => thread.threadId === threadId
  )?.status;
}

function agentContext(project: ProjectSnapshot, sourceThreadId: string) {
  return {
    actor: 'agent' as const,
    projectId: project.id,
    sourceThreadId,
    executionProject: project,
  };
}

function readProject(response: AgentAppResponse): ProjectSnapshot {
  if (!response.ok) throw new Error(response.error.message);
  return response.result.project as ProjectSnapshot;
}

function readThread(response: AgentAppResponse) {
  if (!response.ok) throw new Error(response.error.message);
  return response.result.thread as {
    readonly id: string;
    readonly items: readonly { readonly type: string }[];
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
