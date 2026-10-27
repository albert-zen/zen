import { randomUUID } from "node:crypto";

import type {
  ComputerActionPointer,
  ComputerLiveObservationEvent,
  ComputerLiveObservationListener,
  ComputerTarget,
  ZenXComputerBackend,
} from "./computer-provider.js";

export interface ComputerThreadTarget {
  id: string;
  invocationId: string;
  target: ComputerTarget;
  mode: "live" | "snapshot";
  pointer?: ComputerActionPointer;
  activity?: {
    kind: "background-window" | "foreground" | "waiting-human" | "unknown";
    count: number;
  };
}
export interface ComputerThreadRequest {
  threadId: string;
  targetId?: string;
  frames: boolean;
}
export type ComputerThreadEvent =
  | ComputerLiveObservationEvent
  | {
      type: "targets";
      targets: ComputerThreadTarget[];
      selectedId?: string;
    };
export type ComputerThreadListener = (event: ComputerThreadEvent) => void;

interface Observer {
  request: ComputerThreadRequest;
  listener: ComputerThreadListener;
  generation: number;
  stop?: () => void;
  activeTargetId?: string;
}

const POINTER_TTL_MS = 3_000;

/** Host-local Computer view projection; never durable Thread state. */
export class ComputerThreadObservation {
  readonly #backend: ZenXComputerBackend;
  readonly #targets = new Map<string, ComputerThreadTarget[]>();
  readonly #activities = new Map<
    string,
    Map<string, NonNullable<ComputerThreadTarget["activity"]>["kind"]>
  >();
  readonly #observers = new Set<Observer>();
  #closed = false;
  readonly #freshFrames = new Set<string>();

  constructor(
    backend: ZenXComputerBackend,
    readonly canCapture: () => boolean = () => true,
  ) {
    this.#backend = backend;
  }

  /** Retire pixels and pointers independently from an admitted native action's lifetime. */
  invalidateFrames(): void {
    this.#freshFrames.clear();
    for (const targets of this.#targets.values())
      for (const target of targets) delete target.pointer;
    for (const observer of this.#observers) this.#render(observer);
  }

  /** A disposable Host observation of an admitted call, not a durable run state. */
  startActivity(
    threadId: string,
    invocationId: string,
    target: ComputerTarget,
    kind: NonNullable<ComputerThreadTarget["activity"]>["kind"],
  ): () => void {
    if (this.#closed || !target.windowTitle) return () => {};
    const key = JSON.stringify([threadId, targetKey(target)]);
    const calls = this.#activities.get(key) ?? new Map();
    calls.set(invocationId, kind);
    this.#activities.set(key, calls);
    this.#publish(threadId, invocationId, target, undefined, false);
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      const current = this.#activities.get(key);
      if (current?.get(invocationId) !== kind) return;
      current.delete(invocationId);
      if (current.size === 0) this.#activities.delete(key);
      const targets = this.#targets.get(threadId);
      const found = targets?.find(
        (item) => targetKey(item.target) === targetKey(target),
      );
      if (found) {
        const activity = this.#activity(threadId, target);
        if (activity) found.activity = activity;
        else delete found.activity;
        this.#notify(threadId);
      }
    };
  }

  #activity(
    threadId: string,
    target: ComputerTarget,
  ): ComputerThreadTarget["activity"] {
    const calls = this.#activities.get(
      JSON.stringify([threadId, targetKey(target)]),
    );
    if (!calls?.size) return undefined;
    const kinds = [...calls.values()];
    const kind = kinds.includes("foreground")
      ? "foreground"
      : kinds.includes("waiting-human")
        ? "waiting-human"
        : kinds.includes("background-window")
          ? "background-window"
          : "unknown";
    return { kind, count: calls.size };
  }

  publish(
    threadId: string,
    invocationId: string,
    target: ComputerTarget,
    pointer?: ComputerActionPointer,
  ): void {
    this.#publish(threadId, invocationId, target, pointer, true);
  }

