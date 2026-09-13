import { randomUUID } from "node:crypto";

import type {
  AppServerEvent,
  ThreadSnapshot,
  ZenAppServer,
} from "../../app-server.js";

export interface NativeProjectedThreadEvent {
  processEpoch: string;
  threadId: string;
  watermark: number;
  event: AppServerEvent;
}

export interface NativeThreadRecoverySnapshot {
  processEpoch: string;
  threadId: string;
  watermark: number;
  thread: ThreadSnapshot;
  /** Events observed in this Host epoch, used to complete the live projection. */
  events: NativeProjectedThreadEvent[];
}

export type NativeProjectionEvent =
  | { type: "thread_event"; event: NativeProjectedThreadEvent }
  | { type: "model_catalog_updated"; processEpoch: string; revision: number };

interface ThreadProjectionState {
  watermark: number;
  events: NativeProjectedThreadEvent[];
  readonly inFlightResumes: Map<symbol, number>;
  pendingCompactionBoundary: number | undefined;
  compacting: boolean;
}

/**
 * Owns the Host-local ordering metadata used by the native ZAS recovery wire.
 * Its event history is deliberately transient: canonical Items remain the
 * durable Thread authority and a new Host process starts a new epoch.
 */
export class NativeRecoveryProjection {
  readonly processEpoch: string;
  readonly #appServer: ZenAppServer;
  readonly #threads = new Map<string, ThreadProjectionState>();
  readonly #listeners = new Set<(event: NativeProjectionEvent) => void>();
  readonly #unsubscribe: () => void;

  constructor(
    appServer: ZenAppServer,
    options: { processEpoch?: string } = {},
  ) {
    this.#appServer = appServer;
    this.processEpoch = options.processEpoch ?? randomUUID();
    this.#unsubscribe = appServer.subscribe((event) => this.#record(event));
  }

  subscribe(listener: (event: NativeProjectionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async resume(threadId: string): Promise<NativeThreadRecoverySnapshot> {
    /*
     * The projection subscription is installed before this read. Events that
     * overlap the asynchronous journal/metadata snapshot are retained below;
     * consumers reconcile them by stable Item/Turn ids. Capturing the state
     * after readThread resolves is the single native resume boundary.
     */
    const state = this.#state(threadId);
    const resume = Symbol("native-resume");
    const boundary = state.watermark;
    state.inFlightResumes.set(resume, boundary);
    try {
      const thread = await this.#appServer.readThread(threadId);
      const watermark = state.watermark;
      const events = structuredClone(
        state.events.filter(
          (projected) =>
            projected.watermark > boundary ||
            !eventRepresentedInSnapshot(projected.event, thread),
        ),
      );
      state.inFlightResumes.delete(resume);
      this.#prune(state, thread, watermark);
      return {
        processEpoch: this.processEpoch,
        threadId,
        watermark,
        thread,
        events,
      };
    } catch (error) {
      state.inFlightResumes.delete(resume);
      throw error;
    }
  }

  close(): void {
    this.#unsubscribe();
    this.#listeners.clear();
    this.#threads.clear();
  }

  #record(event: AppServerEvent): void {
    if (event.type === "model_catalog_updated") {
      const projected: NativeProjectionEvent = {
        type: "model_catalog_updated",
        processEpoch: this.processEpoch,
        revision: event.revision,
      };
      for (const listener of this.#listeners) listener(projected);
      return;
    }
    const threadId = eventThreadId(event);
    const state = this.#state(threadId);
    const projected: NativeProjectedThreadEvent = {
      processEpoch: this.processEpoch,
      threadId,
      watermark: state.watermark + 1,
      event: structuredClone(event),
    };
    state.watermark = projected.watermark;
    state.events.push(projected);
    for (const listener of this.#listeners) {
      listener({ type: "thread_event", event: projected });
    }
    if (eventEstablishesCanonicalBoundary(event)) {
      this.#scheduleCompaction(threadId, state, projected.watermark);
    }
  }

  #state(threadId: string): ThreadProjectionState {
    let state = this.#threads.get(threadId);
    if (state === undefined) {
      state = {
        watermark: 0,
        events: [],
        inFlightResumes: new Map(),
        pendingCompactionBoundary: undefined,
        compacting: false,
      };
      this.#threads.set(threadId, state);
    }
    return state;
  }

  #scheduleCompaction(
    threadId: string,
    state: ThreadProjectionState,
    boundary: number,
  ): void {
    state.pendingCompactionBoundary = Math.max(
      state.pendingCompactionBoundary ?? 0,
      boundary,
    );
    if (state.compacting) return;
    state.compacting = true;
    void this.#compact(threadId, state);
  }

