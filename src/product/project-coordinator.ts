import type { Clock, IdGenerator } from '../kernel/index.js';
import type { JsonValue, ThreadSnapshot } from './app-server-protocol.js';
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
import { ThreadManager, type PreparedTurn, type ThreadManagerObserver } from './thread-manager.js';

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

export type StartThreadWaitInput = {
  readonly projectId: string;
  readonly sourceThreadId: string;
  readonly targetThreadIds: readonly string[];
  readonly mode: 'any' | 'all';
  readonly idempotencyKey: string;
  readonly parentItemId?: string;
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
  private readonly activatedTurns = new Set<string>();
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
    const manager = this.managerFor(project);
    for (const prepared of this.preparedThreads(projectId)) {
      await this.materializePreparedThread(project, prepared);
    }
    const managerIds = new Set(manager.listThreads().map((thread) => thread.id));
    const coordinationIds = new Set(
      this.listThreadSummaries(projectId).map((thread) => thread.threadId)
    );
    const unexplained = [...managerIds].filter((threadId) => !coordinationIds.has(threadId));
    const missing = [...coordinationIds].filter((threadId) => !managerIds.has(threadId));
    if (unexplained.length > 0 || missing.length > 0) {
      throw new Error(
        `Cross-journal thread reference mismatch: unexplained=${unexplained.join(',')} missing=${missing.join(',')}`
      );
    }
    for (const grant of this.unreleasedLeases(projectId)) {
      await this.record({
        type: 'agent.lease.recovered',
        projectId,
        targetThreadId: grant.targetThreadId,
        causeId: grant.id,
        payload: { recoveredFromLeaseItemId: grant.id },
      });
    }
    await this.recoverPendingHandoffs(projectId);
    this.resumeDurableTurnActivations(projectId);
    for (const wait of this.unresolvedWaits(projectId)) await this.tryWakeWait(project, wait);
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
    const digest = stableDigest({ type: 'project.thread.prepared', ...input });
    const existing = this.commandItem(
      input.projectId,
      input.idempotencyKey,
      digest,
      'project.thread.prepared'
    );
    if (existing) return await this.materializePreparedThread(project, existing);
    if (
      this.listThreadSummaries(input.projectId).length >= requiredLimit(project.policy.maxThreads)
    ) {
      throw new ProjectResourceError('maxThreads', 'Project maxThreads exceeded');
    }
    const parent = input.sourceThreadId
      ? this.threadSummary(input.projectId, input.sourceThreadId)
      : undefined;
    const depth = (parent?.depth ?? -1) + 1;
    if (depth > project.policy.maxThreadDepth) throw new Error('Project maxThreadDepth exceeded');
    const threadId = this.managerFor(project).reserveThreadId();
    const prepared = await this.record({
      type: 'project.thread.prepared',
      projectId: input.projectId,
      sourceThreadId: input.sourceThreadId,
      targetThreadId: threadId,
      idempotencyKey: input.idempotencyKey,
      parentId: input.parentItemId,
      causeId: input.causeItemId,
      payload: {
        commandDigest: digest,
        depth,
        parentThreadId: input.sourceThreadId,
        modelProfile: input.modelProfile ?? project.policy.defaultModelProfile,
        objective: input.objective,
      },
    });
    return await this.materializePreparedThread(project, prepared);
  }

  private async materializePreparedThread(
    project: ProjectSnapshot,
    prepared: ProjectCoordinationItem
  ): Promise<{ readonly threadId: string }> {
    const threadId = prepared.targetThreadId;
    if (!threadId) throw new Error(`Prepared thread is missing its target: ${prepared.id}`);
    const manager = this.managerFor(project);
    if (!manager.listThreads().some((thread) => thread.id === threadId)) {
      manager.startThread(threadId);
    }
    await manager.flushThread(threadId);
    const created = this.list
      .getItems(project.id)
      .find((item) => item.type === 'project.thread.created' && item.causeId === prepared.id);
    const result = { threadId };
    if (!created) {
      await this.record({
        type: 'project.thread.created',
        projectId: project.id,
        sourceThreadId: prepared.sourceThreadId,
        targetThreadId: threadId,
        causeId: prepared.id,
        payload: { ...prepared.payload, result, preparedItemId: prepared.id },
      });
      await this.recordCommandResult(prepared, result);
    }
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
    const existing = this.commandItem(
      input.projectId,
      input.idempotencyKey,
      digest,
      'thread.message.sent'
    );
    if (existing) {
      const replay = this.commandResult<ThreadMessageResult>(existing);
      if (replay) return replay;
      return await this.resumeSentMessage(existing);
    }
    if (Buffer.byteLength(input.content, 'utf8') > requiredLimit(project.policy.maxMessageBytes)) {
      throw new ProjectResourceError('maxMessageBytes', 'Project maxMessageBytes exceeded');
    }
    if (
      this.pendingMessages(input.projectId, input.targetThreadId).length >=
      requiredLimit(project.policy.maxQueuedMessages)
    ) {
      throw new ProjectResourceError('maxQueuedMessages', 'Project maxQueuedMessages exceeded');
    }
    this.assertThreadExecutable(input.projectId, input.sourceThreadId);
    this.assertThreadUsable(input.projectId, input.targetThreadId);
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
    await this.recordCommandResult(sent, result);
    return result;
  }

  private async resumeSentMessage(sent: ProjectCoordinationItem): Promise<ThreadMessageResult> {
    if (!sent.targetThreadId || !sent.messageId) {
      throw new Error(`Invalid pending message command: ${sent.id}`);
    }
    const deliveredItemId = await this.deliverNext(sent.projectId, sent.targetThreadId);
    const result: ThreadMessageResult = {
      messageId: sent.messageId,
      sentItemId: sent.id,
      deliveredItemId,
      targetThreadId: sent.targetThreadId,
    };
    await this.recordCommandResult(sent, result);
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
    const project = await this.activeProject(input.projectId);
    this.assertKnownThread(input.projectId, input.threadId);
    const digest = stableDigest({ type: 'thread.archived', ...input });
    if (this.replayCommand<void>(input.projectId, input.idempotencyKey, digest, 'thread.archived'))
      return;
    await this.managerForExisting(input.projectId).fenceThread(input.threadId);
    await this.record({
      type: 'thread.archived',
      projectId: input.projectId,
      targetThreadId: input.threadId,
      idempotencyKey: input.idempotencyKey,
      payload: { commandDigest: digest, result: {} },
    });
    await this.wakeWaitersFor(project, input.threadId);
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
    const project = await this.activeProject(input.projectId);
    this.assertKnownThread(input.projectId, input.threadId);
    const digest = stableDigest({ type: 'thread.canceled', ...input });
    if (this.replayCommand<void>(input.projectId, input.idempotencyKey, digest, 'thread.canceled'))
      return;
    await this.managerForExisting(input.projectId).fenceThread(input.threadId);
    await this.record({
      type: 'thread.canceled',
      projectId: input.projectId,
      targetThreadId: input.threadId,
      idempotencyKey: input.idempotencyKey,
      payload: { commandDigest: digest, result: {} },
    });
    await this.recordExecutionSettledNow({
      projectId: input.projectId,
      threadId: input.threadId,
      turnId: `thread-cancel:${input.idempotencyKey}`,
      status: 'canceled',
    });
    await this.wakeWaitersFor(project, input.threadId);
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
    this.assertThreadExecutable(input.projectId, input.sourceThreadId);
    this.assertThreadUsable(input.projectId, input.targetThreadId);
    const digest = stableDigest({ type: 'thread.handoff', ...input });
    const existing = this.commandItem(
      input.projectId,
      input.idempotencyKey,
      digest,
      'thread.handoff'
    );
    if (existing) {
      const replay = this.commandResult<{ readonly handoffItemId: string }>(existing);
      if (replay) return replay;
      return await this.completeHandoff(existing, input.content);
    }
    const item = await this.record({
      type: 'thread.handoff',
      projectId: input.projectId,
      sourceThreadId: input.sourceThreadId,
      targetThreadId: input.targetThreadId,
      idempotencyKey: input.idempotencyKey,
      payload: { commandDigest: digest, content: input.content },
    });
    return await this.completeHandoff(item, input.content);
  }

  private async completeHandoff(
    command: ProjectCoordinationItem,
    content: string
  ): Promise<{ readonly handoffItemId: string }> {
    if (!command.sourceThreadId || !command.targetThreadId || !command.idempotencyKey) {
      throw new Error(`Invalid pending handoff command: ${command.id}`);
    }
    await this.sendMessageNow({
      projectId: command.projectId,
      sourceThreadId: command.sourceThreadId,
      targetThreadId: command.targetThreadId,
      content,
      idempotencyKey: `${command.idempotencyKey}:handoff-message`,
      causeItemId: command.id,
    });
    const result = { handoffItemId: command.id };
    await this.recordCommandResult(command, result);
    return result;
  }

  private async recoverPendingHandoffs(projectId: string): Promise<void> {
    const pending = this.list
      .getItems(projectId)
      .filter((item) => item.type === 'thread.handoff' && this.commandResult(item) === undefined);
    for (const command of pending) {
      await this.completeHandoff(command, readMessageContent(command.payload.content));
    }
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
  ): 'self' | 'child' | 'descendant' | 'ancestor' | 'peer' {
    if (sourceThreadId === targetThreadId) return 'self';
    const source = this.threadSummary(projectId, sourceThreadId);
    const target = this.threadSummary(projectId, targetThreadId);
    if (target.parentThreadId === source.threadId) return 'child';
    if (this.hasAncestor(projectId, target, source.threadId)) return 'descendant';
    if (this.hasAncestor(projectId, source, target.threadId)) return 'ancestor';
    return 'peer';
  }

  private hasAncestor(projectId: string, start: ProjectThreadSummary, ancestorId: string): boolean {
    let current = start.parentThreadId;
    const seen = new Set<string>();
    while (current) {
      if (current === ancestorId) return true;
      if (seen.has(current)) throw new Error(`Project thread ancestry cycle: ${current}`);
      seen.add(current);
      current = this.threadSummary(projectId, current).parentThreadId;
    }
    return false;
  }

  async assertWaitWithinLimit(projectId: string, targets: readonly string[]): Promise<void> {
    const project = await this.activeProject(projectId);
    if (targets.length > requiredLimit(project.policy.maxWaitTargets)) {
      throw new ProjectResourceError('maxWaitTargets', 'Project maxWaitTargets exceeded');
    }
  }

  async startWait(input: StartThreadWaitInput): Promise<{
    readonly waitItemId: string;
    readonly status: 'waiting' | 'woken';
  }> {
    return await this.mutate(async () => {
      const project = await this.activeProject(input.projectId);
      this.assertThreadExecutable(input.projectId, input.sourceThreadId);
      await this.assertWaitWithinLimit(input.projectId, input.targetThreadIds);
      if (
        input.targetThreadIds.length === 0 ||
        new Set(input.targetThreadIds).size !== input.targetThreadIds.length
      ) {
        throw new Error('Thread wait targets must be a non-empty unique list');
      }
      for (const target of input.targetThreadIds) {
        this.assertKnownThread(input.projectId, target);
        if (target === input.sourceThreadId) throw new Error('Thread cannot wait on itself');
      }
      this.assertNoWaitCycle(input.projectId, input.sourceThreadId, input.targetThreadIds);
      const digest = stableDigest({ type: 'thread.wait.started', ...input });
      const existing = this.commandItem(
        input.projectId,
        input.idempotencyKey,
        digest,
        'thread.wait.started'
      );
      const wait =
        existing ??
        (await this.record({
          type: 'thread.wait.started',
          projectId: input.projectId,
          targetThreadId: input.sourceThreadId,
          idempotencyKey: input.idempotencyKey,
          parentId: input.parentItemId,
          payload: {
            commandDigest: digest,
            targets: [...input.targetThreadIds],
            mode: input.mode,
          },
        }));
      await this.tryWakeWait(project, wait);
      const woken = this.waitResolution(input.projectId, wait.id) !== undefined;
      const result = {
        waitItemId: wait.id,
        status: woken ? ('woken' as const) : ('waiting' as const),
      };
      await this.recordCommandResult(wait, result);
      return result;
    });
  }

  async recordExecutionSettled(input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly status: 'completed' | 'failed' | 'canceled';
  }): Promise<void> {
    await this.mutate(async () => {
      await this.recordExecutionSettledNow(input);
      const project = await this.activeProject(input.projectId);
      await this.wakeWaitersFor(project, input.threadId);
    });
  }

  private async recordExecutionSettledNow(input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly status: 'completed' | 'failed' | 'canceled';
  }): Promise<void> {
    const duplicate = this.list
      .getItems(input.projectId)
      .some(
        (item) =>
          item.type === 'thread.execution.settled' &&
          item.targetThreadId === input.threadId &&
          item.payload.turnId === input.turnId
      );
    if (!duplicate) {
      await this.record({
        type: 'thread.execution.settled',
        projectId: input.projectId,
        targetThreadId: input.threadId,
        payload: { turnId: input.turnId, status: input.status },
      });
    }
  }

  private async wakeWaitersFor(project: ProjectSnapshot, threadId: string): Promise<void> {
    for (const wait of this.unresolvedWaits(project.id)) {
      if (readStringArray(wait.payload.targets).includes(threadId)) {
        await this.tryWakeWait(project, wait);
      }
    }
  }

  readThread(projectId: string, threadId: string): ThreadSnapshot {
    this.assertKnownThread(projectId, threadId);
    return this.managerForExisting(projectId).readThread(threadId);
  }

  assertThreadExecutable(projectId: string, threadId: string): void {
    this.assertThreadUsable(projectId, threadId);
    const status = this.threadSummary(projectId, threadId).status;
    if (status === 'canceled') throw new Error(`Project thread is canceled: ${threadId}`);
  }

  assertThreadAcceptsNewTurn(projectId: string, threadId: string): void {
    this.assertThreadUsable(projectId, threadId);
  }

  async recordLifecycle(
    type: Exclude<
      ProjectCoordinationItemType,
      'project.thread.created' | 'thread.message.sent' | 'thread.message.delivered'
    >,
    input: Omit<ProjectCoordinationAppendInput, 'type'>
  ): Promise<ProjectCoordinationItem> {
    return await this.mutate(async () => await this.record({ ...input, type }));
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
        commandId: `message:${pending.messageId ?? pending.id}`,
      });
      let activation: ProjectCoordinationItem;
      try {
        await manager.flushThread(threadId);
        deliveredItemId = delivered.id;
        activation = await this.record({
          type: 'thread.message.activated',
          projectId,
          sourceThreadId: pending.sourceThreadId,
          targetThreadId: threadId,
          messageId: pending.messageId,
          correlationId: pending.correlationId,
          causeId: delivered.id,
          payload: { deliveredItemId: delivered.id, turnId: prepared.turn.id },
        });
      } catch (cause) {
        prepared.abandon();
        throw cause;
      }
      this.activatePreparedTurn(projectId, threadId, prepared, async (error: unknown) => {
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

  private resumeDurableTurnActivations(projectId: string): void {
    const items = this.list.getItems(projectId);
    for (const activation of items.filter((item) => item.type === 'thread.message.activated')) {
      const threadId = activation.targetThreadId;
      const turnId = readOptionalString(activation.payload.turnId);
      const sent = items.find(
        (item) => item.type === 'thread.message.sent' && item.messageId === activation.messageId
      );
      if (!threadId || !turnId || !sent) {
        throw new Error(`Invalid durable message activation: ${activation.id}`);
      }
      this.resumeQueuedTurn(
        projectId,
        threadId,
        turnId,
        `message:${sent.messageId ?? sent.id}`,
        {
          type: 'thread.message',
          messageId: sent.messageId ?? null,
          sourceThreadId: sent.sourceThreadId ?? null,
          content: readMessageContent(sent.payload.content),
        },
        async (cause) => {
          await this.record({
            type: 'thread.message.failed',
            projectId,
            sourceThreadId: sent.sourceThreadId,
            targetThreadId: threadId,
            messageId: sent.messageId,
            causeId: activation.id,
            payload: { message: readMessage(cause) },
          });
        }
      );
    }
    for (const resolution of items.filter((item) => item.type === 'thread.wait.resolved')) {
      const threadId = resolution.targetThreadId;
      const turnId = readOptionalString(resolution.payload.continuationTurnId);
      const waitItemId = resolution.causeId;
      if (!threadId || !turnId || !waitItemId) {
        throw new Error(`Invalid durable wait resolution: ${resolution.id}`);
      }
      this.resumeQueuedTurn(
        projectId,
        threadId,
        turnId,
        `wait-continuation:${waitItemId}`,
        {
          type: 'thread.wait.continuation',
          waitItemId,
          results: readJsonValue(resolution.payload.results, 'wait results'),
        },
        async (cause) => {
          await this.record({
            type: 'thread.wait.failed',
            projectId,
            targetThreadId: threadId,
            causeId: waitItemId,
            payload: { reason: readMessage(cause), continuationTurnId: turnId },
          });
        }
      );
    }
  }

  private resumeQueuedTurn(
    projectId: string,
    threadId: string,
    turnId: string,
    commandId: string,
    input: JsonValue,
    onFailure: (cause: unknown) => Promise<void>
  ): void {
    const manager = this.managerForExisting(projectId);
    const turn = manager.readThread(threadId).turns.find((candidate) => candidate.id === turnId);
    if (turn?.status !== 'queued') return;
    const prepared = manager.prepareTurn({ threadId, commandId, input });
    if (prepared.turn.id !== turnId) {
      prepared.abandon();
      throw new Error(`Durable Turn activation mismatch: ${turnId}`);
    }
    this.activatePreparedTurn(projectId, threadId, prepared, onFailure);
  }

  private activatePreparedTurn(
    projectId: string,
    threadId: string,
    prepared: PreparedTurn,
    onFailure: (cause: unknown) => Promise<void>
  ): void {
    const key = `${projectId}\u0000${threadId}\u0000${prepared.turn.id}`;
    if (this.activatedTurns.has(key)) {
      prepared.abandon();
      return;
    }
    this.activatedTurns.add(key);
    void prepared.activate().catch(onFailure);
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

  private async recordCommandResult(item: ProjectCoordinationItem, result: unknown): Promise<void> {
    if (this.commandResult(item) !== undefined) return;
    await this.record({
      type: 'coordination.command.completed',
      projectId: item.projectId,
      sourceThreadId: item.sourceThreadId,
      targetThreadId: item.targetThreadId,
      messageId: item.messageId,
      causeId: item.id,
      payload: { result },
    });
  }

  private commandResult<T>(item: ProjectCoordinationItem): T | undefined {
    const inline = item.payload.result as T | undefined;
    if (inline !== undefined) return inline;
    return this.list
      .getItems(item.projectId)
      .find(
        (candidate) =>
          candidate.type === 'coordination.command.completed' && candidate.causeId === item.id
      )?.payload.result as T | undefined;
  }

  private commandItem(
    projectId: string,
    idempotencyKey: string,
    digest: string,
    type: ProjectCoordinationItemType
  ): ProjectCoordinationItem | undefined {
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
    if (match && match.payload.commandDigest !== digest) {
      throw new ProjectIdempotencyConflictError(projectId, idempotencyKey);
    }
    return match;
  }

  private replayCommand<T>(
    projectId: string,
    idempotencyKey: string,
    digest: string,
    type: ProjectCoordinationItemType
  ): T | undefined {
    const match = this.commandItem(projectId, idempotencyKey, digest, type);
    if (!match) return undefined;
    return this.commandResult<T>(match);
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
    for (const item of [...items].reverse()) {
      if (item.type === 'thread.canceled') return 'canceled';
      if (item.type === 'thread.execution.settled' || item.type === 'agent.lease.released') {
        const status = readOptionalString(item.payload.status);
        if (status === 'completed' || status === 'failed' || status === 'canceled') return status;
      }
      if (item.type === 'thread.wait.started') return 'waiting';
      if (
        item.type === 'thread.wait.woken' ||
        item.type === 'thread.wait.resolved' ||
        item.type === 'thread.message.sent' ||
        item.type === 'thread.message.delivered' ||
        item.type === 'thread.message.activated' ||
        item.type === 'agent.lease.queued' ||
        item.type === 'project.thread.created'
      ) {
        return 'queued';
      }
      if (item.type === 'agent.lease.granted') return 'running';
      if (item.type === 'agent.lease.recovered' || item.type === 'thread.message.failed') {
        return 'failed';
      }
    }
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
        .map((item) => readOptionalString(item.payload.leaseId))
        .filter((leaseId): leaseId is string => leaseId !== undefined)
    );
    return this.list
      .getItems(projectId)
      .filter(
        (item) =>
          item.type === 'agent.lease.granted' &&
          !released.has(readOptionalString(item.payload.leaseId) ?? '')
      );
  }

  private preparedThreads(projectId: string): readonly ProjectCoordinationItem[] {
    const completed = new Set(
      this.list
        .getItems(projectId)
        .filter((item) => item.type === 'project.thread.created' && item.causeId)
        .map((item) => item.causeId ?? '')
    );
    return this.list
      .getItems(projectId)
      .filter((item) => item.type === 'project.thread.prepared' && !completed.has(item.id));
  }

  private unresolvedWaits(projectId: string): readonly ProjectCoordinationItem[] {
    const resolved = new Set(
      this.list
        .getItems(projectId)
        .filter(
          (item) =>
            (item.type === 'thread.wait.resolved' || item.type === 'thread.wait.failed') &&
            item.causeId
        )
        .map((item) => item.causeId ?? '')
    );
    return this.list
      .getItems(projectId)
      .filter((item) => item.type === 'thread.wait.started' && !resolved.has(item.id));
  }

  private waitResolution(
    projectId: string,
    waitItemId: string
  ): ProjectCoordinationItem | undefined {
    return this.list
      .getItems(projectId)
      .find(
        (item) =>
          (item.type === 'thread.wait.resolved' || item.type === 'thread.wait.failed') &&
          item.causeId === waitItemId
      );
  }

  private async tryWakeWait(
    project: ProjectSnapshot,
    wait: ProjectCoordinationItem
  ): Promise<void> {
    if (this.waitResolution(project.id, wait.id)) return;
    const sourceThreadId = wait.targetThreadId;
    if (!sourceThreadId) throw new Error(`Wait is missing its source thread: ${wait.id}`);
    const source = this.threadSummary(project.id, sourceThreadId);
    if (source.status === 'archived' || source.status === 'canceled') {
      await this.record({
        type: 'thread.wait.failed',
        projectId: project.id,
        targetThreadId: sourceThreadId,
        causeId: wait.id,
        payload: { reason: `source-${source.status}` },
      });
      return;
    }
    const targets = readStringArray(wait.payload.targets);
    const results = targets.flatMap((threadId) => {
      const status = this.threadSummary(project.id, threadId).status;
      return status === 'completed' ||
        status === 'failed' ||
        status === 'canceled' ||
        status === 'archived'
        ? [{ threadId, status }]
        : [];
    });
    const mode = wait.payload.mode === 'any' ? 'any' : 'all';
    if (
      (mode === 'any' && results.length === 0) ||
      (mode === 'all' && results.length !== targets.length)
    ) {
      return;
    }
    const manager = this.managerFor(project);
    const prepared = manager.prepareTurn({
      threadId: sourceThreadId,
      commandId: `wait-continuation:${wait.id}`,
      input: {
        type: 'thread.wait.continuation',
        waitItemId: wait.id,
        results,
      },
    });
    let resolved: ProjectCoordinationItem;
    try {
      await manager.flushThread(sourceThreadId);
      resolved = await this.record({
        type: 'thread.wait.resolved',
        projectId: project.id,
        targetThreadId: sourceThreadId,
        causeId: wait.id,
        payload: { targets, mode, results, continuationTurnId: prepared.turn.id },
      });
      await this.record({
        type: 'thread.wait.woken',
        projectId: project.id,
        targetThreadId: sourceThreadId,
        causeId: resolved.id,
        payload: { waitItemId: wait.id, continuationTurnId: prepared.turn.id },
      });
    } catch (cause) {
      prepared.abandon();
      throw cause;
    }
    this.activatePreparedTurn(project.id, sourceThreadId, prepared, async (cause: unknown) => {
      await this.record({
        type: 'thread.wait.failed',
        projectId: project.id,
        targetThreadId: sourceThreadId,
        causeId: wait.id,
        payload: { reason: readMessage(cause), continuationTurnId: prepared.turn.id },
      });
    });
  }

  private assertNoWaitCycle(
    projectId: string,
    sourceThreadId: string,
    targetThreadIds: readonly string[]
  ): void {
    const edges = new Map<string, readonly string[]>();
    for (const wait of this.unresolvedWaits(projectId)) {
      if (wait.targetThreadId)
        edges.set(wait.targetThreadId, readStringArray(wait.payload.targets));
    }
    edges.set(sourceThreadId, targetThreadIds);
    const reaches = (current: string, target: string, seen: Set<string>): boolean => {
      if (current === target) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      return (edges.get(current) ?? []).some((next) => reaches(next, target, seen));
    };
    for (const target of targetThreadIds) {
      if (reaches(target, sourceThreadId, new Set())) {
        throw new Error(`Thread wait cycle: ${sourceThreadId} -> ${target}`);
      }
    }
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

function readJsonValue(value: unknown, label: string): JsonValue {
  if (isJsonValue(value)) return value;
  throw new Error(`Invalid durable ${label}`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && value !== null && Object.values(value).every(isJsonValue);
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `message-${Date.now()}-${Math.random()}`;
}
