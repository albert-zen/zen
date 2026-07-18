import type {
  ToolCallPayload,
  ToolExecutionContext,
  ToolRuntime,
  ToolRuntimeEvent,
} from '../kernel/index.js';

export type PolicyDecision =
  | { readonly type: 'allow'; readonly reason?: string }
  | { readonly type: 'deny'; readonly reason: string }
  | { readonly type: 'needsApproval'; readonly reason?: string; readonly approvalId?: string };

export interface PolicyRuntime {
  evaluate(
    call: ToolCallPayload,
    context: ToolExecutionContext
  ): PolicyDecision | Promise<PolicyDecision>;
}

export type ApprovalDecision =
  | {
      readonly type: 'approveOnce';
      readonly reason?: string;
      readonly resolutionRecorded?: boolean;
    }
  | { readonly type: 'decline'; readonly reason?: string; readonly resolutionRecorded?: boolean };

export type ApprovalRequest = {
  readonly id: string;
  readonly threadId: string;
  readonly call: ToolCallPayload;
  readonly runId: string;
  readonly turnId: string;
  readonly startedItemId: string;
  readonly reason?: string;
};

export type PendingApprovalRequest = {
  readonly request: ApprovalRequest;
  readonly decision: Promise<ApprovalDecision>;
};

export type ApprovalResolveInput = {
  readonly approvalId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly decision: ApprovalDecision;
};

export type PreparedApprovalResolution = {
  readonly request: ApprovalRequest;
  commit(options?: { readonly resolutionRecorded?: boolean }): void;
  abandon(reason: string): void;
};

export type ApprovalBrokerOptions = { readonly generateId?: () => string };

type PendingApproval = PendingApprovalRequest & {
  readonly resolve: (decision: ApprovalDecision) => void;
};

/** Owns the one-shot approval capability and consumes it only after tuple validation. */
export class ApprovalBroker {
  private readonly generateId: () => string;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(options: ApprovalBrokerOptions = {}) {
    this.generateId = options.generateId ?? createDefaultApprovalIdGenerator();
  }

  request(input: Omit<ApprovalRequest, 'id'> & { readonly id?: string }): PendingApprovalRequest {
    const request: ApprovalRequest = { ...input, id: input.id ?? this.generateId() };
    if (this.pending.has(request.id))
      throw new Error(`Approval request already exists: ${request.id}`);
    let resolveDecision: (decision: ApprovalDecision) => void = () => undefined;
    const decision = new Promise<ApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    this.pending.set(request.id, { request, decision, resolve: resolveDecision });
    return { request, decision };
  }

  resolve(input: ApprovalResolveInput): ApprovalRequest {
    const prepared = this.prepareResolve(input);
    prepared.commit();
    return prepared.request;
  }

  prepareResolve(input: ApprovalResolveInput): PreparedApprovalResolution {
    const pending = this.pending.get(input.approvalId);
    if (!pending)
      throw new Error(`Unknown or already resolved approval request: ${input.approvalId}`);
    if (pending.request.threadId !== input.threadId || pending.request.turnId !== input.turnId) {
      throw new Error(`Approval request tuple does not match: ${input.approvalId}`);
    }
    this.pending.delete(input.approvalId);
    let committed = false;
    const deliver = (decision: ApprovalDecision) => {
      if (committed) return;
      committed = true;
      pending.resolve(decision);
    };
    return {
      request: pending.request,
      commit: (options = {}) =>
        deliver({
          ...input.decision,
          ...(options.resolutionRecorded ? { resolutionRecorded: true } : {}),
        }),
      abandon: (reason) => deliver({ type: 'decline', reason, resolutionRecorded: true }),
    };
  }

  declineTurn(threadId: string, turnId: string, reason: string): readonly ApprovalRequest[] {
    const matches = [...this.pending.values()].filter(
      (pending) => pending.request.threadId === threadId && pending.request.turnId === turnId
    );
    for (const pending of matches) {
      this.pending.delete(pending.request.id);
      pending.resolve({ type: 'decline', reason });
    }
    return matches.map((pending) => pending.request);
  }

  listPending(): readonly PendingApprovalRequest[] {
    return [...this.pending.values()].map(({ request, decision }) => ({ request, decision }));
  }
}

export class ToolApprovalDeniedError extends Error {
  constructor(readonly reason: string) {
    super(`Tool call denied by policy: ${reason}`);
    this.name = 'ToolApprovalDeniedError';
  }
}

export type PolicyToolRuntimeOptions = {
  readonly policy: PolicyRuntime;
  readonly approvalBroker: ApprovalBroker;
  readonly toolRuntime: ToolRuntime;
};

/** A policy wrapper for controllable test or non-shell runtimes. */
export class PolicyToolRuntime implements ToolRuntime {
  constructor(private readonly options: PolicyToolRuntimeOptions) {}

  async *execute(
    call: ToolCallPayload,
    context: ToolExecutionContext
  ): AsyncIterable<ToolRuntimeEvent> {
    const policyDecision = await this.options.policy.evaluate(call, context);
    if (policyDecision.type === 'allow') {
      yield* this.options.toolRuntime.execute(call, context);
      return;
    }
    if (policyDecision.type === 'deny') {
      yield { type: 'error', error: new ToolApprovalDeniedError(policyDecision.reason) };
      return;
    }

    const pending = this.options.approvalBroker.request({
      id: policyDecision.approvalId,
      threadId: context.threadId ?? '',
      call,
      runId: context.runId,
      turnId: context.turnId,
      startedItemId: context.startedItem.id,
      reason: policyDecision.reason,
    });
    yield { type: 'approval.requested', request: toToolApprovalRequest(pending.request) };
    const decision = await pending.decision;
    const publicDecision = toPublicApprovalDecision(decision);
    if (!decision.resolutionRecorded) {
      yield {
        type: 'approval.resolved',
        request: toToolApprovalRequest(pending.request),
        decision: publicDecision,
      };
    }
    if (decision.type === 'approveOnce') {
      yield* this.options.toolRuntime.execute(call, context);
      return;
    }
    yield {
      type: 'error',
      error: new ToolApprovalDeniedError(decision.reason ?? 'approval declined'),
    };
  }
}

export function toPublicApprovalDecision(decision: ApprovalDecision): ApprovalDecision {
  return {
    type: decision.type,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  };
}

export function toToolApprovalRequest(request: ApprovalRequest) {
  return {
    id: request.id,
    threadId: request.threadId,
    turnId: request.turnId,
    runId: request.runId,
    toolCallId: request.call.id,
    toolName: request.call.name,
    input: request.call.input,
    reason: request.reason,
  };
}

function createDefaultApprovalIdGenerator(): () => string {
  let nextId = 1;
  return () => `approval-${nextId++}`;
}
