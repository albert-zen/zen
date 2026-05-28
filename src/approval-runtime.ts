import type {
  ToolCallPayload,
  ToolExecutionContext,
  ToolRuntime,
  ToolRuntimeEvent
} from "./tool-runtime.js";

export type PolicyDecision =
  | {
      readonly type: "allow";
      readonly reason?: string;
    }
  | {
      readonly type: "deny";
      readonly reason: string;
    }
  | {
      readonly type: "needsApproval";
      readonly reason?: string;
      readonly approvalId?: string;
    };

export interface PolicyRuntime {
  evaluate(
    call: ToolCallPayload,
    context: ToolExecutionContext
  ): PolicyDecision | Promise<PolicyDecision>;
}

export type ApprovalDecision =
  | {
      readonly type: "approve";
      readonly reason?: string;
    }
  | {
      readonly type: "approveForSession";
      readonly reason?: string;
    }
  | {
      readonly type: "decline";
      readonly reason?: string;
    }
  | {
      readonly type: "cancel";
      readonly reason?: string;
    };

export type ApprovalRequest = {
  readonly id: string;
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
  readonly decision: ApprovalDecision;
};

export type ApprovalBrokerOptions = {
  readonly generateId?: () => string;
};

export class ApprovalBroker {
  private readonly generateId: () => string;
  private readonly pending = new Map<
    string,
    PendingApprovalRequest & {
      readonly resolve: (decision: ApprovalDecision) => void;
    }
  >();

  constructor(options: ApprovalBrokerOptions = {}) {
    this.generateId = options.generateId ?? createDefaultApprovalIdGenerator();
  }

  request(
    input: Omit<ApprovalRequest, "id"> & { readonly id?: string }
  ): PendingApprovalRequest {
    const request: ApprovalRequest = {
      id: input.id ?? this.generateId(),
      call: input.call,
      runId: input.runId,
      turnId: input.turnId,
      startedItemId: input.startedItemId,
      reason: input.reason
    };

    if (this.pending.has(request.id)) {
      throw new Error(`Approval request already exists: ${request.id}`);
    }

    let resolveDecision: (decision: ApprovalDecision) => void = () => undefined;
    const decision = new Promise<ApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const pending = { request, decision, resolve: resolveDecision };

    this.pending.set(request.id, pending);

    return { request, decision };
  }

  resolve(input: ApprovalResolveInput): ApprovalRequest {
    const pending = this.pending.get(input.approvalId);

    if (!pending) {
      throw new Error(`Unknown approval request: ${input.approvalId}`);
    }

    this.pending.delete(input.approvalId);
    pending.resolve(input.decision);

    return pending.request;
  }

  listPending(): readonly PendingApprovalRequest[] {
    return [...this.pending.values()].map((pending) => ({
      request: pending.request,
      decision: pending.decision
    }));
  }
}

export class ToolApprovalDeniedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Tool call denied by policy: ${reason}`);
    this.name = "ToolApprovalDeniedError";
    this.reason = reason;
  }
}

export type PolicyToolRuntimeOptions = {
  readonly policy: PolicyRuntime;
  readonly approvalBroker: ApprovalBroker;
  readonly toolRuntime: ToolRuntime;
};

export class PolicyToolRuntime implements ToolRuntime {
  private readonly policy: PolicyRuntime;
  private readonly approvalBroker: ApprovalBroker;
  private readonly toolRuntime: ToolRuntime;

  constructor(options: PolicyToolRuntimeOptions) {
    this.policy = options.policy;
    this.approvalBroker = options.approvalBroker;
    this.toolRuntime = options.toolRuntime;
  }

  async *execute(
    call: ToolCallPayload,
    context: ToolExecutionContext
  ): AsyncIterable<ToolRuntimeEvent> {
    const decision = await this.policy.evaluate(call, context);

    if (decision.type === "allow") {
      yield* this.toolRuntime.execute(call, context);
      return;
    }

    if (decision.type === "deny") {
      yield {
        type: "error",
        error: new ToolApprovalDeniedError(decision.reason)
      };
      return;
    }

    if (decision.type === "needsApproval") {
      const pending = this.approvalBroker.request({
        id: decision.approvalId,
        call,
        runId: context.runId,
        turnId: context.turnId,
        startedItemId: context.startedItem.id,
        reason: decision.reason
      });

      yield {
        type: "output.delta",
        delta: createApprovalRequestedDelta(pending.request)
      };

      const approvalDecision = await pending.decision;

      yield {
        type: "output.delta",
        delta: createApprovalResolvedDelta(pending.request, approvalDecision)
      };

      if (isApproved(approvalDecision)) {
        yield* this.toolRuntime.execute(call, context);
        return;
      }

      yield {
        type: "error",
        error: new ToolApprovalDeniedError(
          approvalDecision.reason ?? `approval ${approvalDecision.type}`
        )
      };
    }
  }
}

function createApprovalRequestedDelta(
  request: ApprovalRequest
): Readonly<Record<string, unknown>> {
  const delta: Record<string, unknown> = {
    type: "approval.requested",
    approvalId: request.id,
    toolCallId: request.call.id,
    toolName: request.call.name
  };

  if (request.reason !== undefined) {
    delta.reason = request.reason;
  }

  return delta;
}

function createApprovalResolvedDelta(
  request: ApprovalRequest,
  decision: ApprovalDecision
): Readonly<Record<string, unknown>> {
  const delta: Record<string, unknown> = {
    type: "approval.resolved",
    approvalId: request.id,
    toolCallId: request.call.id,
    toolName: request.call.name,
    decision: decision.type
  };

  if (decision.reason !== undefined) {
    delta.reason = decision.reason;
  }

  return delta;
}

function isApproved(decision: ApprovalDecision): boolean {
  return decision.type === "approve" || decision.type === "approveForSession";
}

function createDefaultApprovalIdGenerator(): () => string {
  let nextId = 1;

  return () => `approval-${nextId++}`;
}
