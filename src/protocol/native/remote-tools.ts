import { createHash, randomUUID } from "node:crypto";
import type { ThreadSnapshot, HostOperationLease } from "../../app-server.js";
import type { JsonValue } from "../../item.js";
import {
  capturedToolOutput,
  toolOutputSuffix,
  type ToolEnvironment,
  type ToolExecutionResult,
  type PreparedToolInvocation,
} from "../../tool.js";
import { utf8Prefix } from "../../tool-output-spool.js";
import { TOOL_TASK_CONTENT_TYPE } from "../../tool-task-content.js";
import { RemoteHostError, type RemoteToolDispatch } from "./remote-host.js";
import {
  REMOTE_TOOL_VERSION,
  REMOTE_TOOL_MAX_STRUCTURED_BYTES,
  REMOTE_TOOL_MAX_ADMISSION_WINDOW_MS,
  REMOTE_TOOL_MAX_TIMEOUT_MS,
  REMOTE_TOOL_MAX_YIELD_MS,
  assertRemoteToolJson,
  parseRemoteToolCatalogRequest,
  parseRemoteToolExecuteRequest,
  parseRemoteToolWaitRequest,
  parseRemoteToolStatusRequest,
  parseRemoteToolCancelRequest,
  parseRemoteToolCatalogResult,
  parseRemoteToolResult,
  type RemoteToolBinding,
  type RemoteToolCatalogRequest,
  type RemoteToolCatalogResult,
  type RemoteToolExecuteRequest,
  type RemoteToolWaitRequest,
  type RemoteToolStatusRequest,
  type RemoteToolCancelRequest,
  type RemoteToolResult,
  type RemoteToolStatusResult,
  type RemoteToolStatus,
  type RemoteToolOrigin,
} from "./remote-tool-wire.js";

import {
  unsupportedRemoteToolSchema,
  validateRemoteToolArguments,
} from "./remote-tool-schema.js";

const RETENTION_MS = 300_000;
const MAX_ADMISSIONS = 64;
const TERMINAL = new Set(["completed", "failed", "timed_out", "cancelled"]);
type ResolveTarget = () => Promise<ThreadSnapshot>;
interface Admission {
  peerId: string;
  request: RemoteToolExecuteRequest;
  fingerprint: string;
  origin: RemoteToolOrigin;
  taskId: string;
  controller: AbortController;
  initial: Promise<RemoteToolResult>;
  current?: RemoteToolResult;
  /** Previous ack -> next receipt. Two receipts bound destructive-drain replay. */
  transition?: {
    ack: string;
    fingerprint: string;
    result: Promise<RemoteToolResult>;
  };
  localTaskId?: string;
  target?: ThreadSnapshot;
  status: RemoteToolStatus;
  expiresAtMs: number;
  revoked: boolean;
}

/** Target-owned invocation receipts over the existing ToolEnvironment/task manager. */
export class FleetToolGateway {
  readonly tools: ToolEnvironment;
  readonly hostId: string;
  readonly processEpoch: string;
  readonly #admissions = new Map<string, Admission>();
  readonly #revokedPeers = new Map<string, number>();
  #closed = false;
  constructor(options: {
    tools: ToolEnvironment;
    hostId: string;
    processEpoch: string;
  }) {
    this.tools = options.tools;
    this.hostId = options.hostId;
    this.processEpoch = options.processEpoch;
  }

  async catalog(
    request: RemoteToolCatalogRequest,
    resolveTarget: ResolveTarget,
    peerId: string,
  ): Promise<RemoteToolCatalogResult> {
    request = parse(parseRemoteToolCatalogRequest, request);
    this.#binding(request, peerId);
    await this.#target(request, resolveTarget);
    const tools = this.tools.remoteDefinitions.map((entry) => {
      const reason = entry.eligible
        ? unsupportedRemoteToolSchema(entry.definition.inputSchema)
        : entry.reason;
      return {
        ...entry,
        eligible: entry.eligible && reason === undefined,
        ...(reason === undefined ? {} : { reason }),
      };
    });
    try {
      return parseRemoteToolCatalogResult({
        version: REMOTE_TOOL_VERSION,
        hostId: this.hostId,
        processEpoch: this.processEpoch,
        tools,
      });
    } catch {
      throw new RemoteHostError(
        "entry_too_large",
        "The remote tool catalog exceeds its bounded wire contract",
      );
    }
  }

