import type {
  ThreadTitleInference,
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "./thread-title-types.js";
import { ZenXThreadTitleStore } from "./thread-title-store.js";

const MAX_TITLE_LENGTH = 64;
const identifierNoise =
  /\b(?:zenx-wakeup:[^\s]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/giu;

export interface ZenXThreadTitleObservationFence {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  track(operation: Promise<void>): void;
}

export class ZenXThreadTitleCoordinator {
  readonly #store: ZenXThreadTitleStore;
  readonly #inference: ThreadTitleInference;
  readonly #titleModel: () => string;
  readonly #setNativeName: (threadId: string, title: string) => Promise<void>;
  readonly #listeners = new Set<(snapshot: ThreadTitleSnapshot) => void>();
  readonly #expectedNativeMirrors = new Map<string, string[]>();
  readonly #nativeAuthorityVersions = new Map<string, number>();
  readonly #generationOwners = new Map<
    string,
    {
      version: number;
      fence: ZenXThreadTitleObservationFence | undefined;
    }
  >();
  #snapshot: ThreadTitleSnapshot = {};
  #mutation = Promise.resolve();
  #initializationError: Error | undefined;

  constructor(options: {
    store: ZenXThreadTitleStore;
    inference: ThreadTitleInference;
    titleModel(): string;
    setNativeName(threadId: string, title: string): Promise<void>;
  }) {
    this.#store = options.store;
    this.#inference = options.inference;
    this.#titleModel = options.titleModel;
    this.#setNativeName = options.setNativeName;
  }

  async initialize(): Promise<void> {
    try {
      const restored = await this.#store.read();
      let changed = false;
      for (const [threadId, projection] of Object.entries(restored)) {
        if (projection.status !== "generating") continue;
        restored[threadId] = {
          ...projection,
          status: "failed",
          version: projection.version + 1,
          error:
            "Title generation stopped when ZenX restarted. Retry explicitly.",
        };
        changed = true;
      }
      this.#snapshot = restored;
      if (changed) await this.#store.write(restored);
    } catch (error) {
      this.#initializationError = asError(error);
      console.error(
        `ZenX thread titles are unavailable: ${this.#initializationError.message}`,
      );
    }
  }

  snapshot(): ThreadTitleSnapshot {
    this.#assertAvailable();
    return structuredClone(this.#snapshot);
  }

  onChange(listener: (snapshot: ThreadTitleSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async observe(
    threadId: string,
    input: string,
    fence?: ZenXThreadTitleObservationFence,
  ): Promise<ThreadTitleProjection | undefined> {
    this.#assertAvailable();
    if (!observationIsCurrent(fence)) return undefined;
    const source = meaningfulTitleSource(input);
    if (source === null) return undefined;
    const result = await this.#serial(async () => {
      if (!observationIsCurrent(fence)) return undefined;
      const existing = this.#snapshot[threadId];
      if (existing !== undefined) {
        if (
          fence === undefined ||
          !["provisional", "generating"].includes(existing.status) ||
          this.#hasCurrentGenerationOwner(existing)
        ) {
          return { projection: existing, created: false };
        }
        const generating = {
          ...existing,
          status: "generating" as const,
          version:
            existing.status === "provisional"
              ? existing.version + 1
              : existing.version,
        };
        if (
          existing.status === "provisional" &&
          !(await this.#commit(generating, fence))
        ) {
          return { projection: existing, created: false };
        }
        return { projection: generating, created: true };
      }
      const provisional: ThreadTitleProjection = {
        threadId,
        title: normalizeThreadTitle(source),
        status: "provisional",
        version: 1,
        source,
      };
      if (!(await this.#commit(provisional, fence))) return undefined;
      if (!observationIsCurrent(fence))
        return { projection: provisional, created: false };
      await this.#mirror(threadId, provisional.title, fence);
      if (!observationIsCurrent(fence))
        return { projection: provisional, created: false };
      const generating = {
        ...provisional,
        status: "generating" as const,
        version: 2,
      };
      if (!(await this.#commit(generating, fence)))
        return { projection: provisional, created: false };
      return { projection: generating, created: true };
    });
    if (result === undefined) return undefined;
    if (result.created && observationIsCurrent(fence))
      this.#startGeneration(result.projection, fence);
    return result.projection;
  }

  async rename(
    threadId: string,
    title: string,
  ): Promise<ThreadTitleProjection> {
    this.#assertAvailable();
    const normalized = normalizeManualTitle(title);
    return await this.#serial(async () => {
      const current = this.#snapshot[threadId];
      const projection: ThreadTitleProjection = {
        threadId,
        title: normalized,
        status: "manual",
        version: (current?.version ?? 0) + 1,
        source: current?.source ?? normalized,
      };
      await this.#commit(projection);
      await this.#mirror(threadId, normalized);
      return projection;
    });
  }

  async synchronizeNativeName(
    threadId: string,
    title: string,
  ): Promise<ThreadTitleProjection> {
    this.#assertAvailable();
    const normalized = normalizeManualTitle(title);
    if (this.#consumeExpectedNativeMirror(threadId, normalized)) {
      const current = this.#snapshot[threadId];
      if (current !== undefined) return current;
    }
    this.#recordNativeAuthority(threadId);
    return await this.#serial(async () => {
      const current = this.#snapshot[threadId];
      if (current?.status === "manual" && current.title === normalized) {
        return current;
      }
      const projection: ThreadTitleProjection = {
        threadId,
        title: normalized,
        status: "manual",
        version: (current?.version ?? 0) + 1,
        source: current?.source ?? normalized,
      };
      await this.#commit(projection);
      await this.#mirror(threadId, normalized);
      return projection;
    });
  }

  async retry(threadId: string): Promise<ThreadTitleProjection> {
    this.#assertAvailable();
    const generating = await this.#serial(async () => {
      const current = this.#snapshot[threadId];
      if (current === undefined)
        throw new Error("Thread has no title input to retry");
      if (current.status !== "failed")
        throw new Error("Only failed title generation can be retried");
      const next: ThreadTitleProjection = {
        ...current,
        status: "generating",
        version: current.version + 1,
      };
      delete next.error;
      await this.#commit(next);
      return next;
    });
    this.#startGeneration(generating);
    return generating;
  }

  async #generate(
    started: ThreadTitleProjection,
    fence?: ZenXThreadTitleObservationFence,
  ): Promise<void> {
    try {
      if (!observationIsCurrent(fence)) return;
      const generated = normalizeGeneratedTitle(
        await this.#inference.generate(
          started.source,
          this.#titleModel(),
          fence?.signal ?? new AbortController().signal,
        ),
      );
      if (!observationIsCurrent(fence)) return;
      await this.#serial(async () => {
        if (!observationIsCurrent(fence)) return;
        const current = this.#snapshot[started.threadId];
        if (
          current?.status !== "generating" ||
          current.version !== started.version
        )
          return;
        const projection: ThreadTitleProjection = {
          ...current,
          title: generated,
          status: "generated",
          version: current.version + 1,
        };
        const nativeAuthorityVersion = this.#nativeAuthorityVersion(
          started.threadId,
        );
        if (!(await this.#commit(projection, fence))) return;
        if (
          observationIsCurrent(fence) &&
          this.#nativeAuthorityVersion(started.threadId) ===
            nativeAuthorityVersion
        ) {
          await this.#mirror(started.threadId, generated, fence);
        }
      });
    } catch (error) {
      if (!observationIsCurrent(fence)) return;
      await this.#serial(async () => {
        if (!observationIsCurrent(fence)) return;
        const current = this.#snapshot[started.threadId];
        if (
          current?.status !== "generating" ||
          current.version !== started.version
        )
          return;
        await this.#commit(
          {
            ...current,
            status: "failed",
            version: current.version + 1,
            error: describeError(error),
          },
          fence,
        );
      });
    }
  }

  async #commit(
    projection: ThreadTitleProjection,
    fence?: ZenXThreadTitleObservationFence,
  ): Promise<boolean> {
    if (!observationIsCurrent(fence)) return false;
    const next = { ...this.#snapshot, [projection.threadId]: projection };
    await this.#store.write(next);
    if (!observationIsCurrent(fence)) return false;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener(this.snapshot());
    return true;
  }

  async #mirror(
    threadId: string,
    title: string,
    fence?: ZenXThreadTitleObservationFence,
  ): Promise<void> {
    if (!observationIsCurrent(fence)) return;
    const expected = this.#expectedNativeMirrors.get(threadId) ?? [];
    expected.push(title);
    this.#expectedNativeMirrors.set(threadId, expected);
    try {
      await this.#setNativeName(threadId, title);
    } catch (error) {
      this.#removeExpectedNativeMirror(threadId, title);
      console.warn(
        `Could not mirror ZenX thread title: ${describeError(error)}`,
      );
    }
  }

  #consumeExpectedNativeMirror(threadId: string, title: string): boolean {
    const expected = this.#expectedNativeMirrors.get(threadId);
    const index = expected?.indexOf(title) ?? -1;
    if (expected === undefined || index < 0) return false;
    expected.splice(index, 1);
    if (expected.length === 0) this.#expectedNativeMirrors.delete(threadId);
    return true;
  }

  #removeExpectedNativeMirror(threadId: string, title: string): void {
    this.#consumeExpectedNativeMirror(threadId, title);
  }

  #recordNativeAuthority(threadId: string): void {
    this.#nativeAuthorityVersions.set(
      threadId,
      this.#nativeAuthorityVersion(threadId) + 1,
    );
  }

  #nativeAuthorityVersion(threadId: string): number {
    return this.#nativeAuthorityVersions.get(threadId) ?? 0;
  }

  #startGeneration(
    projection: ThreadTitleProjection,
    fence?: ZenXThreadTitleObservationFence,
  ): void {
    if (!observationIsCurrent(fence)) return;
    const owner = { version: projection.version, fence };
    this.#generationOwners.set(projection.threadId, owner);
    const operation = this.#generate(projection, fence).finally(() => {
      if (this.#generationOwners.get(projection.threadId) === owner)
        this.#generationOwners.delete(projection.threadId);
    });
    fence?.track(operation);
    void operation.catch((error: unknown) => {
      console.error(
        `Could not persist title generation result: ${asError(error).message}`,
      );
    });
  }

  #hasCurrentGenerationOwner(projection: ThreadTitleProjection): boolean {
    const owner = this.#generationOwners.get(projection.threadId);
    return (
      owner?.version === projection.version && observationIsCurrent(owner.fence)
    );
  }

  #assertAvailable(): void {
    if (this.#initializationError !== undefined) {
      throw new Error(
        `ZenX thread titles are unavailable: ${this.#initializationError.message}`,
      );
    }
  }

  async #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

