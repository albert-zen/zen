import { localErrorDetail } from "../../local-error-detail.js";
import type {
  BrowserModelTargets,
  BrowserModelRoute,
} from "./model-browser-metadata.js";
import { browserOperationOrder } from "./browser-operation-order.js";
import type { ToolInvocation } from "../../../../../src/tool.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  BrowserLiveObservationEvent,
  BrowserScreenshotArtifact,
  BrowserTabSummary,
  ZenXBrowserBackend,
} from "./browser-provider.js";

export interface BrowserThreadTarget extends BrowserTabSummary {
  activityCount?: number;
  previewSequence?: number;
  previewActive?: boolean;
  activityFailed?: boolean;
  backendId?: "workspace" | "connected";
  connectionId?: string;
  connectionLabel?: string;
  id: string;
  mode: "live" | "snapshot";
  /** Product-only capability; full URLs are resolved privately by the Host. */
  canOpenExternally?: boolean;
}
export interface BrowserThreadRequest {
  threadId: string;
  /** Only the exact presented target receives observations. Omission is catalog-only. */
  targetId?: string;
  frames: boolean;
  /** Separate catalog/activity lane; never grants frame or external-open authority. */
  catalog?: true;
}
export interface BrowserThreadActivity {
  type: "activity";
  threadId: string;
  sessionEpoch: string;
  operationId: string;
  operationSequence: number;
  callId: string;
  canonicalToolCallId?: string;
  targetId: string;
  requestedAt: number;
  phase: "started" | "completed" | "failed";
}
export type BrowserThreadEvent =
  | {
      type: "turn-ended";
      threadId: string;
      throughSequence: number;
      failed: boolean;
      message?: string;
    }
  | BrowserThreadActivity
  | Exclude<BrowserLiveObservationEvent, { type: "metadata" }>
  | { type: "targets"; targets: BrowserThreadTarget[]; selectedId?: string }
  | {
      type: "snapshot";
      data: string;
      mimeType: "image/png";
      capturedAt: string;
      width: number;
      height: number;
    };
export type BrowserThreadListener = (event: BrowserThreadEvent) => void;
interface ThreadSession {
  key: string;
  threadId: string;
  sessionId: string;
  providerSessionId: string;
  targets: Map<
    string,
    {
      summary: BrowserThreadTarget;
      failureGeneration: number;
      screenshot?: BrowserScreenshotArtifact;
      capturedAt?: string;
    }
  >;
}
interface Observer {
  request: BrowserThreadRequest;
  listener: BrowserThreadListener;
  generation: number;
  stop?: () => void;
}

/** Product-owned ephemeral browser resources; never a second Thread history. */
export class BrowserThreadObservation {
  readonly #backend: ZenXBrowserBackend;
  readonly #sessions = new Map<string, ThreadSession>();
  readonly #observers = new Set<Observer>();
  #closed = false;
  constructor(backend: ZenXBrowserBackend) {
    this.#backend = backend;
  }

