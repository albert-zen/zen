import type { Clock, IdGenerator } from '../kernel/index.js';
import type { ThreadSnapshot } from './app-server-protocol.js';
import type { ProjectSnapshot } from './project-registry.js';
import { ProjectManager } from './project-manager.js';
import {
  InMemoryProjectCoordinationJournal,
  ProjectCoordinationList,
  type ProjectCoordinationAppendInput,
  type ProjectCoordinationItem,
  type ProjectCoordinationItemType,
  type ProjectCoordinationJournal,
} from './project-coordination.js';
import { ThreadManager, type ThreadManagerObserver } from './thread-manager.js';

export type ProjectThreadStatus =
  'queued' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'canceled' | 'archived';

export type ProjectThreadSummary = {
  readonly projectId: string;
  readonly threadId: string;
  readonly depth: number;
  readonly status: ProjectThreadStatus;
  readonly parentThreadId?: string;
  readonly modelProfile?: string;
  readonly objective?: string;
};

export type ProjectCoordinatorOptions = {
  readonly projectManager: Pick<ProjectManager, 'read'>;
  readonly journal?: ProjectCoordinationJournal;
  readonly createThreadManager: (project: ProjectSnapshot) => ThreadManager;
  readonly generateId?: IdGenerator;
  readonly clock?: Clock;
};

export type CreateProjectThreadInput = {
  readonly projectId: string;
  readonly sourceThreadId?: string;
  readonly objective?: string;
  readonly modelProfile?: string;
  readonly idempotencyKey: string;
  readonly parentItemId?: string;
  readonly causeItemId?: string;
};

export type SendThreadMessageInput = {
  readonly projectId: string;
  readonly sourceThreadId: string;
  readonly targetThreadId: string;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly parentItemId?: string;
  readonly causeItemId?: string;
  readonly correlationId?: string;
  readonly interrupt?: boolean;
};

export type ThreadMessageResult = {
  readonly messageId: string;
  readonly sentItemId: string;
  readonly deliveredItemId?: string;
  readonly targetThreadId: string;
};

export class ProjectIdempotencyConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly idempotencyKey: string
  ) {
    super(`Project command idempotency conflict: ${projectId}/${idempotencyKey}`);
    this.name = 'ProjectIdempotencyConflictError';
  }
}

export class ProjectResourceError extends Error {
  readonly code = 'RESOURCE_EXHAUSTED' as const;
  constructor(
    readonly resource: string,
    message: string
  ) {
    super(message);
    this.name = 'ProjectResourceError';
  }
}