  async execute(
    request: RemoteToolExecuteRequest,
    resolveTarget: ResolveTarget,
    signal: AbortSignal,
    peerId: string,
    dispatch: RemoteToolDispatch,
  ): Promise<RemoteToolResult> {
    request = structuredClone(parse(parseRemoteToolExecuteRequest, request));
    this.#binding(request, peerId);
    signal.throwIfAborted();
    this.#sweep();
    const key = this.#key(peerId, request);
    const fingerprint = digest(request);
    const existing = this.#admissions.get(key);
    if (existing !== undefined) {
      this.#active(existing);
      if (existing.fingerprint !== fingerprint)
        throw new RemoteHostError(
          "idempotency_conflict",
          "The admission ID is already bound to another exact tool invocation",
        );
      await this.#target(request, resolveTarget);
      return structuredClone(await observe(existing.initial, signal));
    }
    const now = Date.now();
    if (now + 30_000 < request.createdAtMs || now >= request.expiresAtMs)
      throw new RemoteHostError(
        "operation_unknown",
        "The admission acceptance window has expired or is not current; it cannot be replayed",
      );
    if (this.#admissions.size >= MAX_ADMISSIONS)
      throw new RemoteHostError(
        "thread_busy",
        "Remote tool admission capacity is full; observe existing admissions first",
      );
    const admission: Admission = {
      peerId,
      request,
      fingerprint,
      origin: {
        hostId: this.hostId,
        processEpoch: this.processEpoch,
        workspaceId: request.workspaceId,
        threadId: request.targetThreadId,
        toolName: request.name,
        toolGeneration: request.toolGeneration,
      },
      taskId: `remote-tool:${Buffer.from(this.hostId).toString("base64url")}:${Buffer.from(this.processEpoch).toString("base64url")}:${randomUUID()}`,
      controller: new AbortController(),
      initial: undefined as unknown as Promise<RemoteToolResult>,
      status: "admitting",
      expiresAtMs: request.expiresAtMs + request.timeoutMs + RETENTION_MS,
      revoked: false,
    };
    this.#admissions.set(key, admission);
    admission.initial = this.#dispatch(
      admission,
      resolveTarget,
      signal,
      dispatch,
    );
    // The transport observer may leave while the admitted target task continues.
    void admission.initial.catch(() => {});
    return structuredClone(await observe(admission.initial, signal));
  }

