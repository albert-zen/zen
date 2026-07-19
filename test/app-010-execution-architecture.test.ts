import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createAgentAppProductionComposition,
  projectRuntimeDirectory,
  type AgentAppProductionComposition,
  type AgentAppResponse,
  type ModelContext,
  type ProjectPolicy,
  type ProjectSnapshot,
} from './test-exports.js';

describe('APP-010 authoritative Turn execution architecture', () => {
  it('keeps 100 idle Threads durable without creating executors or scheduler leases', async () => {
    let executorFactories = 0;
    const fixture = await createFixture({
      createModel: () => {
        executorFactories += 1;
        return completedModel();
      },
    });
    try {
      await Promise.all(
        Array.from(
          { length: 100 },
          async (_, index) => await createThread(fixture, `idle-${index}`)
        )
      );

      const response = await fixture.composition.agentAppServer.request({
        method: 'thread/list',
        params: { projectId: fixture.project.id },
      });
      expect(resultArray(response, 'threads')).toHaveLength(100);
      expect(executorFactories).toBe(0);
      expect(await coordinationTypes(fixture)).not.toContain('agent.lease.granted');
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it('limits active Executors while every queued Turn is already durable', async () => {
    const gates: Deferred<void>[] = [];
    let active = 0;
    let maximumActive = 0;
    const fixture = await createFixture({
      policy: policy({ maxActiveExecutions: 2 }),
      createModel: () => {
        const gate = deferred<void>();
        gates.push(gate);
        return {
          async *generate() {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            try {
              await gate.promise;
              yield { type: 'message.completed' as const, content: 'done' };
            } finally {
              active -= 1;
            }
          },
        };
      },
    });
    try {
      const threads = await Promise.all([
        createThread(fixture, 'one'),
        createThread(fixture, 'two'),
        createThread(fixture, 'three'),
      ]);
      for (const [index, threadId] of threads.entries()) {
        await startTurn(fixture, threadId, `work-${index}`, `turn-${index}`);
      }

      await expect.poll(() => gates.length).toBe(2);
      expect(maximumActive).toBe(2);
      expect((await readThread(fixture, threads[2]!)).turns).toEqual([
        expect.objectContaining({ status: 'queued' }),
      ]);
      const allDurable = await Promise.all(
        threads.map(async (id) => await readThread(fixture, id))
      );
      expect(allDurable.every((thread) => thread.turns.length === 1)).toBe(true);

      gates[0]!.resolve();
      await expect.poll(() => gates.length).toBe(3);
      expect(maximumActive).toBe(2);
      gates.forEach((gate) => gate.resolve());
      await expect
        .poll(async () =>
          (
            await Promise.all(
              threads.map(async (id) => (await readThread(fixture, id)).turns[0]?.status)
            )
          ).every((status) => status === 'completed')
        )
        .toBe(true);
    } finally {
      gates.forEach((gate) => gate.resolve());
      await fixture.close();
    }
  });

  it('routes UI and Agent messages through the same durable command pipeline', async () => {
    let targetThreadId = '';
    const fixture = await createFixture({
      createModel: () => {
        let calls = 0;
        return {
          async *generate(context) {
            calls += 1;
            if (latestUserContent(context) === 'agent-dispatch' && calls === 1) {
              yield {
                type: 'message.completed' as const,
                content: 'dispatching',
                toolCalls: [
                  {
                    id: 'agent-create-call',
                    name: 'thread.create',
                    input: {
                      objective: 'agent-created child',
                      idempotencyKey: 'agent-create',
                    },
                  },
                  {
                    id: 'agent-send-call',
                    name: 'thread.send',
                    input: {
                      threadId: targetThreadId,
                      content: 'from-agent',
                      idempotencyKey: 'agent-send',
                    },
                  },
                ],
              };
              return;
            }
            yield { type: 'message.completed' as const, content: 'done' };
          },
        };
      },
    });
    try {
      const sourceThreadId = await createThread(fixture, 'source');
      targetThreadId = await createThread(fixture, 'target');
      await createThread(fixture, 'ui-child', sourceThreadId);
      await fixture.composition.agentAppServer.request({
        method: 'thread/send',
        params: {
          projectId: fixture.project.id,
          sourceThreadId,
          threadId: targetThreadId,
          content: 'from-ui',
          idempotencyKey: 'ui-send',
        },
      });
      await startTurn(fixture, sourceThreadId, 'agent-dispatch', 'agent-turn');

      await expect
        .poll(async () => (await readThread(fixture, sourceThreadId)).turns[0]?.status)
        .toMatch(/completed|failed/);
      const source = await readThread(fixture, sourceThreadId);
      expect(source.items.filter((item) => item.type === 'tool.error')).toEqual([]);
      expect(source.items.some((item) => item.type === 'tool.call.started')).toBe(true);

      await expect
        .poll(async () => (await commandRecords(fixture)).filter(isMessageCommand).length)
        .toBe(2);
      const commands = (await commandRecords(fixture)).filter(isMessageCommand);
      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: fixture.project.id,
            idempotencyKey: 'ui-send',
            state: 'completed',
          }),
          expect.objectContaining({
            scope: fixture.project.id,
            idempotencyKey: 'agent-send',
            state: 'completed',
          }),
        ])
      );
      expect(commands.every((command) => command.method === 'thread/send')).toBe(true);
      const creates = (await commandRecords(fixture)).filter(
        (command) =>
          command.method === 'thread/create' &&
          ['thread-ui-child', 'agent-create'].includes(String(command.idempotencyKey))
      );
      expect(creates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ idempotencyKey: 'thread-ui-child', state: 'completed' }),
          expect.objectContaining({ idempotencyKey: 'agent-create', state: 'completed' }),
        ])
      );
      await expect
        .poll(async () => (await readThread(fixture, targetThreadId)).turns.length)
        .toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it('persists wait, yields the slot, and wakes by scheduling a new continuation Turn', async () => {
    let targetThreadId = '';
    const fixture = await createFixture({
      policy: policy({ maxActiveExecutions: 1 }),
      createModel: () => ({
        async *generate(context) {
          if (latestUserContent(context) === 'wait-for-target') {
            yield {
              type: 'message.completed' as const,
              content: 'waiting',
              toolCalls: [
                {
                  id: 'wait-call',
                  name: 'thread.wait',
                  input: {
                    threadIds: [targetThreadId],
                    mode: 'all',
                    idempotencyKey: 'wait-command',
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
    try {
      const sourceThreadId = await createThread(fixture, 'source');
      targetThreadId = await createThread(fixture, 'target');
      await startTurn(fixture, sourceThreadId, 'wait-for-target', 'wait-turn');

      await expect
        .poll(async () => (await readThread(fixture, sourceThreadId)).turns[0]?.status)
        .toBe('waiting');
      const beforeWake = await coordinationItems(fixture);
      expect(beforeWake).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'thread.wait.started', targetThreadId: sourceThreadId }),
          expect.objectContaining({
            type: 'agent.lease.released',
            targetThreadId: sourceThreadId,
            payload: expect.objectContaining({ status: 'waiting' }),
          }),
        ])
      );

      await startTurn(fixture, targetThreadId, 'finish-target', 'finish-target');
      await expect
        .poll(async () => {
          const turns = (await readThread(fixture, sourceThreadId)).turns;
          return turns.length === 2 ? turns[1]?.status : undefined;
        })
        .toBe('completed');
      const source = await readThread(fixture, sourceThreadId);
      expect(source.turns[0]?.id).not.toBe(source.turns[1]?.id);
      expect(await coordinationItems(fixture)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'thread.wait.resolved',
            payload: expect.objectContaining({ continuationTurnId: source.turns[1]?.id }),
          }),
        ])
      );
    } finally {
      await fixture.close();
    }
  });

  it('applies model, permission, and concurrency updates atomically to the next Turn', async () => {
    const oldGate = deferred<void>();
    const newGate = deferred<void>();
    let peerThreadId = '';
    let active = 0;
    let maximumActive = 0;
    const observations: Array<{ readonly input: unknown; readonly profile?: string }> = [];
    const fixture = await createFixture({
      policy: policy({
        maxActiveExecutions: 1,
        defaultModelProfile: 'old-model',
        agentCanMessagePeers: true,
      }),
      createModel: (project) => {
        let calls = 0;
        return {
          async *generate(context) {
            calls += 1;
            const input = latestUserContent(context);
            if (calls === 1)
              observations.push({ input, profile: project.policy.defaultModelProfile });
            const gate =
              input === 'old-active' ? oldGate : input === 'new-next' ? newGate : undefined;
            if (!gate || calls > 1) {
              yield { type: 'message.completed' as const, content: 'done' };
              return;
            }
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            try {
              await gate.promise;
              yield {
                type: 'message.completed' as const,
                content: 'message peer',
                toolCalls: [
                  {
                    id: `${String(input)}-send-call`,
                    name: 'thread.send',
                    input: {
                      threadId: peerThreadId,
                      content: `${String(input)}-message`,
                      idempotencyKey:
                        input === 'old-active' ? 'old-policy-send' : 'new-policy-send',
                    },
                  },
                ],
              };
            } finally {
              active -= 1;
            }
          },
        };
      },
    });
    try {
      const oldThreadId = await createThread(fixture, 'old');
      const nextThreadId = await createThread(fixture, 'next');
      peerThreadId = await createThread(fixture, 'peer');
      await startTurn(fixture, oldThreadId, 'old-active', 'old-turn');
      await expect.poll(() => active).toBe(1);
      await startTurn(fixture, nextThreadId, 'new-next', 'next-turn');
      expect((await readThread(fixture, nextThreadId)).turns[0]?.status).toBe('queued');

      const updatedPolicy = policy({
        ...fixture.project.policy,
        maxActiveExecutions: 2,
        defaultModelProfile: 'new-model',
        agentCanMessagePeers: false,
      });
      const update = await fixture.composition.agentAppServer.request({
        method: 'project/update',
        params: {
          projectId: fixture.project.id,
          policy: updatedPolicy,
          idempotencyKey: 'policy-update',
        },
      });
      expect(update).toMatchObject({ ok: true });
      await expect.poll(() => maximumActive).toBe(2);
      expect(observations).toEqual(
        expect.arrayContaining([
          { input: 'old-active', profile: 'old-model' },
          { input: 'new-next', profile: 'new-model' },
        ])
      );

      newGate.resolve();
      oldGate.resolve();
      await expect
        .poll(async () => (await readThread(fixture, oldThreadId)).turns[0]?.status)
        .toMatch(/completed|failed/);
      await expect
        .poll(async () => (await readThread(fixture, nextThreadId)).turns[0]?.status)
        .toMatch(/completed|failed/);
      await expect
        .poll(async () => {
          const commands = await commandRecords(fixture);
          return commands.filter((command) =>
            ['old-policy-send', 'new-policy-send'].includes(String(command.idempotencyKey))
          ).length;
        })
        .toBe(2);
      const policyCommands = (await commandRecords(fixture)).filter((command) =>
        ['old-policy-send', 'new-policy-send'].includes(String(command.idempotencyKey))
      );
      expect(
        policyCommands.find((command) => command.idempotencyKey === 'old-policy-send')
      ).toMatchObject({ response: { ok: true } });
      expect(
        policyCommands.find((command) => command.idempotencyKey === 'new-policy-send')
      ).toMatchObject({ response: { ok: false, error: { code: 'POLICY_DENIED' } } });
    } finally {
      oldGate.resolve();
      newGate.resolve();
      await fixture.close();
    }
  });

  it('rejects Project root updates without changing durable identity', async () => {
    const fixture = await createFixture({});
    try {
      const otherRoot = join(fixture.root, 'other-workspace');
      await mkdir(otherRoot, { recursive: true });
      const response = await fixture.composition.agentAppServer.request({
        method: 'project/update',
        params: {
          projectId: fixture.project.id,
          rootPath: otherRoot,
          idempotencyKey: 'root-update',
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST', message: expect.stringContaining('immutable') },
      });
      const read = await fixture.composition.agentAppServer.request({
        method: 'project/read',
        params: { projectId: fixture.project.id },
      });
      expect(projectResult(read).rootPath).toBe(fixture.project.rootPath);
    } finally {
      await fixture.close();
    }
  });

  it('denies every Agent target mutation against direct and transitive ancestors', async () => {
    const fixture = await createFixture({});
    try {
      const rootThreadId = await createThread(fixture, 'root');
      const childThreadId = await createThread(fixture, 'child', rootThreadId);
      const grandchildThreadId = await createThread(fixture, 'grandchild', childThreadId);
      const targets = [childThreadId, rootThreadId];
      let sequence = 0;

      for (const target of targets) {
        for (const request of [
          {
            method: 'thread/send' as const,
            params: {
              projectId: fixture.project.id,
              sourceThreadId: grandchildThreadId,
              threadId: target,
              content: 'denied',
              interrupt: false,
              idempotencyKey: `denied-${++sequence}`,
            },
          },
          {
            method: 'thread/send' as const,
            params: {
              projectId: fixture.project.id,
              sourceThreadId: grandchildThreadId,
              threadId: target,
              content: 'denied interrupt',
              interrupt: true,
              idempotencyKey: `denied-${++sequence}`,
            },
          },
          {
            method: 'thread/cancel' as const,
            params: {
              projectId: fixture.project.id,
              threadId: target,
              idempotencyKey: `denied-${++sequence}`,
            },
          },
          {
            method: 'thread/archive' as const,
            params: {
              projectId: fixture.project.id,
              threadId: target,
              idempotencyKey: `denied-${++sequence}`,
            },
          },
          {
            method: 'thread/handoff' as const,
            params: {
              projectId: fixture.project.id,
              sourceThreadId: grandchildThreadId,
              threadId: target,
              content: 'denied handoff',
              idempotencyKey: `denied-${++sequence}`,
            },
          },
        ]) {
          await expect(
            fixture.composition.agentAppServer.requestFromAgent(request, {
              actor: 'agent',
              projectId: fixture.project.id,
              sourceThreadId: grandchildThreadId,
              executionProject: fixture.project,
            })
          ).resolves.toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
        }
      }
    } finally {
      await fixture.close();
    }
  });

  it('archives active execution only after fencing it and keeps history readable', async () => {
    const gate = deferred<void>();
    let active = 0;
    const fixture = await createFixture({
      createModel: () => ({
        async *generate(_context, _options, signal) {
          active += 1;
          try {
            await Promise.race([
              gate.promise,
              new Promise<void>((resolve) =>
                signal?.addEventListener('abort', () => resolve(), { once: true })
              ),
            ]);
            if (signal?.aborted) return;
            yield { type: 'message.completed' as const, content: 'late' };
          } finally {
            active -= 1;
          }
        },
      }),
    });
    try {
      const threadId = await createThread(fixture, 'archive');
      await startTurn(fixture, threadId, 'active', 'active-turn');
      await expect.poll(() => active).toBe(1);
      const archived = await fixture.composition.agentAppServer.request({
        method: 'thread/archive',
        params: { projectId: fixture.project.id, threadId, idempotencyKey: 'archive-active' },
      });
      expect(archived).toMatchObject({ ok: true });
      expect(active).toBe(0);

      await expect(
        fixture.composition.agentAppServer.request({
          method: 'thread/read',
          params: { projectId: fixture.project.id, threadId },
        })
      ).resolves.toMatchObject({ ok: true, result: { thread: { id: threadId } } });
      await expect(
        fixture.composition.agentAppServer.request({
          method: 'turn/start',
          params: {
            projectId: fixture.project.id,
            threadId,
            input: 'must not run',
            idempotencyKey: 'after-archive',
          },
        })
      ).resolves.toMatchObject({ ok: false });
    } finally {
      gate.resolve();
      await fixture.close();
    }
  });
});