export function meaningfulTitleSource(input: string): string | null {
  const value = input
    .replace(/^\s*\[ZenX trigger wakeup\][\s\S]*?\n\s*Task:\s*/iu, "")
    .replace(/^\s*(?:Trigger ID|Wakeup ID|Client ID|Thread ID):.*$/gimu, "")
    .replace(/^\s*Source (?:Thread|Turn|Room|Room message):.*$/gimu, "")
    .replace(identifierNoise, " ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return value.length === 0 ? null : value.slice(0, 2_000);
}

export function normalizeThreadTitle(input: string): string {
  const clean = input
    .replace(/^\s{0,3}#{1,6}\s+/u, "")
    .replace(/[*_~`>[\]{}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(clean);
  return chars.length <= MAX_TITLE_LENGTH
    ? clean
    : `${chars
        .slice(0, MAX_TITLE_LENGTH - 1)
        .join("")
        .trimEnd()}…`;
}

function normalizeGeneratedTitle(input: string): string {
  const title = normalizeThreadTitle(
    (input.split(/\r?\n/u)[0] ?? "")
      .replace(identifierNoise, " ")
      .replace(
        /\b(?:Trigger|Wakeup|Source (?:Thread|Turn|Room)) ID:\s*\S+/giu,
        " ",
      ),
  ).replace(/^["']|["']$/gu, "");
  if (title.length === 0)
    throw new Error("Title model returned an empty title");
  return title;
}

function normalizeManualTitle(input: string): string {
  const title = input.replace(/\s+/gu, " ").trim();
  if (title.length === 0) throw new Error("Thread title must not be empty");
  if (Array.from(title).length > 200)
    throw new Error("Thread title must not exceed 200 characters");
  return title;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function observationIsCurrent(
  fence?: ZenXThreadTitleObservationFence,
): boolean {
  return fence === undefined || (!fence.signal.aborted && fence.isCurrent());
}