  async wait(
    request: RemoteToolWaitRequest,
    resolveTarget: ResolveTarget,
    signal: AbortSignal,
    peerId: string,
  ): Promise<RemoteToolResult> {
    request = structuredClone(parse(parseRemoteToolWaitRequest, request));
    const admission = this.#lookup(request, peerId);
    await this.#target(request, resolveTarget);
    this.#active(admission);
    signal.throwIfAborted();
    if (request.terminate)
      admission.controller.abort(
        new Error("Remote tool cancellation requested"),
      );
    const current = await observe(admission.initial, signal);
    try {
      this.#active(admission);
    } catch {
      throw unknownObservation();
    }
    const receipt = admission.current ?? current;
    if (request.ackCursor === undefined) {
      const replay = structuredClone(receipt);
      if (
        admission.controller.signal.aborted &&
        !TERMINAL.has(receipt.status)
      ) {
        let live = admission.status;
        if (admission.localTaskId !== undefined) {
          try {
            live = taskReceipt(
              this.tools.taskManager.status(
                request.targetThreadId,
                admission.localTaskId,
              ),
            ).status;
          } catch {
            /* The acknowledged final drain establishes terminal evidence. */
          }
        }
        replay.status =
          live === "cancellation_unconfirmed" ? live : "cancel_requested";
      }
      return replay;
    }
    const fingerprint = digest({
      ackCursor: request.ackCursor,
      yieldTimeMs: request.yieldTimeMs,
      maxOutputBytes: request.maxOutputBytes,
    });
    if (admission.transition?.ack === request.ackCursor) {
      if (admission.transition.fingerprint !== fingerprint)
        throw new RemoteHostError(
          "idempotency_conflict",
          "An acknowledgement is already bound to different observation bounds",
        );
      return structuredClone(
        await observe(admission.transition.result, signal),
      );
    }
    if (request.ackCursor !== receipt.cursor)
      throw new RemoteHostError(
        "stale_cursor",
        "This receipt is no longer retained; status does not replay or restart the tool",
      );
    if (TERMINAL.has(receipt.status)) return structuredClone(receipt);
    if (admission.localTaskId === undefined || admission.target === undefined)
      throw new RemoteHostError("operation_unknown");
    // Set the transition before yielding. Concurrent/retried acknowledgements
    // share this exact destructive wait, even when its transport disconnects.
    const transition = {
      ack: request.ackCursor,
      fingerprint,
      result: undefined as unknown as Promise<RemoteToolResult>,
    };
    admission.transition = transition;
    let drainStarted = false;
    transition.result = this.#drain(admission, request, resolveTarget, () => {
      drainStarted = true;
    }).catch((error: unknown) => {
      // A failed authorization check has consumed neither output nor this ACK.
      // Once wait is entered, retain even a rejected transition: it may have
      // destructively consumed output, and repeating it would not be safe.
      if (!drainStarted && admission.transition === transition)
        delete admission.transition;
      throw error;
    });
    void transition.result.catch(() => {});
    return structuredClone(await observe(transition.result, signal));
  }

  async cancel(
    request: RemoteToolCancelRequest,
    resolveTarget: ResolveTarget,
    signal: AbortSignal,
    peerId: string,
  ): Promise<RemoteToolResult> {
    request = parse(parseRemoteToolCancelRequest, request);
    return this.wait(
      { ...request, terminate: true },
      resolveTarget,
      signal,
      peerId,
    );
  }

  async status(
    request: RemoteToolStatusRequest,
    resolveTarget: ResolveTarget,
    peerId: string,
  ): Promise<RemoteToolStatusResult> {
    request = parse(parseRemoteToolStatusRequest, request);
    const admission = this.#lookup(request, peerId);
    await this.#target(request, resolveTarget);
    this.#active(admission);
    let status = admission.status;
    if (admission.localTaskId !== undefined && !TERMINAL.has(status)) {
      try {
        status = taskReceipt(
          this.tools.taskManager.status(
            request.targetThreadId,
            admission.localTaskId,
          ),
        ).status;
      } catch {
        throw new RemoteHostError(
          "operation_unknown",
          "The target task is no longer retained by this Host instance",
        );
      }
    }
    return {
      origin: { ...admission.origin },
      admissionId: request.admissionId,
      taskId: admission.taskId,
      status,
      cursor: admission.current?.cursor ?? null,
      outputAvailable: admission.current !== undefined,
      expiresAtMs: admission.expiresAtMs,
    };
  }

  revoke(peerId: string): void {
    this.#sweep();
    // The Host's grant authentication remains authoritative. Recent tombstones
    // only fence in-flight calls; every retained admission is separately poisoned.
    if (this.#revokedPeers.size >= 1024)
      this.#revokedPeers.delete(this.#revokedPeers.keys().next().value!);
    this.#revokedPeers.set(
      peerId,
      Date.now() +
        REMOTE_TOOL_MAX_ADMISSION_WINDOW_MS +
        REMOTE_TOOL_MAX_TIMEOUT_MS +
        RETENTION_MS,
    );
    for (const admission of this.#admissions.values()) {
      if (admission.peerId !== peerId) continue;
      admission.revoked = true;
      admission.controller.abort(
        new Error("Remote peer authorization revoked"),
      );
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const admission of this.#admissions.values()) {
      admission.revoked = true;
      admission.controller.abort(new Error("Remote tool gateway closed"));
    }
    this.#admissions.clear();
    this.#revokedPeers.clear();
  }

  async #dispatch(
    admission: Admission,
    resolveTarget: ResolveTarget,
    transportSignal: AbortSignal,
    dispatch: RemoteToolDispatch,
  ): Promise<RemoteToolResult> {
    const request = admission.request;
    let prepared: PreparedToolInvocation | undefined;
    let executed = false;
    let hostAdmission: HostOperationLease | undefined;
    try {
      hostAdmission = dispatch.beginAdmission();
      const target = await this.#target(request, resolveTarget);
      transportSignal.throwIfAborted();
      this.#active(admission);
      const definition = this.tools.remoteDefinitions.find(
        (entry) => entry.definition.name === request.name,
      );
      if (
        definition === undefined ||
        definition.generation !== request.toolGeneration
      )
        throw new RemoteHostError(
          "operation_forbidden",
          "The exact remote tool generation is unavailable; refresh the target catalog",
        );
      if (!definition.eligible)
        throw new RemoteHostError(
          "operation_forbidden",
          definition.reason ??
            "This runtime does not support remote text/JSON execution",
        );
      const domainProperties = definition.definition.inputSchema.properties;
      for (const field of ["device", "target_context"]) {
        if (
          Object.hasOwn(request.arguments, field) &&
          !(
            domainProperties !== null &&
            typeof domainProperties === "object" &&
            !Array.isArray(domainProperties) &&
            Object.hasOwn(domainProperties, field)
          )
        )
          throw new RemoteHostError(
            "invalid_request",
            "Caller routing metadata is not a target tool argument",
          );
      }
      const schemaError = unsupportedRemoteToolSchema(
        definition.definition.inputSchema,
      );
      if (schemaError !== undefined)
        throw new RemoteHostError("operation_forbidden", schemaError);
      if (
        !validateRemoteToolArguments(
          definition.definition.inputSchema,
          request.arguments,
        )
      )
        throw new RemoteHostError(
          "invalid_request",
          "Tool arguments do not satisfy the target tool's exact supported JSON schema",
        );
      const timingArguments = this.tools.taskTimingArguments(request.name);
      let targetTiming: { yieldTimeMs: number; timeoutMs: number };
      try {
        // Resolve before supplying the outer task envelope: those values are
        // ceilings, not overrides of target policy or manager defaults.
        targetTiming = this.tools.resolveTaskTiming({
          name: request.name,
          arguments: request.arguments,
        });
      } catch (error) {
        throw new RemoteHostError(
          "invalid_request",
          `Invalid target task timing: ${error instanceof Error ? error.message : "invalid timing"}; no operation was dispatched`,
        );
      }
      const yieldTimeMs = effectiveRemoteTiming(
        request,
        timingArguments?.yieldTimeMs,
        request.yieldTimeMs,
        REMOTE_TOOL_MAX_YIELD_MS,
        targetTiming.yieldTimeMs,
      );
      const timeoutMs = effectiveRemoteTiming(
        request,
        timingArguments?.timeoutMs,
        request.timeoutMs,
        REMOTE_TOOL_MAX_TIMEOUT_MS,
        targetTiming.timeoutMs,
      );
      const callId = `fleet-tool:${request.admissionId}`;
      prepared = this.tools.prepare(
        {
          callId,
          name: request.name,
          arguments: request.arguments,
          cwd: target.cwd,
          sandbox: target.sandbox,
          threadId: target.id,
          outputAudience: "program",
          signal: admission.controller.signal,
          task: {
            yieldTimeMs,
            timeoutMs,
            previewBytes: request.maxOutputBytes,
          },
        },
        { targetRouting: false },
      );
      // Inherited deny is checked before normal admission, including full access.
      if ((await this.tools.admitInherited(prepared)) !== "accept")
        throw new RemoteHostError(
          "operation_forbidden",
          "The target Host has remembered a denial for this tool",
        );
      try {
        const decision = await this.tools.admit(prepared, {
          policy:
            target.approvalPolicy === "never" ? "full_access" : "ask_unknown",
          approvalRequest: {
            threadId: target.id,
            turnId: callId,
            itemId: callId,
            callId,
            toolName: request.name,
            toolArguments: prepared.invocation.arguments,
            command: request.name,
            cwd: target.cwd,
            signal: admission.controller.signal,
          },
        });
        if (decision !== "accept" && decision !== "acceptForSession")
          throw new RemoteHostError("operation_forbidden");
      } catch (error) {
        if (error instanceof Error && /approval/i.test(error.message))
          throw new RemoteHostError(
            "approval_required",
            "Approve this tool on the target Host before retrying; remote callers cannot answer target approvals",
          );
        throw error;
      }
      if ((await this.tools.admitInherited(prepared)) !== "accept")
        throw new RemoteHostError(
          "operation_forbidden",
          "The target Host revoked this tool before dispatch",
        );
      const current = await this.#target(request, resolveTarget);
      if (!sameExecutionContext(target, current))
        throw new RemoteHostError(
          "stale_thread",
          "Target execution permissions changed before dispatch",
        );
      const launched = await dispatch.dispatch(target, () => {
        // Exact registration and revocation are synchronous inside the Host fence.
        if (
          this.tools.remoteDefinitions.find(
            (entry) => entry.definition.name === request.name,
          )?.generation !== request.toolGeneration
        )
          throw new RemoteHostError(
            "operation_forbidden",
            "The remote tool registration changed before dispatch",
          );
        transportSignal.throwIfAborted();
        this.#active(admission);
        admission.controller.signal.throwIfAborted();
        admission.target = current;
        executed = true;
        admission.status = "running";
        // The existing target manager registers synchronously before returning.
        return this.tools.execute(prepared!);
      });
      hostAdmission.release();
      hostAdmission = undefined;
      // Transport abort only stops observing; this target-owned task continues.
      const result = await launched.result;
      this.#active(admission);
      return this.#retain(admission, result, request.maxOutputBytes);
    } catch (error) {
      admission.status = "failed";
      if (executed)
        throw new RemoteHostError(
          "operation_unknown",
          `The target invocation was dispatched, but its result could not be represented or observed; side effects may have occurred. Do not rerun the mutation. ${error instanceof Error ? error.message : "Unknown execution outcome"}`,
        );
      throw error;
    } finally {
      hostAdmission?.release();
      if (prepared !== undefined && !executed) this.tools.discard(prepared);
    }
  }

  async #drain(
    admission: Admission,
    request: RemoteToolWaitRequest,
    resolveTarget: ResolveTarget,
    beginDrain: () => void,
  ): Promise<RemoteToolResult> {
    await this.#target(request, resolveTarget);
    this.#active(admission);
    beginDrain();
    try {
      const result = await this.tools.waitRuntime.execute({
        callId: `fleet-observe:${randomUUID()}`,
        name: "wait",
        arguments: {
          task_id: admission.localTaskId!,
          yield_time_ms: request.yieldTimeMs,
        },
        cwd: admission.target!.cwd,
        threadId: request.targetThreadId,
        // Neither a transport abort nor operation cancellation may destroy an
        // observation. Cancellation uses the invocation's original controller.
        signal: new AbortController().signal,
      });
      this.#active(admission);
      return this.#retain(admission, result, request.maxOutputBytes);
    } catch (error) {
      throw new RemoteHostError(
        "operation_unknown",
        "The target task observation may have consumed output, but its result cannot be disclosed. Observe the same admission if access is restored; do not rerun the mutation.",
      );
    }
  }

  #retain(
    admission: Admission,
    value: ToolExecutionResult,
    maxOutputBytes: number,
  ): RemoteToolResult {
    const managed = value.contentType === TOOL_TASK_CONTENT_TYPE;
    const receipt = managed ? taskReceipt(value) : undefined;
    if (receipt !== undefined) {
      if (
        admission.localTaskId !== undefined &&
        admission.localTaskId !== receipt.taskId
      )
        throw new RemoteHostError(
          "operation_unknown",
          "The target task identity changed",
        );
      admission.localTaskId = receipt.taskId;
    }
    const status =
      receipt?.status ?? (value.exitCode === 0 ? "completed" : "failed");
    const contentType = managed ? receipt?.contentType : value.contentType;
    const structuredContent = managed
      ? receipt?.result
      : value.structuredContent;
    const media =
      value.modelContent?.some((part) => part.type !== "text") ?? false;
    if (
      media ||
      (contentType !== undefined &&
        /^(?:image|audio|video)\//iu.test(contentType))
    ) {
      admission.status = "failed";
      throw new RemoteHostError(
        "operation_forbidden",
        "The target tool returned media that cannot cross the remote text/JSON contract",
      );
    }
    if ((contentType === undefined) !== (structuredContent === undefined))
      throw new RemoteHostError(
        "operation_forbidden",
        "The target tool result is not representable as text/JSON",
      );
    try {
      if (structuredContent !== undefined)
        assertRemoteToolJson(
          structuredContent,
          REMOTE_TOOL_MAX_STRUCTURED_BYTES,
        );
    } catch {
      throw new RemoteHostError(
        "operation_forbidden",
        "The target tool returned an unrepresentable structured result",
      );
    }
    const capture = capturedToolOutput(value);
    let text: string;
    let truncated = value.sourceTruncated === true;
    if (capture === undefined) text = value.output;
    else if (capture.output !== undefined) {
      text = capture.output;
      truncated ||= capture.sourceTruncated;
    } else {
      const head = Buffer.from(capture.head);
      const tail = Buffer.from(capture.tail);
      const overlap = Math.max(
        0,
        head.length + tail.length - capture.capturedBytes,
      );
      const preview = Buffer.concat([
        head,
        tail.subarray(Math.min(overlap, tail.length)),
      ]);
      text = preview.toString("utf8");
      truncated ||=
        capture.sourceTruncated || preview.length < capture.capturedBytes;
    }
    const suffix = toolOutputSuffix(value);
    if (suffix) {
      // Existing task control text contains an unqualified Host-local task ID.
      // Keep only the runtime diagnostic; the remote envelope owns task identity.
      const diagnostic = managed ? suffix.split("\n[tool task ")[0] : suffix;
      if (diagnostic) text += diagnostic;
    }
    const modelText = value.modelContent
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (modelText) text += `\n${modelText}`;
    const encoded = Buffer.from(text);
    truncated ||= encoded.length > maxOutputBytes;
    text = utf8Prefix(encoded, maxOutputBytes).toString("utf8");
    const result: RemoteToolResult = {
      origin: { ...admission.origin },
      admissionId: admission.request.admissionId,
      taskId: admission.taskId,
      status,
      cursor: randomUUID(),
      output: text,
      exitCode: value.exitCode,
      sourceTruncated: truncated,
      paths: "remote-host",
      ...(contentType === undefined
        ? {}
        : { contentType, structuredContent: structuredContent! }),
    };
    try {
      parseRemoteToolResult(result);
    } catch {
      throw new RemoteHostError(
        "operation_forbidden",
        "The target tool returned a result outside the remote wire contract",
      );
    }
    admission.current = result;
    admission.status = status;
    if (TERMINAL.has(status))
      admission.expiresAtMs = Math.max(
        admission.request.expiresAtMs,
        Date.now() + RETENTION_MS,
      );
    return result;
  }

  #key(
    peerId: string,
    request: Pick<RemoteToolBinding, "sourceThreadId"> & {
      admissionId: string;
    },
  ): string {
    return JSON.stringify([
      peerId,
      request.sourceThreadId,
      request.admissionId,
    ]);
  }
  #lookup(
    request: RemoteToolStatusRequest | RemoteToolWaitRequest,
    peerId: string,
  ): Admission {
    this.#binding(request, peerId);
    this.#sweep();
    const admission = this.#admissions.get(this.#key(peerId, request));
    if (admission === undefined)
      throw new RemoteHostError(
        "operation_unknown",
        "The admission is unknown, expired, or belonged to another Host process; do not replay the mutation",
      );
    if (
      admission.request.workspaceId !== request.workspaceId ||
      admission.request.targetThreadId !== request.targetThreadId ||
      (request.taskId !== undefined && request.taskId !== admission.taskId)
    )
      throw new RemoteHostError(
        "operation_unknown",
        "Remote tool identity does not belong to this target binding",
      );
    this.#active(admission);
    return admission;
  }
  #binding(request: RemoteToolBinding, peerId: string): void {
    this.#sweep();
    if (request.hostId !== this.hostId) throw new RemoteHostError("wrong_host");
    if (request.processEpoch !== this.processEpoch)
      throw new RemoteHostError(
        "operation_unknown",
        "Remote tool tasks do not survive a Host process restart",
      );
    if (this.#closed || this.#revokedPeers.has(peerId))
      throw new RemoteHostError("revoked");
    if (!peerId) throw new RemoteHostError("unauthorized");
  }
  #active(admission: Admission): void {
    if (
      this.#closed ||
      admission.revoked ||
      this.#revokedPeers.has(admission.peerId)
    )
      throw new RemoteHostError("revoked");
  }
  async #target(
    request: RemoteToolBinding,
    resolveTarget: ResolveTarget,
  ): Promise<ThreadSnapshot> {
    const target = await resolveTarget();
    if (target.id !== request.targetThreadId)
      throw new RemoteHostError("stale_thread");
    return target;
  }
  #sweep(): void {
    const now = Date.now();
    for (const [peerId, expiresAt] of this.#revokedPeers)
      if (now >= expiresAt) this.#revokedPeers.delete(peerId);
    for (const [key, admission] of this.#admissions) {
      if (now >= admission.expiresAtMs) this.#admissions.delete(key);
    }
  }
}

