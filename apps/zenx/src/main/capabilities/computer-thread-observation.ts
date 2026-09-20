import { randomUUID } from "node:crypto";

import type {
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
}

/** Host-local Computer view projection; never durable Thread state. */
export class ComputerThreadObservation {
  readonly #backend: ZenXComputerBackend;
  readonly #targets = new Map<string, ComputerThreadTarget[]>();
  readonly #observers = new Set<Observer>();
  #closed = false;

  constructor(backend: ZenXComputerBackend) {
    this.#backend = backend;
  }

  publish(
    threadId: string,
    invocationId: string,
    target: ComputerTarget,
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
    };
    const targets = [
      ...prior.filter((candidate) => targetKey(candidate.target) !== key),
      next,
    ].slice(-8);
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
    try {
      stop?.();
    } catch {
      // Observation cleanup must not fail a Computer action.
    }
  }

  #render(observer: Observer): void {
    const generation = ++observer.generation;
    this.#stop(observer);
    const send: ComputerThreadListener = (event) => {
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
    const targets = this.#targets.get(observer.request.threadId) ?? [];
    const selected =
      targets.find((target) => target.id === observer.request.targetId) ??
      (observer.request.targetId === undefined ? targets.at(-1) : undefined);
    send({
      type: "targets",
      targets,
      ...(selected ? { selectedId: selected.id } : {}),
    });
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
    if (!this.#backend.observeWindow) {
      send({
        type: "status",
        status: "idle",
        message: "This Computer provider does not support a live window view.",
      });
      return;
    }
    observer.stop = this.#backend.observeWindow(selected.target, send);
    if (!this.#observers.has(observer)) this.#stop(observer);
  }
}

function targetKey(target: ComputerTarget): string {
  return JSON.stringify([
    target.pid ?? null,
    target.applicationId ?? null,
    target.bundleId ?? null,
    target.windowTitle ?? null,
  ]);
}