type Fixture = {
  readonly root: string;
  readonly composition: AgentAppProductionComposition;
  readonly project: ProjectSnapshot;
  close(): Promise<void>;
};

async function createFixture(options: {
  readonly policy?: ProjectPolicy;
  readonly createModel?: Parameters<typeof createAgentAppProductionComposition>[0]['createModel'];
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'zen-app-010-execution-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const composition = await createAgentAppProductionComposition({
    appDataRoot: join(root, 'app-data'),
    createModel: options.createModel,
  });
  const created = await composition.agentAppServer.request({
    method: 'project/create',
    params: {
      name: 'APP-010',
      rootPath: workspace,
      policy: options.policy ?? policy(),
      idempotencyKey: 'project-create',
    },
  });
  const project = projectResult(created);
  return {
    root,
    composition,
    project,
    async close() {
      await composition.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function policy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    maxActiveExecutions: 2,
    maxThreadDepth: 4,
    maxThreads: 200,
    maxQueuedMessages: 200,
    maxWaitTargets: 16,
    maxMessageBytes: 16_384,
    idempotencyRetention: 1_000,
    agentCanCreateThreads: true,
    agentCanMessagePeers: true,
    ...overrides,
  };
}

async function createThread(
  fixture: Fixture,
  key: string,
  sourceThreadId?: string
): Promise<string> {
  const response = await fixture.composition.agentAppServer.request({
    method: 'thread/create',
    params: {
      projectId: fixture.project.id,
      idempotencyKey: `thread-${key}`,
      ...(sourceThreadId ? { sourceThreadId } : {}),
    },
  });
  return nestedId(response, 'thread');
}

