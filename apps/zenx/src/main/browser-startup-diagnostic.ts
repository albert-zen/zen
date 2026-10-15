/**
 * Isolated, single-shot replica of the owned fixture's initial CDP setup.
 * This is NOT the production client: it deliberately postpones its own detach
 * to observe one late reply. It cannot prove production cleanup or acceptance.
 * Never import this helper into a capability/provider implementation.
 */
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
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
  stages?: {
    method: string;
    initialOutcome: Status;
    lateOriginalResponse: string;
  }[];
  eventLoop?: { meanMs: number; maxMs: number; p99Ms: number };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Instrument a private diagnostic helper only; ordinary native source is unchanged. */
export function startupDiagnosticMacNative(source: string): string {
  const edits: [string, string][] = [
    [
      "var field: NSTextField? = nil",
      "var field: NSTextField? = nil\nvar diagnosticPidOnly = false\nvar axCalls = 0\nvar axTotalMs = 0.0\nvar axMaxMs = 0.0",
    ],
    [
      "func titleFor(_ pid: pid_t) -> String {",
      "func titleFor(_ pid: pid_t) -> String {\n  let started = ProcessInfo.processInfo.systemUptime\n  defer { let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000; axCalls += 1; axTotalMs += elapsed; axMaxMs = max(axMaxMs, elapsed) }",
    ],
    [
      "  return !AXIsProcessTrusted() || titleFor(expectedPid).contains(expectedTitle)",
      "  if diagnosticPidOnly { return true }\n  return !AXIsProcessTrusted() || titleFor(expectedPid).contains(expectedTitle)",
    ],
    [
      '"sentinelValue":field?.stringValue ?? "", "sentinelFocused":sentinel?.isKeyWindow == true && field?.currentEditor() != nil]',
      '"sentinelValue":field?.stringValue ?? "", "sentinelFocused":sentinel?.isKeyWindow == true && field?.currentEditor() != nil, "axCalls":axCalls,"axTotalMs":axTotalMs,"axMaxMs":axMaxMs]',
    ],
    [
      '  case "guard":',
      '  case "guard":\n    diagnosticPidOnly = request["diagnosticPidOnly"] as? Bool ?? false',
    ],
    [
      '  case "type":',
      '  case "type":\n    guard !diagnosticPidOnly else { emit(id,[:],"No OS input is allowed in the PID-only diagnostic"); return }',
    ],
  ];
  if (source.includes("diagnosticPidOnly"))
    throw new Error("Diagnostic native helper already instrumented");
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2)
      throw new Error("Native diagnostic seam is missing or ambiguous");
    source = source.replace(before, after);
  }
  return source;
}

/** Both endpoints must come from the caller's newly launched disposable Chrome. */
export async function diagnoseOwnedBrowserStartup(options: {
  browserSocketUrl: string;
  listOwnedTargets(): Promise<unknown>;
  /** New paired experiment only; default retains the original Page.enable replica. */
  throughIsolatedWorld?: boolean;
  /** Must be the caller's disposable loopback fixture; never a personal page. */
  ownedPageUrl?: string;
}): Promise<StartupDiagnosticReport> {
  const started = performance.now();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
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
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
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
    const sentAt = performance.now();
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
        elapsedMs: Math.round((performance.now() - sentAt) * 1000) / 1000,
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
    let ownedPage = "about:blank";
    if (options.ownedPageUrl !== undefined) {
      const page = new URL(options.ownedPageUrl);
      if (
        page.protocol !== "http:" ||
        page.hostname !== "127.0.0.1" ||
        page.pathname !== "/agent" ||
        page.username ||
        page.password ||
        page.search ||
        page.hash
      )
        throw new Error("invalid-owned-fixture-url");
      ownedPage = page.href;
    }
    const marker = `${ownedPage}#zenx-pending-${randomUUID()}`;
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

    const initialization = options.throughIsolatedWorld
      ? [
          "Page.enable",
          "Runtime.enable",
          "Page.getFrameTree",
          "Page.createIsolatedWorld",
        ]
      : ["Page.enable"];
    if (options.throughIsolatedWorld) report.stages = [];
    let frameId: string | undefined;
    for (const method of initialization) {
      const params =
        method === "Page.createIsolatedWorld"
          ? {
              frameId,
              worldName: "__zenx_user_browser_document__",
              grantUniveralAccess: false,
            }
          : {};
      if (method === "Page.createIsolatedWorld" && frameId === undefined)
        throw new Error("invalid-owned-frame");
      const enable = send(method, params, sessionId, true); // Exactly one dispatch per stage.
      // The browser-scoped probe is independent of the target session. At most
      // one is issued in this case; on earlier failure it starts at that deadline.
      const concurrentBrowser =
        method === "Page.createIsolatedWorld"
          ? send("Browser.getVersion", {})
          : undefined;
      const initial = await enable.initial;
      report.initialOutcome = initial.status; // Immutable after an unknown, including late success.
      const stage = {
        method,
        initialOutcome: initial.status,
        lateOriginalResponse: "not-observed",
      };
      report.stages?.push(stage);
      if (initial.status === "outcome-unknown") {
        const browser = concurrentBrowser ?? send("Browser.getVersion", {});
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
          stage.lateOriginalResponse = late.status;
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
          report.classification =
            "initialization-unanswered-renderer-responsive";
        } else if (browserReply.status === "success") {
          report.classification = "browser-responsive-renderer-unanswered";
        } else {
          report.classification = "transport-or-browser-unresponsive";
        }
        break; // Late evidence never advances the initialization sequence.
      } else {
        if (concurrentBrowser !== undefined)
          report.probes.browser = (await concurrentBrowser.initial).status;
        report.classification =
          initial.status === "success"
            ? "not-reproduced"
            : initial.status === "protocol-error"
              ? "initialization-known-error"
              : "transport-closed";
        if (initial.status !== "success") break;
        if (method === "Page.getFrameTree") {
          const frame = record(record(initial.result?.frameTree)?.frame);
          if (typeof frame?.id !== "string" || frame.url !== marker)
            throw new Error("invalid-owned-frame");
          frameId = frame.id;
        }
        if (
          method === "Page.createIsolatedWorld" &&
          typeof initial.result?.executionContextId !== "number"
        )
          throw new Error("invalid-isolated-context");
      }
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
    loopDelay.disable();
    const milliseconds = (value: number) =>
      Number.isFinite(value) ? Math.round(value / 1000) / 1000 : 0;
    report.eventLoop = {
      meanMs: milliseconds(loopDelay.mean),
      maxMs: milliseconds(loopDelay.max),
      p99Ms: milliseconds(loopDelay.percentile(99)),
    };
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