export class ProjectCoordinator {
  private readonly projectManager: Pick<ProjectManager, 'read'>;
  private readonly journal: ProjectCoordinationJournal;
  private readonly createThreadManager: ProjectCoordinatorOptions['createThreadManager'];
  private readonly list: ProjectCoordinationList;
  private readonly managers = new Map<string, ThreadManager>();
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private mutationTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    options: Required<ProjectCoordinatorOptions>,
    initialItems: readonly ProjectCoordinationItem[]
  ) {
    this.projectManager = options.projectManager;
    this.journal = options.journal;
    this.createThreadManager = options.createThreadManager;
    this.list = new ProjectCoordinationList({
      generateId: options.generateId,
      clock: options.clock,
      initialItems,
    });
  }

  static async open(options: ProjectCoordinatorOptions): Promise<ProjectCoordinator> {
    const journal = options.journal ?? new InMemoryProjectCoordinationJournal();
    const initialItems = await journal.replay();
    return new ProjectCoordinator(
      {
        ...options,
        journal,
        generateId: options.generateId ?? defaultId,
        clock: options.clock ?? Date.now,
      },
      initialItems
    );
  }

  listCoordinationItems(projectId?: string): readonly ProjectCoordinationItem[] {
    return this.list.getItems(projectId);
  }

  /** Rebuild the in-memory manager for a durably known project before serving it. */
  async recover(projectId: string): Promise<void> {
    const project = await this.activeProject(projectId);
    this.managerFor(project);
    for (const grant of this.unreleasedLeases(projectId)) {
      await this.record({
        type: 'agent.lease.recovered',
        projectId,
        targetThreadId: grant.targetThreadId,
        causeId: grant.id,
        payload: { recoveredFromLeaseItemId: grant.id },
      });
    }
    for (const summary of this.listThreadSummaries(projectId)) {
      await this.deliverNext(projectId, summary.threadId);
    }
  }

  async createThread(input: CreateProjectThreadInput): Promise<{ readonly threadId: string }> {
    return await this.mutate(async () => {
      const result = await this.createThreadNow(input);
      await this.compactIdempotency(input.projectId);
      return result;
    });
  }

  private async createThreadNow(
    input: CreateProjectThreadInput
  ): Promise<{ readonly threadId: string }> {
    const project = await this.activeProject(input.projectId);
    const digest = stableDigest({ type: 'project.thread.created', ...input });
    const replay = this.replayCommand<{ readonly threadId: string }>(
      input.projectId,
      input.idempotencyKey,
      digest,
      'project.thread.created'
    );
    if (replay) return replay;
    if (
      this.listThreadSummaries(input.projectId).length >= requiredLimit(project.policy.maxThreads)
    ) {
      throw new ProjectResourceError('maxThreads', 'Project maxThreads exceeded');
    }
    const parent = input.sourceThreadId
      ? this.threadSummary(input.projectId, input.sourceThreadId)
      : undefined;
    if (input.sourceThreadId && !project.policy.agentCanCreateThreads) {
      throw new Error('Agent thread creation is not permitted by project policy');
    }
    const depth = (parent?.depth ?? -1) + 1;
    if (depth > project.policy.maxThreadDepth) throw new Error('Project maxThreadDepth exceeded');
    const thread = this.managerFor(project).startThread();
    const result = { threadId: thread.id };
    await this.record({
      type: 'project.thread.created',
      projectId: input.projectId,
      sourceThreadId: input.sourceThreadId,
      targetThreadId: thread.id,
      idempotencyKey: input.idempotencyKey,
      parentId: input.parentItemId,
      causeId: input.causeItemId,
      payload: {
        commandDigest: digest,
        result,
        depth,
        parentThreadId: input.sourceThreadId,
        modelProfile: input.modelProfile ?? project.policy.defaultModelProfile,
        objective: input.objective,
      },
    });
    return result;
  }

  async sendMessage(input: SendThreadMessageInput): Promise<ThreadMessageResult> {
    return await this.mutate(async () => {
      const result = await this.sendMessageNow(input);
      await this.compactIdempotency(input.projectId);
      return result;
    });
  }

  private async sendMessageNow(input: SendThreadMessageInput): Promise<ThreadMessageResult> {
    const project = await this.activeProject(input.projectId);
    const digest = stableDigest({ type: 'thread.message.sent', ...input });
    const replay = this.replayCommand<ThreadMessageResult>(
      input.projectId,
      input.idempotencyKey,
      digest,
      'thread.message.sent'
    );
    if (replay) return replay;
    if (Buffer.byteLength(input.content, 'utf8') > requiredLimit(project.policy.maxMessageBytes)) {
      throw new ProjectResourceError('maxMessageBytes', 'Project maxMessageBytes exceeded');
    }
    if (
      this.pendingMessages(input.projectId, input.targetThreadId).length >=
      requiredLimit(project.policy.maxQueuedMessages)
    ) {
      throw new ProjectResourceError('maxQueuedMessages', 'Project maxQueuedMessages exceeded');
    }
    this.assertThreadUsable(input.projectId, input.sourceThreadId);
    this.assertThreadUsable(input.projectId, input.targetThreadId);
    if (!project.policy.agentCanMessagePeers) {
      throw new Error('Agent peer messaging is not permitted by project policy');
    }
    if (input.interrupt && !project.policy.agentCanMessagePeers) {
      throw new Error('Explicit interrupt is not permitted by project policy');
    }
    const messageId = defaultId();
    const sent = await this.record({
      type: 'thread.message.sent',
      projectId: input.projectId,
      sourceThreadId: input.sourceThreadId,
      targetThreadId: input.targetThreadId,
      messageId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      parentId: input.parentItemId,
      causeId: input.causeItemId,
      payload: {
        commandDigest: digest,
        content: input.content,
        interrupt: input.interrupt ?? false,
      },
    });
    if (input.interrupt) this.interruptIfRunning(input.projectId, input.targetThreadId);
    const deliveredItemId = await this.deliverNext(input.projectId, input.targetThreadId);
    const result: ThreadMessageResult = {
      messageId,
      sentItemId: sent.id,
      deliveredItemId,
      targetThreadId: input.targetThreadId,
    };
    await this.attachResult(sent.id, result);
    return result;
  }

  async archiveThread(input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly idempotencyKey: string;
  }): Promise<void> {
    await this.mutate(async () => {
      await this.archiveThreadNow(input);
      await this.compactIdempotency(input.projectId);
    });
  }

  private async archiveThreadNow(input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly idempotencyKey: string;
  }): Promise<void> {
    await this.activeProject(input.projectId);
    this.assertKnownThread(input.projectId, input.threadId);
    const digest = stableDigest({ type: 'thread.archived', ...input });
    if (this.replayCommand<void>(input.projectId, input.idempotencyKey, digest, 'thread.archived'))
      return;
    await this.record({
      type: 'thread.archived',
      projectId: input.projectId,
      targetThreadId: input.threadId,
      idempotencyKey: input.idempotencyKey,
      payload: { commandDigest: digest, result: {} },
    });
  }

  async cancelThread(input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly idempotencyKey: string;
  }): Promise<void> {
    await this.mutate(async () => {
      await this.cancelThreadNow(input);
      await this.compactIdempotency(input.projectId);
    });
  }

  private async cancelThreadNow(input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly idempotencyKey: string;
  }): Promise<void> {
    await this.activeProject(input.projectId);
    this.assertKnownThread(input.projectId, input.threadId);
    const digest = stableDigest({ type: 'thread.canceled', ...input });
    if (this.replayCommand<void>(input.projectId, input.idempotencyKey, digest, 'thread.canceled'))
      return;
    await this.record({
      type: 'thread.canceled',
      projectId: input.projectId,
      targetThreadId: input.threadId,
      idempotencyKey: input.idempotencyKey,
      payload: { commandDigest: digest, result: {} },
    });
    this.interruptIfRunning(input.projectId, input.threadId);
  }

  async handoff(input: {
    readonly projectId: string;
    readonly sourceThreadId: string;
    readonly targetThreadId: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly handoffItemId: string }> {
    return await this.mutate(async () => {
      const result = await this.handoffNow(input);
      await this.compactIdempotency(input.projectId);
      return result;
    });
  }

  private async handoffNow(input: {
    readonly projectId: string;
    readonly sourceThreadId: string;
    readonly targetThreadId: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly handoffItemId: string }> {
    await this.activeProject(input.projectId);
    this.assertThreadUsable(input.projectId, input.sourceThreadId);
    this.assertThreadUsable(input.projectId, input.targetThreadId);
    const digest = stableDigest({ type: 'thread.handoff', ...input });
    const replay = this.replayCommand<{ readonly handoffItemId: string }>(
      input.projectId,
      input.idempotencyKey,
      digest,
      'thread.handoff'
    );
    if (replay) return replay;
    const item = await this.record({
      type: 'thread.handoff',
      projectId: input.projectId,
      sourceThreadId: input.sourceThreadId,
      targetThreadId: input.targetThreadId,
      idempotencyKey: input.idempotencyKey,
      payload: { commandDigest: digest, content: input.content },
    });
    const result = { handoffItemId: item.id };
    await this.record({
      type: 'thread.handoff',
      projectId: input.projectId,
      sourceThreadId: input.sourceThreadId,
      targetThreadId: input.targetThreadId,
      causeId: item.id,
      payload: { result },
    });
    return result;
  }

  threadSummary(projectId: string, threadId: string): ProjectThreadSummary {
    const created = this.list
      .getItems(projectId)
      .find((item) => item.type === 'project.thread.created' && item.targetThreadId === threadId);
    if (!created) throw new Error(`Unknown project thread: ${threadId}`);
    const payload = created.payload;
    return {
      projectId,
      threadId,
      depth: readNumber(payload.depth),
      parentThreadId: readOptionalString(payload.parentThreadId),
      modelProfile: readOptionalString(payload.modelProfile),
      objective: readOptionalString(payload.objective),
      status: this.statusFor(projectId, threadId),
    };
  }

  listThreadSummaries(projectId: string): readonly ProjectThreadSummary[] {
    return this.list
      .getItems(projectId)
      .filter((item) => item.type === 'project.thread.created' && item.targetThreadId)
      .map((item) => this.threadSummary(projectId, item.targetThreadId ?? ''));
  }

  relation(
    projectId: string,
    sourceThreadId: string,
    targetThreadId: string
  ): 'self' | 'child' | 'ancestor' | 'peer' {
    if (sourceThreadId === targetThreadId) return 'self';
    const source = this.threadSummary(projectId, sourceThreadId);
    const target = this.threadSummary(projectId, targetThreadId);
    if (target.parentThreadId === source.threadId) return 'child';
    if (source.parentThreadId === target.threadId) return 'ancestor';
    return 'peer';
  }

  async assertWaitWithinLimit(projectId: string, targets: readonly string[]): Promise<void> {
    const project = await this.activeProject(projectId);
    if (targets.length > requiredLimit(project.policy.maxWaitTargets)) {
      throw new ProjectResourceError('maxWaitTargets', 'Project maxWaitTargets exceeded');
    }
  }

  readThread(projectId: string, threadId: string): ThreadSnapshot {
    this.assertThreadUsable(projectId, threadId);
    return this.managerForExisting(projectId).readThread(threadId);
  }

  async recordLifecycle(
    type: Exclude<
      ProjectCoordinationItemType,
      'project.thread.created' | 'thread.message.sent' | 'thread.message.delivered'
    >,
    input: Omit<ProjectCoordinationAppendInput, 'type'>
  ): Promise<ProjectCoordinationItem> {
    return await this.record({ ...input, type });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.managers.values()].map(async (manager) => await manager.shutdown()));
    await this.journal.close();
  }

  private async deliverNext(projectId: string, threadId: string): Promise<string | undefined> {
    const key = `${projectId}:${threadId}`;
    const previous = this.deliveryTails.get(key) ?? Promise.resolve();
    let deliveredItemId: string | undefined;
    const next = previous.then(async () => {
      const manager = this.managerForExisting(projectId);
      if (manager.readThread(threadId).status === 'running') return;
      const pending = this.pendingMessages(projectId, threadId)[0];
      if (!pending) return;
      const previousDelivery = this.list
        .getItems(projectId)
        .find(
          (item) => item.type === 'thread.message.delivered' && item.messageId === pending.messageId
        );
      const delivered =
        previousDelivery ??
        (await this.record({
          type: 'thread.message.delivered',
          projectId,
          sourceThreadId: pending.sourceThreadId,
          targetThreadId: threadId,
          messageId: pending.messageId,
          correlationId: pending.correlationId,
          parentId: pending.parentId,
          causeId: pending.id,
          payload: { sentItemId: pending.id },
        }));
      const turnInput: import('./app-server-protocol.js').JsonValue = {
        type: 'thread.message',
        messageId: pending.messageId ?? null,
        sourceThreadId: pending.sourceThreadId ?? null,
        content: readMessageContent(pending.payload.content),
      };
      const prepared = manager.prepareTurn({
        threadId,
        input: turnInput,
      });
      deliveredItemId = delivered.id;
      const activation = await this.record({
        type: 'thread.message.activated',
        projectId,
        sourceThreadId: pending.sourceThreadId,
        targetThreadId: threadId,
        messageId: pending.messageId,
        correlationId: pending.correlationId,
        causeId: delivered.id,
        payload: { deliveredItemId: delivered.id, turnId: prepared.turn.id },
      });
      void prepared.activate().catch(async (error: unknown) => {
        await this.record({
          type: 'thread.message.failed',
          projectId,
          sourceThreadId: pending.sourceThreadId,
          targetThreadId: threadId,
          messageId: pending.messageId,
          causeId: activation.id,
          payload: { message: readMessage(error) },
        });
      });
    });
    this.deliveryTails.set(
      key,
      next.catch(() => undefined)
    );
    await next;
    return deliveredItemId;
  }

  private pendingMessages(projectId: string, threadId: string): readonly ProjectCoordinationItem[] {
    const items = this.list.getItems(projectId);
    const settled = new Set(
      items
        .filter(
          (item) =>
            (item.type === 'thread.message.activated' || item.type === 'thread.message.failed') &&
            item.messageId
        )
        .map((item) => item.messageId ?? '')
    );
    return items.filter(
      (item) =>
        item.type === 'thread.message.sent' &&
        item.targetThreadId === threadId &&
        item.messageId !== undefined &&
        !settled.has(item.messageId)
    );
  }

  private async attachResult(itemId: string, result: ThreadMessageResult): Promise<void> {
    const item = this.list.getItems().find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`Missing coordination item: ${itemId}`);
    const replacement = {
      ...item,
      payload: { ...item.payload, result },
    };
    // Result projection remains in the sent fact; journal append preserves an auditable update fact.
    await this.record({
      type: 'thread.handoff',
      projectId: item.projectId,
      sourceThreadId: item.sourceThreadId,
      targetThreadId: item.targetThreadId,
      messageId: item.messageId,
      causeId: item.id,
      payload: { result, sentSnapshot: replacement.payload },
    });
  }

  private replayCommand<T>(
    projectId: string,
    idempotencyKey: string,
    digest: string,
    type: ProjectCoordinationItemType
  ): T | undefined {
    const compacted = new Set(
      this.list
        .getItems(projectId)
        .filter((item) => item.type === 'coordination.idempotency.compacted')
        .flatMap((item) => readStringArray(item.payload.commandItemIds))
    );
    const match = this.list
      .getItems(projectId)
      .find(
        (item) =>
          item.type === type && item.idempotencyKey === idempotencyKey && !compacted.has(item.id)
      );
    if (!match) return undefined;
    if (match.payload.commandDigest !== digest) {
      throw new ProjectIdempotencyConflictError(projectId, idempotencyKey);
    }
    const result = match.payload.result as T | undefined;
    if (result !== undefined) return result;
    return this.list
      .getItems(projectId)
      .find((item) => item.type === 'thread.handoff' && item.causeId === match.id)?.payload
      .result as T | undefined;
  }

  private async record(input: ProjectCoordinationAppendInput): Promise<ProjectCoordinationItem> {
    if (this.closed) throw new Error('Project coordinator is closed');
    const item = this.list.create(input);
    await this.journal.append(item);
    this.list.commit(item);
    return item;
  }

  /** Journal facts are retained; only the replay projection is bounded. */
  private async compactIdempotency(projectId: string): Promise<void> {
    const project = await this.activeProject(projectId);
    const retention = requiredLimit(project.policy.idempotencyRetention);
    const items = this.list.getItems(projectId);
    const alreadyCompacted = new Set(
      items
        .filter((item) => item.type === 'coordination.idempotency.compacted')
        .flatMap((item) => readStringArray(item.payload.commandItemIds))
    );
    const settledMessageIds = new Set(
      items
        .filter(
          (item) =>
            (item.type === 'thread.message.activated' || item.type === 'thread.message.failed') &&
            item.messageId !== undefined
        )
        .map((item) => item.messageId ?? '')
    );
    const pendingSentIds = new Set(
      items
        .filter(
          (item) =>
            item.type === 'thread.message.sent' &&
            item.messageId !== undefined &&
            !settledMessageIds.has(item.messageId)
        )
        .map((item) => item.id)
    );
    const candidates = items.filter(
      (item) =>
        item.idempotencyKey !== undefined &&
        !alreadyCompacted.has(item.id) &&
        !pendingSentIds.has(item.id)
    );
    const expired = candidates.slice(0, Math.max(0, candidates.length - retention));
    if (expired.length === 0) return;
    await this.record({
      type: 'coordination.idempotency.compacted',
      projectId,
      payload: {
        commandItemIds: expired.map((item) => item.id),
        idempotencyKeys: expired.map((item) => item.idempotencyKey ?? ''),
        retained: retention,
      },
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return await result;
  }

  private managerFor(project: ProjectSnapshot): ThreadManager {
    const existing = this.managers.get(project.id);
    if (existing) return existing;
    const manager = this.createThreadManager(project);
    const observer: ThreadManagerObserver = (event) => {
      if (event.type === 'turn/completed' || event.type === 'turn/failed') {
        void this.deliverNext(project.id, event.threadId).catch(() => undefined);
      }
    };
    manager.observe(observer);
    this.managers.set(project.id, manager);
    return manager;
  }

  private managerForExisting(projectId: string): ThreadManager {
    const manager = this.managers.get(projectId);
    if (!manager) throw new Error(`Project runtime is not initialized: ${projectId}`);
    return manager;
  }

  private async activeProject(projectId: string): Promise<ProjectSnapshot> {
    const project = await this.projectManager.read(projectId);
    if (project.status === 'archived') throw new Error(`Project is archived: ${projectId}`);
    return project;
  }

  private assertKnownThread(projectId: string, threadId: string): void {
    this.threadSummary(projectId, threadId);
  }

  private assertThreadUsable(projectId: string, threadId: string): void {
    const summary = this.threadSummary(projectId, threadId);
    if (summary.status === 'archived') throw new Error(`Project thread is archived: ${threadId}`);
  }

  private statusFor(projectId: string, threadId: string): ProjectThreadStatus {
    const items = this.list.getItems(projectId).filter((item) => item.targetThreadId === threadId);
    if (items.some((item) => item.type === 'thread.archived')) return 'archived';
    if (items.some((item) => item.type === 'thread.canceled')) return 'canceled';
    const last = items.at(-1);
    if (last?.type === 'thread.wait.started') return 'waiting';
    if (last?.type === 'agent.lease.granted') return 'running';
    if (last?.type === 'agent.lease.recovered') return 'queued';
    if (last?.type === 'agent.lease.queued') return 'queued';
    return 'queued';
  }

  private interruptIfRunning(projectId: string, threadId: string): void {
    const manager = this.managerForExisting(projectId);
    if (manager.readThread(threadId).status === 'running') manager.interruptTurn(threadId);
  }

  private unreleasedLeases(projectId: string): readonly ProjectCoordinationItem[] {
    const released = new Set(
      this.list
        .getItems(projectId)
        .filter(
          (item) => item.type === 'agent.lease.released' || item.type === 'agent.lease.recovered'
        )
        .map((item) => item.causeId)
        .filter((itemId): itemId is string => itemId !== undefined)
    );
    return this.list
      .getItems(projectId)
      .filter((item) => item.type === 'agent.lease.granted' && !released.has(item.id));
  }
}

export class ThreadMailbox {
  constructor(private readonly coordinator: ProjectCoordinator) {}

  async send(input: SendThreadMessageInput): Promise<ThreadMessageResult> {
    return await this.coordinator.sendMessage(input);
  }
}

function stableDigest(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))
        )
      : entry
  );
}

function readNumber(value: unknown): number {
  if (typeof value !== 'number') throw new Error('Invalid coordination depth');
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function readMessageContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid durable thread message content');
  return value;
}

function requiredLimit(value: number | undefined): number {
  if (!value || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Project policy resource limit is invalid');
  }
  return value;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `message-${Date.now()}-${Math.random()}`;
}