  async #compact(
    threadId: string,
    state: ThreadProjectionState,
  ): Promise<void> {
    try {
      while (state.pendingCompactionBoundary !== undefined) {
        const boundary = state.pendingCompactionBoundary;
        state.pendingCompactionBoundary = undefined;
        try {
          const thread = await this.#appServer.readThread(threadId);
          if (this.#threads.get(threadId) !== state) return;
          this.#prune(state, thread, boundary);
        } catch {
          // A later canonical event or resume retries pruning. Keeping the
          // transient tail is safer than losing an unreconciled projection.
        }
      }
    } finally {
      state.compacting = false;
      if (
        this.#threads.get(threadId) === state &&
        state.pendingCompactionBoundary !== undefined
      ) {
        this.#scheduleCompaction(
          threadId,
          state,
          state.pendingCompactionBoundary,
        );
      }
    }
  }

  #prune(
    state: ThreadProjectionState,
    thread: ThreadSnapshot,
    boundary: number,
  ): void {
    let oldestResumeBoundary = Number.POSITIVE_INFINITY;
    for (const resumeBoundary of state.inFlightResumes.values()) {
      oldestResumeBoundary = Math.min(oldestResumeBoundary, resumeBoundary);
    }
    state.events = state.events.filter(
      (projected) =>
        projected.watermark > boundary ||
        projected.watermark > oldestResumeBoundary ||
        !eventRepresentedInSnapshot(projected.event, thread),
    );
  }
}

function eventEstablishesCanonicalBoundary(event: AppServerEvent): boolean {
  switch (event.type) {
    case "thread_started":
    case "thread_archived_updated":
    case "thread_name_updated":
    case "thread_settings_updated":
    case "turn_started":
    case "item_completed":
    case "turn_completed":
      return true;
    case "item_started":
    case "item_delta":
    case "reasoning_summary_delta":
    case "reasoning_content_delta":
    case "token_usage":
    case "model_catalog_updated":
      return false;
  }
}

function eventThreadId(
  event: Exclude<AppServerEvent, { type: "model_catalog_updated" }>,
): string {
  return event.type === "item_completed" ? event.item.threadId : event.threadId;
}

function eventRepresentedInSnapshot(
  event: AppServerEvent,
  snapshot: ThreadSnapshot,
): boolean {
  switch (event.type) {
    case "model_catalog_updated":
      return true;
    case "thread_started":
      return snapshot.id === event.threadId;
    case "thread_archived_updated":
      return snapshot.archived === event.archived;
    case "thread_name_updated":
      return snapshot.name === event.name;
    case "thread_settings_updated":
      return (
        snapshot.providerProfileId === event.settings.providerProfileId &&
        snapshot.modelId === event.settings.modelId &&
        snapshot.reasoningEffort === event.settings.reasoningEffort &&
        snapshot.sandbox === event.settings.sandbox &&
        snapshot.approvalPolicy === event.settings.approvalPolicy
      );
    case "item_completed":
      return snapshot.items.some((item) => item.id === event.item.id);
    case "turn_started":
      return snapshot.items.some(
        (item) => item.type === "turn_started" && item.turnId === event.turnId,
      );
    case "turn_completed":
      return snapshot.items.some(
        (item) =>
          item.turnId === event.turnId &&
          (item.type === "turn_completed" || item.type === "turn_aborted"),
      );
    case "item_started":
    case "item_delta":
    case "reasoning_summary_delta":
    case "reasoning_content_delta":
      return snapshot.items.some((item) => item.id === event.itemId);
    case "token_usage":
      return true;
  }
}
