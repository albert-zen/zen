import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectCoordinationJournal,
  InMemoryProjectRegistry,
  ProjectCoordinator,
  ProjectIdempotencyConflictError,
  ProjectManager,
  ThreadManager,
  ThreadMailbox,
  type Item,
  type ProjectCoordinationJournal,
} from './test-exports.js';

describe('ProjectCoordinator and ThreadMailbox', () => {
  it('records message send and delivery with exact project causality', async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      idempotencyKey: 'create-source',
    });
    const target = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      idempotencyKey: 'create-target',
    });

    const result = await fixture.mailbox.send({
      projectId: fixture.projectId,
      sourceThreadId: source.threadId,
      targetThreadId: target.threadId,
      content: 'review this',
      idempotencyKey: 'message-1',
      parentItemId: 'tool-call-1',
      causeItemId: 'tool-call-1',
    });
    await waitFor(() => fixture.threadManager.readThread(target.threadId).turns.length === 1);

    const replay = await fixture.mailbox.send({
      projectId: fixture.projectId,
      sourceThreadId: source.threadId,
      targetThreadId: target.threadId,
      content: 'review this',
      idempotencyKey: 'message-1',
      parentItemId: 'tool-call-1',
      causeItemId: 'tool-call-1',
    });
    const items = fixture.coordinator.listCoordinationItems(fixture.projectId);

    expect(replay).toEqual(result);
    expect(items.filter((item) => item.type === 'thread.message.sent')).toEqual([
      expect.objectContaining({
        projectId: fixture.projectId,
        sourceThreadId: source.threadId,
        targetThreadId: target.threadId,
        messageId: result.messageId,
        idempotencyKey: 'message-1',
        parentId: 'tool-call-1',
        causeId: 'tool-call-1',
      }),
    ]);
    expect(items.find((item) => item.type === 'thread.message.delivered')).toMatchObject({
      projectId: fixture.projectId,
      sourceThreadId: source.threadId,
      targetThreadId: target.threadId,
      messageId: result.messageId,
      causeId: result.sentItemId,
    });
  });

  it('rejects a same-key command with a different payload', async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      idempotencyKey: 'source',
    });
    const target = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      idempotencyKey: 'target',
    });
    await fixture.mailbox.send({
      projectId: fixture.projectId,
      sourceThreadId: source.threadId,
      targetThreadId: target.threadId,
      content: 'first',
      idempotencyKey: 'same',
    });

    await expect(
      fixture.mailbox.send({
        projectId: fixture.projectId,
        sourceThreadId: source.threadId,
        targetThreadId: target.threadId,
        content: 'different',
        idempotencyKey: 'same',
      })
    ).rejects.toBeInstanceOf(ProjectIdempotencyConflictError);
  });

  it('enforces project boundaries, archive state, and depth independent of caller authority', async () => {
    const fixture = await createFixture({
      policy: {
        maxActiveExecutions: 1,
        maxThreadDepth: 1,
        agentCanCreateThreads: false,
        agentCanMessagePeers: false,
      },
    });
    const root = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      idempotencyKey: 'root',
    });

    const child = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      sourceThreadId: root.threadId,
      idempotencyKey: 'child',
    });
    await expect(
      fixture.coordinator.createThread({
        projectId: fixture.projectId,
        sourceThreadId: child.threadId,
        idempotencyKey: 'grandchild',
      })
    ).rejects.toThrow('maxThreadDepth');
    await expect(
      fixture.mailbox.send({
        projectId: fixture.projectId,
        sourceThreadId: root.threadId,
        targetThreadId: child.threadId,
        content: 'human command path remains authorized',
        idempotencyKey: 'message',
      })
    ).resolves.toMatchObject({ targetThreadId: child.threadId });

    await fixture.coordinator.archiveThread({
      projectId: fixture.projectId,
      threadId: root.threadId,
      idempotencyKey: 'archive',
    });
    await expect(
      fixture.mailbox.send({
        projectId: fixture.projectId,
        sourceThreadId: root.threadId,
        targetThreadId: root.threadId,
        content: 'blocked',
        idempotencyKey: 'archive-message',
      })
    ).rejects.toThrow('archived');
  });

  it('does not activate a target runtime before durable message send succeeds', async () => {
    const journal = new FailingJournal('thread.message.sent');
    const fixture = await createFixture({ journal });
    const source = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      idempotencyKey: 'source',
    });
    const target = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      idempotencyKey: 'target',
    });

    await expect(
      fixture.mailbox.send({
        projectId: fixture.projectId,
        sourceThreadId: source.threadId,
        targetThreadId: target.threadId,
        content: 'must not run',
        idempotencyKey: 'failure',
      })
    ).rejects.toThrow('injected coordination failure');
    expect(fixture.runtimeCalls()).toBe(0);
  });

  it('recovers one prepared Thread after a thread-journal barrier crash', async () => {
    const journal = new InMemoryProjectCoordinationJournal();
    let failBarrier = true;
    const fixture = await createFixture({
      journal,
      itemCommitBarrier: async () => {
        if (failBarrier) throw new Error('injected thread barrier failure');
      },
    });

    await expect(
      fixture.coordinator.createThread({
        projectId: fixture.projectId,
        idempotencyKey: 'prepared-crash',
      })
    ).rejects.toThrow('injected thread barrier failure');
    const prepared = fixture.coordinator
      .listCoordinationItems(fixture.projectId)
      .find((item) => item.type === 'project.thread.prepared');
    expect(prepared?.targetThreadId).toBeTruthy();
    expect(
      fixture.coordinator
        .listCoordinationItems(fixture.projectId)
        .some((item) => item.type === 'project.thread.created')
    ).toBe(false);

    failBarrier = false;
    const recovered = await ProjectCoordinator.open({
      projectManager: fixture.projects,
      journal,
      createThreadManager: () => fixture.threadManager,
      generateId: sequence('recovered-coordination'),
      clock: () => 1001,
    });
    await recovered.recover(fixture.projectId);
    expect(recovered.listThreadSummaries(fixture.projectId)).toEqual([
      expect.objectContaining({ threadId: prepared?.targetThreadId }),
    ]);
    await expect(
      recovered.createThread({
        projectId: fixture.projectId,
        idempotencyKey: 'prepared-crash',
      })
    ).resolves.toEqual({ threadId: prepared?.targetThreadId });
  });

  it('does not claim message activation before the queued Turn barrier and resumes on recovery', async () => {
    let failBarrier = false;
    const fixture = await createFixture({
      itemCommitBarrier: async () => {
        if (failBarrier) throw new Error('injected turn barrier failure');
      },
    });
    const source = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      idempotencyKey: 'barrier-source',
    });
    const target = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      idempotencyKey: 'barrier-target',
    });

    failBarrier = true;
    await expect(
      fixture.mailbox.send({
        projectId: fixture.projectId,
        sourceThreadId: source.threadId,
        targetThreadId: target.threadId,
        content: 'resume after crash',
        idempotencyKey: 'barrier-message',
      })
    ).rejects.toThrow('injected turn barrier failure');
    expect(
      fixture.coordinator
        .listCoordinationItems(fixture.projectId)
        .some((item) => item.type === 'thread.message.activated')
    ).toBe(false);
    expect(fixture.runtimeCalls()).toBe(0);

    failBarrier = false;
    await fixture.coordinator.recover(fixture.projectId);
    expect(
      fixture.coordinator
        .listCoordinationItems(fixture.projectId)
        .filter((item) => item.type === 'thread.message.activated')
    ).toHaveLength(1);
    await expect.poll(fixture.runtimeCalls).toBe(1);
  });
});