  #publish(
    threadId: string,
    invocationId: string,
    target: ComputerTarget,
    pointer: ComputerActionPointer | undefined,
    freshObservation: boolean,
  ): void {
    if (this.#closed || !target.windowTitle) return;
    const key = targetKey(target);
    const prior = this.#targets.get(threadId) ?? [];
    const existing = prior.find(
      (candidate) => targetKey(candidate.target) === key,
    );
    const next: ComputerThreadTarget = {
      id: existing?.id ?? randomUUID(),
      invocationId,
      target: { ...target },
      mode: this.#backend.observeWindow ? "live" : "snapshot",
      ...(this.#activity(threadId, target)
        ? { activity: this.#activity(threadId, target) }
        : {}),
      ...(pointer && validPointer(pointer) ? { pointer: { ...pointer } } : {}),
    };
    const targets = [
      ...prior.filter((candidate) => targetKey(candidate.target) !== key),
      next,
    ].slice(-8);
    for (const old of prior)
      if (!targets.some((target) => target.id === old.id))
        this.#freshFrames.delete(old.id);
    if (freshObservation) this.#freshFrames.add(next.id);
    this.#targets.set(threadId, targets);
    this.#notify(threadId);
  }

  observe(
    request: ComputerThreadRequest,
    listener: ComputerThreadListener,
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
    this.#targets.clear();
    this.#activities.clear();
    this.#freshFrames.clear();
    for (const observer of this.#observers) this.#stop(observer);
    this.#observers.clear();
  }

  #notify(threadId: string): void {
    for (const observer of this.#observers) {
      if (observer.request.threadId === threadId) this.#render(observer);
    }
  }

  #stop(observer: Observer): void {
    const stop = observer.stop;
    observer.stop = undefined;
    observer.activeTargetId = undefined;
    try {
      stop?.();
    } catch {
      // Observation cleanup must not fail a Computer action.
    }
  }

  #render(observer: Observer): void {
    const targets = (this.#targets.get(observer.request.threadId) ?? []).map(
      (target) => ({
        ...target,
        ...(validPointer(target.pointer) ? {} : { pointer: undefined }),
      }),
    );
    const selected =
      targets.find((target) => target.id === observer.request.targetId) ??
      (observer.request.targetId === undefined ? targets.at(-1) : undefined);
    const captureAllowed =
      this.canCapture() && !!selected && this.#freshFrames.has(selected.id);
    const continuing =
      observer.stop !== undefined &&
      observer.activeTargetId === selected?.id &&
      observer.request.frames &&
      !this.#closed &&
      captureAllowed;
    if (!continuing) {
      observer.generation += 1;
      this.#stop(observer);
    }
    const generation = observer.generation;
    const send: ComputerThreadListener = (event) => {
      if (observer.generation !== generation || !this.#observers.has(observer))
        return;
      if (
        event.type === "status" &&
        (event.status === "unavailable" || event.status === "failed")
      ) {
        // A terminal capture can only resume after an explicit observation/action.
        observer.generation += 1;
        this.#stop(observer);
      }
      try {
        observer.listener(event);
      } catch {
        this.#observers.delete(observer);
        observer.generation += 1;
        this.#stop(observer);
      }
    };
    send({
      type: "targets",
      targets,
      ...(selected ? { selectedId: selected.id } : {}),
    });
    if (continuing) return;
    if (!selected || !observer.request.frames || this.#closed) {
      send({
        type: "status",
        status: this.#closed ? "unavailable" : "idle",
        message: this.#closed
          ? "Computer observation is unavailable."
          : "No Computer window is selected for this thread.",
      });
      return;
    }
    if (!captureAllowed) {
      send({
        type: "status",
        status: "unavailable",
        message:
          "Window view requires an active desktop session and fresh observation. Targeted accessibility may remain available.",
      });
      return;
    }
    if (!this.#backend.observeWindow) {
      send({
        type: "status",
        status: "idle",
        message: "This Computer provider does not support a live window view.",
      });
      return;
    }
    const stop = this.#backend.observeWindow(selected.target, send);
    // Subscription creation may synchronously terminate or replace this generation.
    if (observer.generation !== generation || !this.#observers.has(observer)) {
      try {
        stop();
      } catch {
        // Observation cleanup must not fail a Computer action.
      }
      return;
    }
    observer.stop = stop;
    observer.activeTargetId = selected.id;
  }
}

function validPointer(pointer: ComputerActionPointer | undefined): boolean {
  if (!pointer) return false;
  const timestamp = Date.parse(pointer.capturedAt);
  return (
    Number.isFinite(timestamp) &&
    timestamp <= Date.now() &&
    Date.now() - timestamp <= POINTER_TTL_MS &&
    (pointer.action === "press" || pointer.action === "set_value") &&
    Number.isFinite(pointer.x) &&
    pointer.x >= 0 &&
    pointer.x <= 1 &&
    Number.isFinite(pointer.y) &&
    pointer.y >= 0 &&
    pointer.y <= 1 &&
    Number.isFinite(pointer.windowWidth) &&
    pointer.windowWidth > 0 &&
    Number.isFinite(pointer.windowHeight) &&
    pointer.windowHeight > 0 &&
    (pointer.windowId === undefined ||
      (Number.isSafeInteger(pointer.windowId) && pointer.windowId > 0))
  );
}

function targetKey(target: ComputerTarget): string {
  return JSON.stringify([
    target.pid ?? null,
    target.applicationId ?? null,
    target.bundleId ?? null,
    target.windowTitle ?? null,
  ]);
}