function sameExecutionContext(
  left: ThreadSnapshot,
  right: ThreadSnapshot,
): boolean {
  return (
    left.id === right.id &&
    left.cwd === right.cwd &&
    left.sandbox === right.sandbox &&
    left.approvalPolicy === right.approvalPolicy &&
    left.archived === right.archived
  );
}
function unknownObservation(): RemoteHostError {
  return new RemoteHostError(
    "operation_unknown",
    "The target operation was observed or cancellation was requested, but access was lost. Observe the same admission if access is restored; do not rerun the mutation.",
  );
}
function parse<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value);
  } catch (error) {
    throw new RemoteHostError(
      error instanceof Error && error.message === "Unsupported tool version"
        ? "unsupported_version"
        : "invalid_request",
      error instanceof Error ? error.message : "Invalid remote tool request",
    );
  }
}
function taskReceipt(value: ToolExecutionResult): {
  taskId: string;
  status: RemoteToolStatus;
  result?: JsonValue;
  contentType?: string;
} {
  const raw = value.structuredContent;
  const data = raw as Readonly<Record<string, JsonValue>> | null | undefined;
  if (
    data === undefined ||
    data === null ||
    typeof data !== "object" ||
    Array.isArray(raw) ||
    typeof data.task_id !== "string" ||
    typeof data.status !== "string" ||
    ![
      "queued",
      "running",
      "completed",
      "failed",
      "timed_out",
      "cancel_requested",
      "cancellation_unconfirmed",
      "cancelled",
    ].includes(data.status)
  )
    throw new RemoteHostError(
      "operation_unknown",
      "Invalid target task receipt",
    );
  return {
    taskId: data.task_id,
    status: data.status as RemoteToolStatus,
    ...(data.result === undefined ? {} : { result: data.result }),
    ...(typeof data.result_content_type !== "string"
      ? {}
      : { contentType: data.result_content_type }),
  };
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
async function observe<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Remote observation disconnected"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

/** Target-declared ordinary timing survives routing; facade limits only narrow it. */
function effectiveRemoteTiming(
  request: RemoteToolExecuteRequest,
  argumentName: string | undefined,
  ceiling: number,
  maximum: number,
  targetTiming: number,
): number {
  if (
    argumentName === undefined ||
    request.arguments[argumentName] === undefined
  )
    return Math.min(ceiling, targetTiming);
  const requested = request.arguments[argumentName];
  if (
    typeof requested !== "number" ||
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    requested > maximum
  )
    throw new RemoteHostError(
      "invalid_request",
      `Target timing argument ${argumentName} must be within the remote supported range 1..${maximum}; no operation was dispatched`,
    );
  return Math.min(ceiling, targetTiming);
}
