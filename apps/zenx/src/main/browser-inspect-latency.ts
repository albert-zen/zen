/** One-shot diagnostic transport, never a provider or acceptance path. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { browserInspectScript } from "./capabilities/browser-provider.js";

export const INSPECT_OUTCOME_MS = 2_000;
export const INSPECT_LATE_MS = 5_000;
export const inspectSourceSha256 = createHash("sha256")
  .update(browserInspectScript)
  .digest("hex");
// Keep the actual production expression byte-for-byte inside a timing envelope.
// Never return page text, node IDs or values in this diagnostic's evidence.
export const timedInspectExpression = `(() => {
  const started = performance.now();
  const value = (${browserInspectScript});
  const executionMs = performance.now() - started;
  return { executionMs, readyState: document.readyState,
    visibility: document.visibilityState, nodeCount: document.querySelectorAll('*').length,
    itemTotal: value.itemTotal, textTotal: value.textTotal };
})()`;

type RecordValue = Record<string, unknown>;
export type DiagnosticStatus =
  "success" | "protocol-error" | "outcome-unknown" | "transport-closed";
export interface DiagnosticReply {
  status: DiagnosticStatus;
  result?: RecordValue;
  elapsedMs: number;
}
export interface DiagnosticSocket {
  readyState: number;
  send(data: string): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}
export const recordValue = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;

/** Bounded records omit remote content and retain evidence on every error path. */
export class InspectDiagnosticTransport {
  readonly events: RecordValue[] = [];
  droppedEvents = 0;
  routeMismatch = false;
  closed = false;
  #id = 0;
  #pending = new Map<
    number,
    {
      session?: string;
      receive(reply: Omit<DiagnosticReply, "elapsedMs">): void;
    }
  >();
  #lifecycle: RecordValue[] = [];
  constructor(
    readonly socket: DiagnosticSocket,
    readonly onEvent?: (event: RecordValue) => void,
  ) {
    socket.on("message", this.#message);
    socket.on("close", this.#closed);
    socket.on("error", this.#closed);
  }
  log(event: RecordValue) {
    if (this.events.length >= 256) this.droppedEvents++;
    else {
      const measured = {
        atUnixMs: Date.now(),
        atMs: performance.now(),
        ...event,
      };
      this.events.push(measured);
      this.onEvent?.(measured);
    }
  }
  #message = (raw: unknown) => {
    let message: RecordValue | undefined;
    try {
      message = recordValue(JSON.parse(String(raw)));
    } catch {
      return;
    }
    if (!message) return;
    if (typeof message.id === "number") {
      const request = this.#pending.get(message.id);
      if (!request) return;
      if (message.sessionId !== request.session) {
        this.routeMismatch = true;
        this.log({ kind: "reply-route-mismatch", id: message.id });
        return; // A different route must never settle the owned request.
      }
      const failed =
        message.error !== undefined ||
        recordValue(message.result)?.exceptionDetails !== undefined;
      request.receive({
        status: failed ? "protocol-error" : "success",
        ...(!failed ? { result: recordValue(message.result) } : {}),
      });
      return;
    }
    if (typeof message.method !== "string") return;
    const accepted = [
      "Page.frameNavigated",
      "Page.frameStoppedLoading",
      "Runtime.executionContextCreated",
      "Runtime.executionContextDestroyed",
      "Runtime.executionContextsCleared",
      "Target.detachedFromTarget",
      "Target.targetCrashed",
    ];
    if (!accepted.includes(message.method)) return;
    this.log({ kind: "event", method: message.method });
    if (this.#lifecycle.length < 128) this.#lifecycle.push(message);
  };
  #closed = () => {
    if (this.closed) return;
    this.closed = true;
    this.log({ kind: "transport-closed" });
    for (const pending of [...this.#pending.values()])
      pending.receive({ status: "transport-closed" });
  };
  send(
    method: string,
    params: RecordValue,
    session?: string,
    timeoutMs = INSPECT_OUTCOME_MS,
  ) {
    assert(this.#pending.size < 8);
    const id = ++this.#id;
    const started = performance.now();
    let initialDone = false;
    let initialResolve!: (reply: DiagnosticReply) => void;
    let finalResolve!: (reply: DiagnosticReply) => void;
    let lateTimer: ReturnType<typeof setTimeout> | undefined;
    const initial = new Promise<DiagnosticReply>((resolve) => {
      initialResolve = resolve;
    });
    const final = new Promise<DiagnosticReply>((resolve) => {
      finalResolve = resolve;
    });
    const receive = (reply: Omit<DiagnosticReply, "elapsedMs">) => {
      if (!this.#pending.delete(id)) return;
      clearTimeout(timer);
      if (lateTimer) clearTimeout(lateTimer);
      const measured = { ...reply, elapsedMs: performance.now() - started };
      this.log({
        kind: initialDone ? "late-reply" : "reply",
        id,
        method,
        status: reply.status,
        elapsedMs: measured.elapsedMs,
      });
      if (!initialDone) {
        initialDone = true;
        initialResolve(measured);
      }
      finalResolve(measured);
    };
    const timer = setTimeout(() => {
      if (!this.#pending.has(id)) return;
      initialDone = true;
      this.log({ kind: "outcome-deadline", id, method });
      initialResolve({
        status: "outcome-unknown",
        elapsedMs: performance.now() - started,
      });
      // Retain this original ID only. No retry, reinterpretation or stage advance.
      lateTimer = setTimeout(() => {
        this.#pending.delete(id);
        this.log({ kind: "late-observation-ended", id, method });
        finalResolve({
          status: "outcome-unknown",
          elapsedMs: performance.now() - started,
        });
      }, INSPECT_LATE_MS);
    }, timeoutMs);
    this.#pending.set(id, { session, receive });
    this.log({ kind: "send", id, method, timeoutMs });
    try {
      if (this.closed || this.socket.readyState !== 1)
        throw new Error("closed");
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(session === undefined ? {} : { sessionId: session }),
        }),
      );
    } catch {
      receive({ status: "transport-closed" });
    }
    return { initial, final };
  }
  async waitLoaded(session: string, url: string, timeoutMs = 10_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (this.closed || this.routeMismatch)
        throw new Error("transport unavailable during lifecycle observation");
      const navigation = this.#lifecycle.findIndex(
        (event) =>
          event.sessionId === session &&
          event.method === "Page.frameNavigated" &&
          recordValue(recordValue(event.params)?.frame)?.url === url,
      );
      if (navigation >= 0) {
        const frame = recordValue(
          recordValue(this.#lifecycle[navigation]!.params)?.frame,
        );
        if (
          this.#lifecycle
            .slice(navigation + 1)
            .some(
              (event) =>
                event.sessionId === session &&
                event.method === "Page.frameStoppedLoading" &&
                recordValue(event.params)?.frameId === frame?.id,
            )
        )
          return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("owned navigation lifecycle was not observed");
  }
  dispose() {
    this.#closed();
    this.socket.removeListener("message", this.#message);
    this.socket.removeListener("close", this.#closed);
    this.socket.removeListener("error", this.#closed);
  }
}

export interface InspectLatencyReport {
  scope: "owned first-inspect replica; not acceptance";
  sourceSha256: string;
  classification: string;
  phase?: string;
  stages: {
    method: string;
    initial: DiagnosticReply;
    late?: DiagnosticReply;
  }[];
  browserProbe?: DiagnosticReply;
  renderer?: RecordValue;
  error?: string;
}
class StopObservation extends Error {}

export async function observeFirstInspect(options: {
  transport: InspectDiagnosticTransport;
  ownedPageUrl: string;
  listOwnedTargets(): Promise<unknown>;
  report: InspectLatencyReport;
  checkpoint?(): Promise<void>;
  progress?(report: InspectLatencyReport): void;
}) {
  const { transport, report } = options;
  let browserProbe: ReturnType<InspectDiagnosticTransport["send"]> | undefined;
  const probe = () =>
    (browserProbe ??= transport.send("Browser.getVersion", {}));
  const stage = async (
    method: string,
    params: RecordValue,
    session?: string,
    setupDeadline?: number,
  ) => {
    await options.checkpoint?.();
    const timeout =
      setupDeadline === undefined
        ? INSPECT_OUTCOME_MS
        : setupDeadline - performance.now();
    assert(timeout > 0);
    report.phase = method;
    const operation = transport.send(method, params, session, timeout);
    if (method === "Runtime.evaluate") probe();
    const initial = await operation.initial;
    // Do not store evaluation values or arbitrary remote content in the report.
    const entry: InspectLatencyReport["stages"][number] = {
      method,
      initial: { status: initial.status, elapsedMs: initial.elapsedMs },
    };
    report.stages.push(entry);
    options.progress?.(report);
    if (initial.status === "outcome-unknown") {
      report.classification = "outcome-unknown";
      options.progress?.(report);
      const late = await operation.final;
      entry.late = { status: late.status, elapsedMs: late.elapsedMs };
      if (method === "Runtime.evaluate") captureTiming(late);
      options.progress?.(report);
      report.classification = "outcome-unknown";
      throw new StopObservation();
    }
    if (initial.status !== "success" || transport.routeMismatch) {
      report.classification = transport.routeMismatch
        ? "session-route-mismatch"
        : initial.status;
      throw new StopObservation();
    }
    if (method === "Runtime.evaluate") captureTiming(initial);
    return initial.result;
  };
  const captureTiming = (reply: DiagnosticReply) => {
    const value = recordValue(recordValue(reply.result?.result)?.value);
    if (
      reply.status !== "success" ||
      !value ||
      !Number.isFinite(value.executionMs) ||
      (value.executionMs as number) < 0
    )
      return;
    report.renderer = {
      executionMs: value.executionMs,
      replyElapsedMs: reply.elapsedMs,
      readyState: ["loading", "interactive", "complete"].includes(
        String(value.readyState),
      )
        ? value.readyState
        : "invalid",
      visibility: ["visible", "hidden"].includes(String(value.visibility))
        ? value.visibility
        : "invalid",
      ...Object.fromEntries(
        ["nodeCount", "itemTotal", "textTotal"]
          .filter(
            (key) =>
              Number.isSafeInteger(value[key]) && (value[key] as number) >= 0,
          )
          .map((key) => [key, value[key]]),
      ),
    };
  };
  try {
    const page = new URL(options.ownedPageUrl);
    assert(
      page.protocol === "http:" &&
        page.hostname === "127.0.0.1" &&
        page.pathname === "/agent" &&
        !page.username &&
        !page.password &&
        !page.search &&
        !page.hash,
    );
    await stage("Target.setDiscoverTargets", { discover: true });
    await stage("Target.getTargets", {});
    const before = await stage("Target.getTargets", {});
    assert(
      Array.isArray(before?.targetInfos) && before.targetInfos.length <= 512,
    );
    const beforeIds = new Set(
      before.targetInfos.map((entry) => recordValue(entry)?.targetId),
    );
    const marker = `about:blank#zenx-pending-${randomUUID()}`;
    const created = await stage("Target.createTarget", {
      url: marker,
      background: true,
      focus: false,
    });
    assert(
      typeof created?.targetId === "string" && !beforeIds.has(created.targetId),
    );
    report.phase = "verify-created-target-marker";
    const targets = await options.listOwnedTargets();
    assert(Array.isArray(targets) && targets.length <= 512);
    const matches = targets
      .map(recordValue)
      .filter(
        (target) =>
          target?.url === marker &&
          target?.type === "page" &&
          !beforeIds.has(target.id),
      );
    assert(matches.length === 1 && matches[0]?.id === created.targetId);
    // Match production's shared 10s domain-attachment setup; all other commands,
    // including the sole first-inspect expression, retain the original 2s bound.
    const setupDeadline = performance.now() + 10_000;
    const attached = await stage("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    assert(typeof attached?.sessionId === "string");
    const session = attached.sessionId;
    for (const method of ["Page.enable", "Runtime.enable"]) {
      await stage(method, {}, session, setupDeadline);
    }
    await stage("Page.navigate", { url: page.href }, session);
    await stage("Target.getTargets", {});
    report.phase = "observe-owned-navigation-lifecycle";
    await transport.waitLoaded(session, page.href);
    const readFrame = async () => {
      const response = await stage("Page.getFrameTree", {}, session);
      const frame = recordValue(recordValue(response?.frameTree)?.frame);
      assert(
        typeof frame?.id === "string" &&
          typeof frame.loaderId === "string" &&
          frame.url === page.href,
      );
      return frame;
    };
    const frame = await readFrame();
    const barrier = await readFrame();
    assert(frame.id === barrier.id && frame.loaderId === barrier.loaderId);
    const world = await stage(
      "Page.createIsolatedWorld",
      {
        frameId: frame.id,
        worldName: "__zenx_user_browser_document__",
        grantUniveralAccess: false,
      },
      session,
    );
    assert(typeof world?.executionContextId === "number");
    const after = await readFrame();
    assert(frame.id === after.id && frame.loaderId === after.loaderId);
    await stage(
      "Runtime.evaluate",
      {
        expression: timedInspectExpression,
        awaitPromise: true,
        returnByValue: true,
        contextId: world.executionContextId,
      },
      session,
    );
    report.phase = "subject-completed";
    report.classification = report.renderer
      ? "not-reproduced"
      : "invalid-timing-result";
    // Deliberately stop here: no post-confirmation evaluation, screenshot, input,
    // or second inspection. This is a timing observation, not backend acceptance.
  } catch (error) {
    if (!(error instanceof StopObservation)) {
      report.classification = "setup-failed";
      report.error = "Owned setup/identity contract failed; no stage replayed";
    }
  } finally {
    // Persist the already-known subject result/timing before awaiting an
    // independent control query. A silent control must not hide subject evidence.
    options.progress?.(report);
    await options.checkpoint?.();
    if (browserProbe) {
      const reply = await browserProbe.initial;
      report.browserProbe = {
        status: reply.status,
        elapsedMs: reply.elapsedMs,
      };
      options.progress?.(report);
      await options.checkpoint?.();
      // At most the original browser query can settle late. No new command.
      if (reply.status === "outcome-unknown") await browserProbe.final;
    }
    if (transport.routeMismatch)
      report.classification = "session-route-mismatch";
    options.progress?.(report);
  }
  return report;
}

/** Passive only: every owns/sample/native dispatch body remains unchanged. */
export function instrumentInspectNative(source: string): string {
  const before = "func titleFor(_ pid: pid_t) -> String {";
  assert.equal(source.split(before).length, 2);
  return source.replace(
    before,
    `${before}
  let diagnosticStart = Date().timeIntervalSince1970 * 1000
  let diagnosticMonotonicStart = ProcessInfo.processInfo.systemUptime
  emit(-1,["kind":"ax-title-start","atUnixMs":diagnosticStart])
  defer { emit(-1,["kind":"ax-title-end","atUnixMs":Date().timeIntervalSince1970 * 1000,"elapsedMs":(ProcessInfo.processInfo.systemUptime-diagnosticMonotonicStart)*1000]) }`,
  );
}

/** Incremental evidence is serialized and bounded; write failure blocks new stages. */
export class InspectEvidenceJournal {
  #tail: Promise<void> = Promise.resolve();
  #failure: string | undefined;
  #sequence = 0;
  #bytes = 0;
  constructor(
    readonly options: {
      head: string;
      tree: string;
      append(line: string): Promise<unknown>;
      emit(line: string): void;
    },
  ) {}
  #fail(reason: string) {
    if (this.#failure) return;
    this.#failure = reason;
    try {
      this.options.emit(
        JSON.stringify({
          schema: 1,
          head: this.options.head,
          tree: this.options.tree,
          kind: "evidence-write-failed",
          reason,
        }),
      );
    } catch {
      /* No recursive logging after output failure. */
    }
  }
  record(kind: string, value: unknown) {
    if (this.#failure) return;
    const line =
      JSON.stringify({
        schema: 1,
        head: this.options.head,
        tree: this.options.tree,
        sequence: ++this.#sequence,
        atUnixMs: Date.now(),
        kind,
        value,
      }) + "\n";
    this.#bytes += Buffer.byteLength(line);
    if (this.#sequence > 1_024 || this.#bytes > 1_048_576) {
      this.#fail("evidence-bound-exceeded");
      return;
    }
    try {
      this.options.emit(line.trimEnd());
    } catch {
      this.#fail("evidence-console-failed");
      return;
    }
    this.#tail = this.#tail.then(async () => {
      if (this.#failure) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.options.append(line),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("evidence write deadline")),
              2_000,
            );
          }),
        ]);
      } catch {
        this.#fail("evidence-append-failed-or-timed-out");
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  }
  async flush(): Promise<void> {
    await this.#tail;
    if (this.#failure) throw new Error(this.#failure);
  }
  get failure() {
    return this.#failure;
  }
}