  session(threadId: string, sessionId: string): ThreadSession {
    if (this.#closed) throw new Error("Browser provider is closed");
    if (threadId.length === 0 || threadId.length > 512)
      throw new Error("Invalid Browser thread identity");
    const key = JSON.stringify([threadId, sessionId]);
    let session = this.#sessions.get(key);
    if (session === undefined) {
      if (this.#sessions.size >= 256)
        throw new Error("Close unused Browser sessions before opening more");
      session = {
        key,
        threadId,
        sessionId,
        providerSessionId: randomUUID(),
        targets: new Map(),
      };
      this.#sessions.set(key, session);
      this.#backend.bindThreadSession?.(session.providerSessionId, threadId);
    }
    return session;
  }

  /** Read-only lookup: never creates a session or a product target. */
  modelTargets(
    threadId: string,
    sessionId: string,
  ): BrowserModelTargets | undefined {
    const session = this.#sessions.get(JSON.stringify([threadId, sessionId]));
    if (this.#closed || !session) return;
    return {
      route: {
        ownerThreadId: threadId,
        sessionId,
        sessionEpoch: session.providerSessionId,
      },
      targets: [...session.targets.values()].map(({ summary }) => ({
        tabId: summary.tabId,
        targetId: summary.id,
      })),
    };
  }

  assertModelTarget(
    route: BrowserModelRoute,
    threadId: string | undefined,
  ): void {
    const current = this.modelTargets(route.ownerThreadId, route.sessionId);
    if (
      threadId !== route.ownerThreadId ||
      !current ||
      current.route.sessionEpoch !== route.sessionEpoch ||
      (route.tabId !== undefined &&
        !current.targets.some(
          (t) => t.tabId === route.tabId && t.targetId === route.targetId,
        ))
    )
      throw Error(
        "Browser reference is no longer current; list tabs and inspect again",
      );
  }

  publish(
    session: ThreadSession,
    tool: string,
    result: unknown,
    tabId?: string,
  ): void {
    if (this.#closed || this.#sessions.get(session.key) !== session) return;
    if (tool === "browser_close_session") {
      const throughSequence = Math.max(
        0,
        ...[...session.targets.values()].map(
          (t) => t.summary.previewSequence ?? 0,
        ),
      );
      this.#sessions.delete(session.key);
      this.completeTurn(session.threadId, throughSequence);
      return;
    } else if (tool === "browser_close") {
      const target =
        tabId === undefined ? undefined : session.targets.get(tabId);
      if (tabId !== undefined) session.targets.delete(tabId);
      this.completeTurn(session.threadId, target?.summary.previewSequence ?? 0);
      return;
    } else {
      const values = Array.isArray(result) ? result : [result];
      if (tool === "browser_list_tabs") {
        const ids = new Set(
          values.map((value) => (value as BrowserTabSummary).tabId),
        );
        for (const id of session.targets.keys())
          if (!ids.has(id)) session.targets.delete(id);
      }
      for (const value of values) {
        const summary = value as BrowserTabSummary & {
          screenshot?: BrowserScreenshotArtifact;
        };
        if (typeof summary.tabId !== "string") continue;
        const prior = session.targets.get(summary.tabId);
        // Extension data is not a new tab metadata or screenshot observation.
        if ("data" in summary || "operations" in summary) continue;
        const target = {
          failureGeneration: prior?.failureGeneration ?? 0,
          summary: {
            activityCount: prior?.summary.activityCount,
            activityFailed: prior?.summary.activityFailed,
            previewSequence: prior?.summary.previewSequence,
            previewActive: prior?.summary.previewActive,
            sessionId: session.sessionId,
            tabId: summary.tabId,
            title: summary.title,
            url: summary.url,
            loading: summary.loading,
            canOpenExternally: this.#backend.readCurrentUrl !== undefined,
            id: prior?.summary.id ?? randomUUID(),
            mode:
              this.#backend.observeTab === undefined
                ? ("snapshot" as const)
                : ("live" as const),
          },
          ...(tool === "browser_list_tabs"
            ? { screenshot: prior?.screenshot, capturedAt: prior?.capturedAt }
            : {}),
          ...(summary.screenshot === undefined
            ? {}
            : {
                screenshot: summary.screenshot,
                capturedAt: new Date().toISOString(),
              }),
        };
        session.targets.set(summary.tabId, target);
      }
    }
    this.#notify(session.threadId);
  }

  /** Passive Host operation projection; never authorizes dispatch or replay. */
  operation(
    session: ThreadSession,
    tool: string,
    invocation: ToolInvocation,
  ): (failed: boolean, result?: unknown) => void {
    if (
      ["browser_list_tabs", "browser_close", "browser_close_session"].includes(
        tool,
      )
    )
      return () => {};
    const operationId = randomUUID();
    const operationSequence = browserOperationOrder();
    const requestedAt = Date.now();
    let target =
      typeof invocation.arguments.tabId === "string"
        ? session.targets.get(invocation.arguments.tabId)
        : undefined;
    const failureGeneration = target?.failureGeneration ?? 0;
    const current = () =>
      !this.#closed &&
      this.#sessions.get(session.key) === session &&
      target !== undefined &&
      session.targets.get(target.summary.tabId)?.summary.id ===
        target.summary.id;
    const emit = (phase: BrowserThreadActivity["phase"]) => {
      if (!current()) return;
      // publish() can replace the target value while preserving its observer ID.
      target = session.targets.get(target!.summary.tabId)!;
      if (phase === "failed") target.failureGeneration++;
      target.summary = {
        ...target.summary,
        previewSequence: Math.max(
          target.summary.previewSequence ?? 0,
          operationSequence,
        ),
        previewActive: true,
        activityCount: Math.max(
          0,
          (target.summary.activityCount ?? 0) + (phase === "started" ? 1 : -1),
        ),
        activityFailed:
          phase === "failed" ||
          ((phase === "started" ||
            target.failureGeneration !== failureGeneration) &&
            target.summary.activityFailed === true),
      };
      for (const observer of [...this.#observers]) {
        if (observer.request.threadId !== session.threadId) continue;
        this.#sendTargetSnapshot(observer);
        if (!this.#observers.has(observer)) continue;
        try {
          observer.listener({
            type: "activity",
            threadId: session.threadId,
            sessionEpoch: session.providerSessionId,
            operationId,
            operationSequence,
            callId: invocation.callId,
            canonicalToolCallId: invocation.canonicalToolCallId,
            targetId: target.summary.id,
            requestedAt,
            phase,
          });
        } catch {
          this.#observers.delete(observer);
          observer.generation++;
          this.#stop(observer);
        }
      }
    };
    const started = target !== undefined;
    if (started) emit("started");
    let settled = false;
    return (failed, result) => {
      if (settled) return;
      settled = true;
      if (
        !started &&
        !failed &&
        typeof result === "object" &&
        result !== null &&
        "tabId" in result &&
        typeof result.tabId === "string"
      ) {
        target = session.targets.get(result.tabId);
        emit("started");
      }
      emit(failed ? "failed" : "completed");
    };
  }

  finishTurn(threadId: string): {
    sessions: string[];
    throughSequence: number;
    operationFailed: boolean;
  } {
    const sessions = [...this.#sessions.values()].filter(
      (s) => s.threadId === threadId,
    );
    for (const session of sessions) this.#sessions.delete(session.key);
    return {
      sessions: sessions.map((s) => s.providerSessionId),
      operationFailed: sessions.some((s) =>
        [...s.targets.values()].some((t) => t.summary.activityFailed),
      ),
      throughSequence: Math.max(
        0,
        ...sessions.flatMap((s) =>
          [...s.targets.values()].map((t) => t.summary.previewSequence ?? 0),
        ),
      ),
    };
  }

  completeTurn(
    threadId: string,
    throughSequence: number,
    error?: unknown,
  ): void {
    for (const observer of [...this.#observers]) {
      if (observer.request.threadId !== threadId) continue;
      try {
        observer.listener({
          type: "turn-ended",
          threadId,
          throughSequence,
          failed: error !== undefined,
          ...(error === undefined
            ? {}
            : { message: localErrorDetail(error).slice(0, 2048) }),
        });
      } catch {
        this.#observers.delete(observer);
        this.#stop(observer);
      }
    }
    this.#notify(threadId);
  }

  /** Reobserve only an already-owned native target, never discovery/adoption. */
  async readModelTarget(
    threadId: string,
    targetId: string,
  ): Promise<BrowserModelRoute | undefined> {
    const session = [...this.#sessions.values()].find(
      (value) =>
        value.threadId === threadId &&
        [...value.targets.values()].some(
          (target) => target.summary.id === targetId,
        ),
    );
    const target =
      session &&
      [...session.targets.values()].find(
        (value) => value.summary.id === targetId,
      );
    if (this.#closed || !session || !target || !this.#backend.hasTab) return;
    const route: BrowserModelRoute = {
      ownerThreadId: threadId,
      sessionId: session.sessionId,
      sessionEpoch: session.providerSessionId,
      tabId: target.summary.tabId,
      targetId,
    };
    if (
      !(await this.#backend.hasTab(
        session.providerSessionId,
        target.summary.tabId,
      ))
    )
      return;
    this.assertModelTarget(route, threadId);
    return route;
  }

  async readTargetUrl(threadId: string, targetId: string): Promise<string> {
    const session = [...this.#sessions.values()].find(
      (value) =>
        value.threadId === threadId &&
        [...value.targets.values()].some(
          (target) => target.summary.id === targetId,
        ),
    );
    const target =
      session &&
      [...session.targets.values()].find(
        (value) => value.summary.id === targetId,
      );
    if (this.#closed || !session || !target || !this.#backend.readCurrentUrl)
      throw new Error("Browser target is unavailable");
    const url = await this.#backend.readCurrentUrl(
      session.providerSessionId,
      target.summary.tabId,
    );
    if (
      this.#closed ||
      this.#sessions.get(session.key) !== session ||
      session.targets.get(target.summary.tabId)?.summary.id !== targetId
    )
      throw new Error("Browser target is no longer current");
    return url;
  }

  observe(
    request: BrowserThreadRequest,
    listener: BrowserThreadListener,
  ): () => void {
    const observer: Observer = { request, listener, generation: 0 };
    this.#observers.add(observer);
    this.#render(observer);
    return () => {
      this.#observers.delete(observer);
      observer.generation += 1;
      this.#stop(observer);
    };
  }

  close(): string[] {
    const sessions = [...this.#sessions.values()].map(
      (session) => session.providerSessionId,
    );
    this.#closed = true;
    this.#sessions.clear();
    for (const observer of this.#observers) this.#render(observer);
    this.#observers.clear();
    return sessions;
  }

  #notify(threadId: string): void {
    for (const observer of this.#observers)
      if (observer.request.threadId === threadId) this.#render(observer);
  }

  #stop(observer: Observer): void {
    const stop = observer.stop;
    observer.stop = undefined;
    try {
      stop?.();
    } catch {
      /* Observation cleanup must not fail an Agent action. */
    }
  }

  #render(observer: Observer): void {
    const generation = ++observer.generation;
    this.#stop(observer);
    observer.stop = undefined;
    const send: BrowserThreadListener = (event) => {
      if (observer.generation !== generation || !this.#observers.has(observer))
        return;
      try {
        observer.listener(event);
      } catch {
        this.#observers.delete(observer);
        observer.generation += 1;
        this.#stop(observer);
      }
    };
    const targets = [...this.#sessions.values()]
      .filter((session) => session.threadId === observer.request.threadId)
      .flatMap((session) =>
        [...session.targets.values()].map((target) => ({ session, target })),
      );
    const selected = targets.find(
      ({ target }) => target.summary.id === observer.request.targetId,
    );
    send({
      type: "targets",
      targets: targets.map(({ target }) => target.summary),
      ...(selected === undefined
        ? {}
        : { selectedId: selected.target.summary.id }),
    });
    if (selected === undefined || !observer.request.frames || this.#closed) {
      send({
        type: "status",
        status: this.#closed ? "unavailable" : "idle",
        message: this.#closed
          ? "The Browser provider is no longer available."
          : "No browser page is selected for this thread.",
      });
      return;
    }
    if (!this.#observers.has(observer)) return;
    if (this.#backend.observeTab !== undefined) {
      try {
        observer.stop = this.#backend.observeTab(
          selected.session.providerSessionId,
          selected.target.summary.tabId,
          (event) => {
            if (
              observer.generation !== generation ||
              !this.#observers.has(observer)
            )
              return;
            if (event.type !== "metadata") {
              send(event);
              return;
            }
            const current = selected.session.targets.get(
              selected.target.summary.tabId,
            );
            if (current === undefined) return;
            current.summary = {
              ...current.summary,
              title: event.title,
              url: event.url,
              ...(event.loading === undefined
                ? {}
                : { loading: event.loading }),
            };
            for (const candidate of [...this.#observers]) {
              if (candidate.request.threadId !== selected.session.threadId)
                continue;
              this.#sendTargetSnapshot(candidate);
            }
          },
        );
        if (!this.#observers.has(observer)) this.#stop(observer);
      } catch (error) {
        send({
          type: "status",
          status: "unavailable",
          message:
            "This browser page is no longer available. Ask the Agent to inspect it again.",
          details: localErrorDetail(error),
        });
      }
      return;
    }
    const { screenshot, capturedAt } = selected.target;
    send({
      type: "status",
      status: "idle",
      message: "Showing the latest Agent screenshot, not a live stream.",
    });
    if (screenshot === undefined || capturedAt === undefined) {
      send({
        type: "status",
        status: "idle",
        message:
          "Waiting for the Agent to inspect this page. This provider shows snapshots.",
      });
      return;
    }
    if (Date.parse(screenshot.expiresAt) <= Date.now()) {
      send({
        type: "status",
        status: "unavailable",
        message:
          "The last screenshot expired. Ask the Agent to inspect this page again.",
      });
      return;
    }
    void readFile(screenshot.artifactPath)
      .then((data) => {
        if (
          data.byteLength > 4 * 1024 * 1024 ||
          data.byteLength !== screenshot.bytes
        )
          throw new Error("Invalid screenshot");
        send({
          type: "snapshot",
          data: data.toString("base64"),
          mimeType: "image/png",
          capturedAt,
          width: screenshot.width,
          height: screenshot.height,
        });
      })
      .catch((error) =>
        send({
          type: "status",
          status: "unavailable",
          message:
            "The last screenshot is no longer available. Ask the Agent to inspect this page again.",
          details: localErrorDetail(error),
        }),
      );
  }

  #sendTargetSnapshot(observer: Observer): void {
    const targets = [...this.#sessions.values()]
      .filter((session) => session.threadId === observer.request.threadId)
      .flatMap((session) =>
        [...session.targets.values()].map((target) => target.summary),
      );
    const selected = targets.find(
      (target) => target.id === observer.request.targetId,
    );
    try {
      observer.listener({
        type: "targets",
        targets,
        ...(selected === undefined ? {} : { selectedId: selected.id }),
      });
    } catch {
      this.#observers.delete(observer);
      observer.generation += 1;
      this.#stop(observer);
    }
  }
}