async function createFixture(
  options: {
    readonly journal?: ProjectCoordinationJournal;
    readonly policy?: Parameters<ProjectManager['create']>[0]['policy'];
    readonly itemCommitBarrier?: (threadId: string, item: Item) => Promise<void>;
  } = {}
): Promise<{
  readonly projectId: string;
  readonly coordinator: ProjectCoordinator;
  readonly mailbox: ThreadMailbox;
  readonly threadManager: ThreadManager;
  readonly runtimeCalls: () => number;
  readonly projects: ProjectManager;
}> {
  let runtimeCalls = 0;
  const projects = await ProjectManager.open({
    registry: new InMemoryProjectRegistry(),
    generateId: sequence('project'),
    clock: () => 1000,
  });
  const project = await projects.create({
    name: 'Project',
    rootPath: 'C:\\work\\project',
    policy: options.policy,
  });
  let threadManager: ThreadManager | undefined;
  const coordinator = await ProjectCoordinator.open({
    projectManager: projects,
    journal: options.journal ?? new InMemoryProjectCoordinationJournal(),
    createThreadManager: () => {
      threadManager ??= new ThreadManager({
        generateThreadId: sequence('thread'),
        generateRunId: sequence('run'),
        generateTurnId: sequence('turn'),
        generateItemId: sequence('item'),
        clock: () => 1000,
        runtimeFactory: () => ({
          model: {
            async *generate() {
              runtimeCalls += 1;
              yield { type: 'message.completed' as const, content: 'done' };
            },
          },
        }),
        itemCommitBarrier: options.itemCommitBarrier,
      });
      return threadManager;
    },
    generateId: sequence('coordination'),
    clock: () => 1000,
  });
  return {
    projectId: project.id,
    coordinator,
    mailbox: new ThreadMailbox(coordinator),
    get threadManager() {
      if (!threadManager) throw new Error('Thread manager was not initialized');
      return threadManager;
    },
    runtimeCalls: () => runtimeCalls,
    projects,
  };
}

class FailingJournal implements ProjectCoordinationJournal {
  constructor(private readonly type: string) {}
  async append(item: { readonly type: string }): Promise<void> {
    if (item.type === this.type) throw new Error('injected coordination failure');
  }
  async replay() {
    return [];
  }
  async close(): Promise<void> {}
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timed out');
}