async function startTurn(
  fixture: Fixture,
  threadId: string,
  input: unknown,
  idempotencyKey: string
): Promise<void> {
  const response = await fixture.composition.agentAppServer.request({
    method: 'turn/start',
    params: { projectId: fixture.project.id, threadId, input, idempotencyKey },
  });
  if (!response.ok) throw new Error(response.error.message);
}

async function readThread(
  fixture: Fixture,
  threadId: string
): Promise<{
  readonly id: string;
  readonly turns: readonly { readonly id: string; readonly status: string }[];
  readonly items: readonly {
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[];
}> {
  const response = await fixture.composition.agentAppServer.request({
    method: 'thread/read',
    params: { projectId: fixture.project.id, threadId },
  });
  if (!response.ok) throw new Error(response.error.message);
  return response.result.thread as never;
}

function projectResult(response: AgentAppResponse): ProjectSnapshot {
  if (!response.ok) throw new Error(response.error.message);
  return response.result.project as ProjectSnapshot;
}

function nestedId(response: AgentAppResponse, key: string): string {
  if (!response.ok) throw new Error(response.error.message);
  const value = response.result[key] as { readonly id?: unknown } | undefined;
  if (typeof value?.id !== 'string') throw new Error(`Missing ${key} id`);
  return value.id;
}

function resultArray(response: AgentAppResponse, key: string): readonly unknown[] {
  if (!response.ok) throw new Error(response.error.message);
  const value = response.result[key];
  if (!Array.isArray(value)) throw new Error(`Missing ${key} array`);
  return value;
}

function latestUserContent(context: ModelContext): unknown {
  return context.parts.filter((part) => part.type === 'message' && part.role === 'user').at(-1)
    ?.content;
}

function completedModel() {
  return {
    async *generate() {
      yield { type: 'message.completed' as const, content: 'done' };
    },
  };
}

async function commandRecords(fixture: Fixture): Promise<readonly Record<string, unknown>[]> {
  const value = JSON.parse(await readFile(join(fixture.root, 'app-data', 'commands.json'), 'utf8'));
  return value.commands;
}

function isMessageCommand(command: Record<string, unknown>): boolean {
  return command.method === 'thread/send';
}

async function coordinationItems(fixture: Fixture): Promise<readonly Record<string, unknown>[]> {
  const path = join(
    projectRuntimeDirectory(join(fixture.root, 'app-data'), fixture.project.id),
    'coordination.jsonl'
  );
  const text = await readFile(path, 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).item);
}

async function coordinationTypes(fixture: Fixture): Promise<readonly unknown[]> {
  return (await coordinationItems(fixture)).map((item) => item.type);
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve: (value) => resolve(value as T) };
}
