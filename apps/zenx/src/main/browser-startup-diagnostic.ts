/**
 * Isolated, single-shot replica of the owned fixture's initial CDP setup.
 * This is NOT the production client: it deliberately postpones its own detach
 * to observe one late reply. It cannot prove production cleanup or acceptance.
 * Never import this helper into a capability/provider implementation.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";

const OUTCOME_MS = 2_000;
const LATE_OBSERVATION_MS = 5_000;
const MAX_EVENTS = 96;

type Status =
  "success" | "protocol-error" | "outcome-unknown" | "transport-closed";
interface Reply {
  status: Status;
  result?: Record<string, unknown>;
}
interface Pending {
  sessionId?: string;
  receive(reply: Reply): void;
}
export interface StartupDiagnosticReport {
  experiment: "isolated-owned-startup-replica";
  productionAcceptance: false;
  classification: string;
  initialOutcome: Status | "not-dispatched";
  lateOriginalResponse: "success" | "protocol-error" | "not-observed";
  probes: { browser?: Status; renderer?: Status };
  cleanup: Status | "no-known-session";
  events: Record<string, unknown>[];
  droppedEvents: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Both endpoints must come from the caller's newly launched disposable Chrome. */
export async function diagnoseOwnedBrowserStartup(options: {
  browserSocketUrl: string;
  listOwnedTargets(): Promise<unknown>;
}): Promise<StartupDiagnosticReport> {
  const started = performance.now();
  const report: StartupDiagnosticReport = {
    experiment: "isolated-owned-startup-replica",
    productionAcceptance: false,
    classification: "setup-failed",
    initialOutcome: "not-dispatched",
    lateOriginalResponse: "not-observed",
    probes: {},
    cleanup: "no-known-session",
    events: [],
    droppedEvents: 0,
  };
  const aliases = new Map<string, string>();
  const alias = (kind: "session" | "target", value: unknown) => {
    if (typeof value !== "string") return undefined;
    const key = `${kind}:${value}`;
    if (!aliases.has(key)) {
      // A malicious/unexpected event stream cannot grow retained identifiers.
      if (aliases.size >= 32) return `${kind}-untracked`;
      aliases.set(key, `${kind}-${aliases.size + 1}`);
    }
    return aliases.get(key);
  };
  const emit = (event: Record<string, unknown>) => {
    if (report.events.length >= MAX_EVENTS) {
      report.droppedEvents++;
      return;
    }
    report.events.push({
      atMs: Math.round(performance.now() - started),
      ...event,
    });
  };
  const socket = new WebSocket(options.browserSocketUrl, {
    handshakeTimeout: 5_000,
    maxPayload: 1_048_576,
  });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let sessionId: string | undefined;
  let routeMismatch = false;
  let closed = false;
  const events = new Set([
    "Target.attachedToTarget",
    "Target.detachedFromTarget",
    "Target.targetCreated",
    "Target.targetDestroyed",
    "Target.targetCrashed",
    "Target.targetInfoChanged",
    "Page.frameNavigated",
    "Page.frameStartedLoading",
    "Page.frameStoppedLoading",
  ]);
  socket.on("message", (raw) => {
    let message: Record<string, unknown> | undefined;
    try {
      message = record(JSON.parse(String(raw)));
    } catch {
      emit({ kind: "invalid-json" });
      return;
    }
    if (!message) return;
    if (typeof message.id === "number") {
      const request = pending.get(message.id);
      if (!request) return;
      if (message.sessionId !== request.sessionId) {
        routeMismatch = true;
        emit({
          kind: "reply-route-mismatch",
          id: message.id,
          expectedSession: alias("session", request.sessionId),
          actualSession: alias("session", message.sessionId),
        });
        return; // Never settle a different session's request.
      }
      request.receive(
        record(message.error)
          ? { status: "protocol-error" }
          : { status: "success", result: record(message.result) },
      );
      return;
    }
    if (typeof message.method !== "string" || !events.has(message.method))
      return;
    const params = record(message.params);
    const info = record(params?.targetInfo);
    emit({
      kind: "event",
      method: message.method,
      session: alias("session", message.sessionId ?? params?.sessionId),
      target: alias("target", params?.targetId ?? info?.targetId),
      ...(typeof params?.waitingForDebugger === "boolean"
        ? { waitingForDebugger: params.waitingForDebugger }
        : {}),
    });
  });
  const fail = () => {
    if (closed) return;
    closed = true;
    emit({ kind: "transport-closed" });
    for (const request of [...pending.values()])
      request.receive({ status: "transport-closed" });
  };
  socket.on("close", fail);
  socket.on("error", fail);

  const send = (
    method: string,
    params: Record<string, unknown>,
    targetSession?: string,
    observeLate = false,
  ) => {
    const id = nextId++;
    let initialDone = false;
    let resolveInitial!: (reply: Reply) => void;
    let resolveFinal!: (reply: Reply) => void;
    let lateTimer: ReturnType<typeof setTimeout> | undefined;
    const initial = new Promise<Reply>((resolve) => {
      resolveInitial = resolve;
    });
    const final = new Promise<Reply>((resolve) => {
      resolveFinal = resolve;
    });
    const finish = (reply: Reply) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      if (lateTimer) clearTimeout(lateTimer);
      emit({
        kind: initialDone ? "late-reply" : "reply",
        id,
        method,
        session: alias("session", targetSession),
        status: reply.status,
      });
      if (!initialDone) {
        initialDone = true;
        resolveInitial(reply);
      }
      resolveFinal(reply);
    };
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      initialDone = true;
      emit({
        kind: "outcome-deadline",
        id,
        method,
        outcome: "outcome-unknown",
      });
      resolveInitial({ status: "outcome-unknown" });
      if (observeLate) {
        lateTimer = setTimeout(() => {
          pending.delete(id);
          emit({ kind: "late-observation-ended", id, method });
          resolveFinal({ status: "outcome-unknown" });
        }, LATE_OBSERVATION_MS);
      } else {
        pending.delete(id);
        resolveFinal({ status: "outcome-unknown" });
      }
    }, OUTCOME_MS);
    pending.set(id, { sessionId: targetSession, receive: finish });
    emit({
      kind: "send",
      id,
      method,
      session: alias("session", targetSession),
    });
    try {
      if (closed || socket.readyState !== WebSocket.OPEN)
        throw new Error("closed");
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(targetSession === undefined ? {} : { sessionId: targetSession }),
        }),
      );
    } catch {
      finish({ status: "transport-closed" });
    }
    return { initial, final };
  };
  const requireSuccess = async (
    method: string,
    params: Record<string, unknown>,
  ) => {
    const reply = await send(method, params).initial;
    if (reply.status !== "success") throw new Error("setup-failed");
    return reply.result;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("closed-before-open")));
    });
    await requireSuccess("Target.setDiscoverTargets", { discover: true });
    // Match the provider's connect/list and open/list sequence, without using it.
    await requireSuccess("Target.getTargets", {});
    const before = await requireSuccess("Target.getTargets", {});
    if (!Array.isArray(before?.targetInfos) || before.targetInfos.length > 512)
      throw new Error("invalid-target-list");
    const beforeIds = new Set(
      before.targetInfos.map((entry) => record(entry)?.targetId),
    );
    const marker = `about:blank#zenx-pending-${randomUUID()}`;
    const created = await requireSuccess("Target.createTarget", {
      url: marker,
      background: true,
      focus: false,
    });
    if (
      typeof created?.targetId !== "string" ||
      beforeIds.has(created.targetId)
    )
      throw new Error("invalid-created-target");
    emit({ kind: "created-target", target: alias("target", created.targetId) });
    let listTimer: ReturnType<typeof setTimeout> | undefined;
    let targets: unknown;
    try {
      targets = await Promise.race([
        options.listOwnedTargets(),
        new Promise<never>((_resolve, reject) => {
          listTimer = setTimeout(
            () => reject(new Error("owned-list-deadline")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (listTimer) clearTimeout(listTimer);
    }
    if (!Array.isArray(targets) || targets.length > 512)
      throw new Error("invalid-owned-target-list");
    const matches = targets
      .map(record)
      .filter((entry) => entry?.url === marker && !beforeIds.has(entry.id));
    if (
      matches.length !== 1 ||
      matches[0]?.id !== created.targetId ||
      matches[0]?.type !== "page"
    )
      throw new Error("marker-mismatch");
    const attached = await requireSuccess("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    if (typeof attached?.sessionId !== "string")
      throw new Error("invalid-session");
    sessionId = attached.sessionId;
    emit({
      kind: "attached-session",
      session: alias("session", sessionId),
      target: alias("target", created.targetId),
    });

    const enable = send("Page.enable", {}, sessionId, true); // Exactly one dispatch.
    const initial = await enable.initial;
    report.initialOutcome = initial.status; // Immutable thereafter, including late success.
    if (initial.status === "outcome-unknown") {
      const browser = send("Browser.getVersion", {});
      const renderer = send("Runtime.getIsolateId", {}, sessionId);
      const [late, browserReply, rendererReply] = await Promise.all([
        enable.final,
        browser.initial,
        renderer.initial,
      ]);
      report.probes = {
        browser: browserReply.status,
        renderer: rendererReply.status,
      };
      if (late.status === "success" || late.status === "protocol-error") {
        report.lateOriginalResponse = late.status;
        report.classification = "initialization-original-reply-late";
      } else if (
        browserReply.status === "protocol-error" ||
        rendererReply.status === "protocol-error"
      ) {
        report.classification = "probe-protocol-error";
      } else if (
        browserReply.status === "success" &&
        rendererReply.status === "success"
      ) {
        report.classification = "page-enable-unanswered-renderer-responsive";
      } else if (browserReply.status === "success") {
        report.classification = "browser-responsive-renderer-unanswered";
      } else {
        report.classification = "transport-or-browser-unresponsive";
      }
    } else {
      report.classification =
        initial.status === "success"
          ? "not-reproduced"
          : initial.status === "protocol-error"
            ? "initialization-known-error"
            : "transport-closed";
    }
    if (closed) report.classification = "transport-closed";
    if (routeMismatch) report.classification = "session-route-mismatch";
  } catch {
    // Do not publish endpoints, page content, marker URLs, or remote error text.
    report.classification = routeMismatch
      ? "session-route-mismatch"
      : closed
        ? "transport-closed"
        : "setup-failed";
  } finally {
    if (sessionId !== undefined && !closed) {
      report.cleanup = (
        await send("Target.detachFromTarget", { sessionId }).initial
      ).status;
    } else if (sessionId !== undefined) {
      report.cleanup = "transport-closed";
    }
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }
  return report;
}
