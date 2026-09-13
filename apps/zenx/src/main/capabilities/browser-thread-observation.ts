import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  BrowserLiveObservationEvent,
  BrowserScreenshotArtifact,
  BrowserTabSummary,
  ZenXBrowserBackend,
} from "./browser-provider.js";

export interface BrowserThreadTarget extends BrowserTabSummary {
  id: string;
  mode: "live" | "snapshot";
}
export interface BrowserThreadRequest {
  threadId: string;
  targetId?: string;
  frames: boolean;
}
export type BrowserThreadEvent =
  | BrowserLiveObservationEvent
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
  readonly #latest = new Map<string, string>();
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
    }
    return session;
  }

  publish(
    session: ThreadSession,
    tool: string,
    result: unknown,
    tabId?: string,
  ): void {
    if (this.#closed || this.#sessions.get(session.key) !== session) return;
    if (tool === "browser_close_session") {
      this.#sessions.delete(session.key);
      if (
        ![...this.#sessions.values()].some(
          (value) => value.threadId === session.threadId,
        )
      )
        this.#latest.delete(session.threadId);
    } else if (tool === "browser_close") {
      if (tabId !== undefined) session.targets.delete(tabId);
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
        const target = {
          summary: {
            sessionId: session.sessionId,
            tabId: summary.tabId,
            title: summary.title,
            url: summary.url,
            loading: summary.loading,
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
        if (tool !== "browser_list_tabs")
          this.#latest.set(session.threadId, target.summary.id);
      }
    }
    this.#notify(session.threadId);
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

  close(): void {
    this.#closed = true;
    this.#sessions.clear();
    this.#latest.clear();
    for (const observer of this.#observers) this.#render(observer);
    this.#observers.clear();
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
    const selectedId =
      observer.request.targetId ?? this.#latest.get(observer.request.threadId);
    const selected =
      targets.find(({ target }) => target.summary.id === selectedId) ??
      (observer.request.targetId === undefined ? targets.at(-1) : undefined);
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
          send,
        );
        if (!this.#observers.has(observer)) this.#stop(observer);
      } catch {
        send({
          type: "status",
          status: "unavailable",
          message:
            "This browser page is no longer available. Ask the Agent to inspect it again.",
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
      .catch(() =>
        send({
          type: "status",
          status: "unavailable",
          message:
            "The last screenshot is no longer available. Ask the Agent to inspect this page again.",
        }),
      );
  }
}
