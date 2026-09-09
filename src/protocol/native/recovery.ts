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
    const thread = await this.#appServer.readThread(threadId);
    const state = this.#threads.get(threadId) ?? {
      watermark: 0,
      events: [],
    };
    const events = structuredClone(state.events);
    state.events = state.events.filter(
      (projected) => !eventRepresentedInSnapshot(projected.event, thread),
    );
    return {
      processEpoch: this.processEpoch,
      threadId,
      watermark: state.watermark,
      thread,
      events,
    };
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
    const state = this.#threads.get(threadId) ?? {
      watermark: 0,
      events: [],
    };
    const projected: NativeProjectedThreadEvent = {
      processEpoch: this.processEpoch,
      threadId,
      watermark: state.watermark + 1,
      event: structuredClone(event),
    };
    state.watermark = projected.watermark;
    state.events.push(projected);
    this.#threads.set(threadId, state);
    for (const listener of this.#listeners) {
      listener({ type: "thread_event", event: projected });
    }
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
