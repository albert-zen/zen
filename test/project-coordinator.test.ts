import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectCoordinationJournal,
  InMemoryProjectRegistry,
  ProjectCoordinator,
  ProjectIdempotencyConflictError,
  ProjectManager,
  ThreadManager,
  ThreadMailbox,
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

  it('enforces project boundaries, archive state, capability, and depth', async () => {
    const fixture = await createFixture({
      policy: {
        maxConcurrentAgents: 1,
        maxThreadDepth: 1,
        agentCanCreateThreads: false,
        agentCanMessagePeers: false,
      },
    });
    const root = await fixture.coordinator.createThread({
      projectId: fixture.projectId,
      idempotencyKey: 'root',
    });

    await expect(
      fixture.coordinator.createThread({
        projectId: fixture.projectId,
        sourceThreadId: root.threadId,
        idempotencyKey: 'child',
      })
    ).rejects.toThrow('not permitted');
    await expect(
      fixture.mailbox.send({
        projectId: fixture.projectId,
        sourceThreadId: root.threadId,
        targetThreadId: root.threadId,
        content: 'peer',
        idempotencyKey: 'peer',
      })
    ).rejects.toThrow('not permitted');

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
});

async function createFixture(
  options: {
    readonly journal?: ProjectCoordinationJournal;
    readonly policy?: Parameters<ProjectManager['create']>[0]['policy'];
  } = {}
): Promise<{
  readonly projectId: string;
  readonly coordinator: ProjectCoordinator;
  readonly mailbox: ThreadMailbox;
  readonly threadManager: ThreadManager;
  readonly runtimeCalls: () => number;
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
