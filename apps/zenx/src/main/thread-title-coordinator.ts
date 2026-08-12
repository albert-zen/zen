import {
  ZenXThreadTitleOwnershipTransaction,
  type ZenXThreadTitleOwnershipTransactionOptions,
} from "./thread-title-ownership-transaction.js";
import type { ZenXThreadTitleOwnershipStore } from "./thread-title-store.js";
import type {
  ThreadTitleInference,
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "./thread-title-types.js";

const MAX_TITLE_LENGTH = 64;
const MAX_NATIVE_MIRROR_STATE = 64;
const nativeMirrorQueues = new WeakMap<object, NativeMirrorQueue>();
const identifierNoise =
  /\b(?:zenx-wakeup:[^\s]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/giu;

interface GenerationOwner {
  readonly version: number;
  readonly owner: ZenXThreadTitleOwnershipTransaction;
}

export class ZenXThreadTitleCoordinator {
  readonly #store: ZenXThreadTitleOwnershipStore;
  readonly #inference: ThreadTitleInference;
  readonly #titleModel: () => string;
  readonly #listeners = new Set<(snapshot: ThreadTitleSnapshot) => void>();
  readonly #ownershipOptions: ZenXThreadTitleOwnershipTransactionOptions;
  readonly #nativeMirrors: NativeMirrorQueue;
  readonly #setNativeName: (threadId: string, title: string) => Promise<void>;
  readonly #generationOwners = new Map<string, GenerationOwner>();
  #owner: ZenXThreadTitleOwnershipTransaction;
  #snapshot: ThreadTitleSnapshot = {};
  #mutation = Promise.resolve();
  #initializationError: Error | undefined;
  #initialized = false;

  constructor(options: {
    store: ZenXThreadTitleOwnershipStore;
    inference: ThreadTitleInference;
    titleModel(): string;
    setNativeName(threadId: string, title: string): Promise<void>;
    ownership?: ZenXThreadTitleOwnershipTransactionOptions;
  }) {
    this.#store = options.store;
    this.#inference = options.inference;
    this.#titleModel = options.titleModel;
    this.#ownershipOptions = options.ownership ?? {};
    this.#setNativeName = options.setNativeName;
    this.#owner = new ZenXThreadTitleOwnershipTransaction(
      this.#ownershipOptions,
    );
    this.#nativeMirrors = nativeMirrorQueue(options.store.ownershipDomain);
  }

  async initialize(): Promise<void> {
    await this.#initializeAndActivateOwner(this.#owner);
  }

  async restart(): Promise<void> {
    await this.stop();
    this.#owner = new ZenXThreadTitleOwnershipTransaction(
      this.#ownershipOptions,
    );
    this.#mutation = Promise.resolve();
    this.#initializationError = undefined;
    this.#initialized = false;
    await this.#initializeAndActivateOwner(this.#owner);
  }

  async stop(): Promise<void> {
    try {
      await this.#owner.retire();
    } catch (error) {
      this.#initializationError = asError(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.stop();
    } finally {
      this.#listeners.clear();
    }
  }

  createOwnershipTransaction(
    options: ZenXThreadTitleOwnershipTransactionOptions = {},
  ): ZenXThreadTitleOwnershipTransaction {
    this.#assertAvailable();
    return this.#owner.fork(options);
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
    ownership?: ZenXThreadTitleOwnershipTransaction,
  ): Promise<ThreadTitleProjection | undefined> {
    const owner = this.#operationOwner(ownership);
    const source = meaningfulTitleSource(input);
    if (source === null) return undefined;
    const result = await this.#serial(owner, async () => {
      const existing = this.#snapshot[threadId];
      if (existing !== undefined) {
        if (
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
          !(await this.#commit(generating, owner))
        ) {
          return undefined;
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
      if (!(await this.#commit(provisional, owner))) return undefined;
      const generating = {
        ...provisional,
        status: "generating" as const,
        version: 2,
      };
      if (!(await this.#commit(generating, owner))) return undefined;
      return { projection: generating, created: true };
    });
    if (result?.created === true)
      this.#startGeneration(result.projection, owner);
    return result?.projection;
  }

  async rename(
    threadId: string,
    title: string,
    ownership?: ZenXThreadTitleOwnershipTransaction,
  ): Promise<ThreadTitleProjection> {
    const owner = this.#operationOwner(ownership);
    const normalized = normalizeManualTitle(title);
    const projection = await this.#serial(owner, async () => {
      const current = this.#snapshot[threadId];
      const next: ThreadTitleProjection = {
        threadId,
        title: normalized,
        status: "manual",
        version: (current?.version ?? 0) + 1,
        source: current?.source ?? normalized,
      };
      if (!(await this.#commit(next, owner)))
        throw new Error("Title ownership changed during rename");
      return next;
    });
    this.#nativeMirrors.enqueue(threadId, normalized, owner);
    return projection;
  }

  async synchronizeNativeName(
    threadId: string,
    title: string,
  ): Promise<ThreadTitleProjection> {
    const owner = this.#operationOwner();
    const normalized = normalizeManualTitle(title);
    // App Server exposes no dispatch correlation token. Title equality is not
    // provenance, so every notification is conservatively authoritative. A
    // successful authority commit cancels any older queued repair before the
    // current active dispatch is reconciled. A same-title echo is still
    // authoritative but cannot enqueue a recursive repair.
    const nativeAuthorityVersion = this.#nativeAuthorityVersion(threadId) + 1;
    this.#nativeAuthorityVersions.set(threadId, nativeAuthorityVersion);
    const projection = await this.#serial(owner, async () => {
      const current = this.#snapshot[threadId];
      const projection: ThreadTitleProjection = {
        threadId,
        title: normalized,
        status: "manual",
        version: (current?.version ?? 0) + 1,
        source: current?.source ?? normalized,
      };
      if (!(await this.#commit(projection, owner)))
        throw new Error("Title ownership changed during native rename");
      return projection;
    });
    this.#nativeMirrors.reconcileAuthoritative(threadId, normalized, owner);
    return projection;
  }

  readonly #nativeAuthorityVersions = new Map<string, number>();

  async retry(threadId: string): Promise<ThreadTitleProjection> {
    const owner = this.#operationOwner();
    const generating = await this.#serial(owner, async () => {
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
      if (!(await this.#commit(next, owner)))
        throw new Error("Title ownership changed during retry");
      return next;
    });
    this.#startGeneration(generating, owner);
    return generating;
  }

  async #initializeOwner(
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<void> {
    try {
      const restored = await this.#store.claim(owner);
      if (!owner.isCurrent()) return;
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
      if (changed && !(await this.#store.commit(restored, owner))) return;
      if (!owner.isCurrent()) return;
      this.#snapshot = restored;
      this.#initialized = true;
    } catch (error) {
      this.#initializationError = asError(error);
      console.error(
        `ZenX thread titles are unavailable: ${this.#initializationError.message}`,
      );
    }
  }

  async #initializeAndActivateOwner(
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<void> {
    const initialization = this.#initializeOwner(owner);
    this.#nativeMirrors.activate(
      owner,
      this.#setNativeName,
      async (threadId) => {
        await initialization;
        if (!owner.isCurrent() || !this.#initialized) return undefined;
        return this.#snapshot[threadId]?.title;
      },
    );
    await initialization;
  }

  async #generate(
    started: ThreadTitleProjection,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<void> {
    try {
      const generated = normalizeGeneratedTitle(
        await this.#inference.generate(
          started.source,
          this.#titleModel(),
          owner.signal,
        ),
      );
      if (!owner.isCurrent()) return;
      await this.#serial(owner, async () => {
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
        if (!(await this.#commit(projection, owner))) return;
        if (
          owner.isCurrent() &&
          this.#nativeAuthorityVersion(started.threadId) ===
            nativeAuthorityVersion
        ) {
          this.#nativeMirrors.enqueue(started.threadId, generated, owner);
        }
      });
    } catch (error) {
      if (!owner.isCurrent()) return;
      await this.#serial(owner, async () => {
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
          owner,
        );
      });
    }
  }

  async #commit(
    projection: ThreadTitleProjection,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): Promise<boolean> {
    if (!owner.isCurrent()) return false;
    const next = { ...this.#snapshot, [projection.threadId]: projection };
    if (!(await this.#store.commit(next, owner)) || !owner.isCurrent())
      return false;
    this.#snapshot = next;
    for (const listener of this.#listeners)
      listener(structuredClone(this.#snapshot));
    return true;
  }

  #startGeneration(
    projection: ThreadTitleProjection,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): void {
    if (!owner.isCurrent()) return;
    const generation = { version: projection.version, owner };
    this.#generationOwners.set(projection.threadId, generation);
    const disposeRetirement = owner.onRetire(() => {
      if (this.#generationOwners.get(projection.threadId) === generation)
        this.#generationOwners.delete(projection.threadId);
    });
    const operation = this.#generate(projection, owner).finally(() => {
      disposeRetirement();
      if (this.#generationOwners.get(projection.threadId) === generation)
        this.#generationOwners.delete(projection.threadId);
    });
    owner.track(operation);
    void operation.catch((error: unknown) => {
      if (owner.isCurrent()) {
        console.error(
          `Could not persist title generation result: ${asError(error).message}`,
        );
      }
    });
  }

  #hasCurrentGenerationOwner(projection: ThreadTitleProjection): boolean {
    const generation = this.#generationOwners.get(projection.threadId);
    return (
      generation?.version === projection.version && generation.owner.isCurrent()
    );
  }

  #nativeAuthorityVersion(threadId: string): number {
    return this.#nativeAuthorityVersions.get(threadId) ?? 0;
  }

  #operationOwner(
    ownership?: ZenXThreadTitleOwnershipTransaction,
  ): ZenXThreadTitleOwnershipTransaction {
    this.#assertAvailable();
    const owner = ownership ?? this.#owner;
    if (owner.root !== this.#owner || !owner.isCurrent())
      throw new Error("ZenX thread-title ownership transaction is retired");
    return owner;
  }

  #assertAvailable(): void {
    const retirementFailure = this.#owner.retirementFailure();
    if (retirementFailure !== undefined) {
      throw new Error(
        `ZenX thread titles are unavailable: ${retirementFailure.message}`,
        { cause: retirementFailure },
      );
    }
    if (this.#initializationError !== undefined) {
      throw new Error(
        `ZenX thread titles are unavailable: ${this.#initializationError.message}`,
      );
    }
    if (!this.#initialized)
      throw new Error("ZenX thread titles are not initialized");
  }

  async #serial<T>(
    owner: ZenXThreadTitleOwnershipTransaction,
    operation: () => Promise<T>,
  ): Promise<T> {
    const guarded = async (): Promise<T> => {
      if (!owner.isCurrent())
        throw new Error("ZenX thread-title ownership transaction is retired");
      return await operation();
    };
    const result = this.#mutation.then(guarded, guarded);
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return await owner.track(result);
  }
}

type NativeMirrorJobState = "queued" | "active" | "retired" | "settled";

interface NativeMirrorDiagnostic {
  readonly threadId: string;
  readonly title: string;
  readonly ownerId: string;
}

interface NativeMirrorAuthority {
  readonly owner: ZenXThreadTitleOwnershipTransaction;
  readonly setNativeName: (threadId: string, title: string) => Promise<void>;
  readonly desiredTitle: (threadId: string) => Promise<string | undefined>;
}

class NativeMirrorReservation {
  #released = false;

  constructor(readonly releaseCapacity: () => void) {}

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.releaseCapacity();
  }
}

class NativeMirrorJob {
  state: NativeMirrorJobState = "queued";
  disposeRetirement: (() => void) | undefined;
  repairAfterSettlement = false;

  constructor(
    readonly threadId: string,
    readonly title: string,
    readonly owner: ZenXThreadTitleOwnershipTransaction,
    readonly reservation: NativeMirrorReservation,
    readonly setNativeName: (threadId: string, title: string) => Promise<void>,
  ) {}
}

class NativeMirrorRepair {
  disposeRetirement: (() => void) | undefined;

  constructor(
    readonly threadId: string,
    readonly authority: NativeMirrorAuthority,
    readonly reservation: NativeMirrorReservation,
  ) {}
}

class NativeMirrorQueue {
  readonly #active = new Map<string, NativeMirrorJob>();
  readonly #queued = new Map<string, NativeMirrorJob>();
  readonly #repairs = new Map<string, NativeMirrorRepair>();
  readonly #quarantined: NativeMirrorDiagnostic[] = [];
  #authority: NativeMirrorAuthority | undefined;
  #reservations = 0;
  #capacityWarned = false;

  activate(
    owner: ZenXThreadTitleOwnershipTransaction,
    setNativeName: (threadId: string, title: string) => Promise<void>,
    desiredTitle: (threadId: string) => Promise<string | undefined>,
  ): void {
    this.#authority = { owner, setNativeName, desiredTitle };
  }

  reconcileAuthoritative(
    threadId: string,
    title: string,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): void {
    this.#retireRepair(threadId, true);
    const queued = this.#queued.get(threadId);
    if (queued !== undefined) this.#retireJob(queued, true);
    const active = this.#active.get(threadId);
    if (active !== undefined && active.title !== title)
      this.enqueue(threadId, title, owner);
  }

  enqueue(
    threadId: string,
    title: string,
    owner: ZenXThreadTitleOwnershipTransaction,
  ): void {
    const authority = this.#authorityFor(owner);
    if (authority === undefined) return;
    this.#retireRepair(threadId, true);
    const queued = this.#queued.get(threadId);
    if (
      queued !== undefined &&
      queued.title === title &&
      queued.owner === owner
    )
      return;
    if (queued !== undefined) this.#retireJob(queued, true);
    const reservation = this.#reserve();
    if (reservation === undefined) return;
    this.#queueReserved(
      threadId,
      title,
      owner,
      authority.setNativeName,
      reservation,
    );
  }

  #queueReserved(
    threadId: string,
    title: string,
    owner: ZenXThreadTitleOwnershipTransaction,
    setNativeName: (threadId: string, title: string) => Promise<void>,
    reservation: NativeMirrorReservation,
  ): void {
    const queued = this.#queued.get(threadId);
    if (
      queued !== undefined &&
      queued.title === title &&
      queued.owner === owner
    ) {
      reservation.release();
      return;
    }
    if (queued !== undefined) this.#retireJob(queued, true);
    if (!owner.isCurrent()) {
      reservation.release();
      return;
    }
    const job = new NativeMirrorJob(
      threadId,
      title,
      owner,
      reservation,
      setNativeName,
    );
    job.disposeRetirement = owner.onRetire(() => this.#retireJob(job, true));
    this.#queued.set(threadId, job);
    this.#pump(threadId);
  }

  #pump(threadId: string): void {
    if (this.#active.has(threadId)) return;
    const job = this.#queued.get(threadId);
    if (job === undefined) return;
    this.#queued.delete(threadId);
    if (!job.owner.isCurrent()) {
      this.#retireJob(job, true);
      return;
    }
    job.state = "active";
    this.#active.set(threadId, job);
    const operation = Promise.resolve().then(async () => {
      await job.setNativeName(job.threadId, job.title);
    });
    job.owner.track(operation);
    void operation.then(
      () => this.#settleJob(job),
      (error: unknown) => {
        if (job.state === "active" && job.owner.isCurrent()) {
          console.warn(
            `Could not mirror ZenX thread title: ${describeError(error)}`,
          );
        }
        this.#settleJob(job);
      },
    );
  }

  #settleJob(job: NativeMirrorJob): void {
    if (job.state === "retired") {
      this.#repairAfterRetiredCompletion(job);
      return;
    }
    if (job.state !== "active") return;
    const repairAfterSettlement = job.repairAfterSettlement;
    job.state = "settled";
    job.disposeRetirement?.();
    job.disposeRetirement = undefined;
    if (this.#active.get(job.threadId) === job)
      this.#active.delete(job.threadId);
    job.reservation.release();
    if (repairAfterSettlement) this.#scheduleRepair(job.threadId);
    this.#pump(job.threadId);
  }

  #retireJob(job: NativeMirrorJob, diagnose: boolean): void {
    if (job.state === "retired" || job.state === "settled") return;
    const wasActive = job.state === "active";
    job.state = "retired";
    job.disposeRetirement?.();
    job.disposeRetirement = undefined;
    if (this.#queued.get(job.threadId) === job)
      this.#queued.delete(job.threadId);
    if (this.#active.get(job.threadId) === job)
      this.#active.delete(job.threadId);
    job.reservation.release();
    if (diagnose) this.#appendDiagnostic(job);
    if (wasActive || !this.#active.has(job.threadId)) this.#pump(job.threadId);
  }

  #repairAfterRetiredCompletion(job: NativeMirrorJob): void {
    const authority = this.#authority;
    if (authority === undefined || !authority.owner.isCurrent()) return;
    const queued = this.#queued.get(job.threadId);
    if (
      queued !== undefined &&
      queued.owner.root === authority.owner.root &&
      queued.owner.isCurrent()
    )
      return;
    const active = this.#active.get(job.threadId);
    if (
      active !== undefined &&
      active.owner.root === authority.owner.root &&
      active.owner.isCurrent()
    ) {
      active.repairAfterSettlement = true;
      return;
    }
    this.#scheduleRepair(job.threadId);
  }

  #scheduleRepair(threadId: string): void {
    const authority = this.#authority;
    if (authority === undefined || !authority.owner.isCurrent()) return;
    const queued = this.#queued.get(threadId);
    if (
      queued !== undefined &&
      queued.owner.root === authority.owner.root &&
      queued.owner.isCurrent()
    )
      return;
    const existing = this.#repairs.get(threadId);
    if (existing?.authority === authority) return;
    if (existing !== undefined) this.#retireRepair(threadId, true);
    const reservation = this.#reserve();
    if (reservation === undefined) return;
    const repair = new NativeMirrorRepair(threadId, authority, reservation);
    repair.disposeRetirement = authority.owner.onRetire(() =>
      this.#retireRepair(threadId, true, repair),
    );
    this.#repairs.set(threadId, repair);
    const resolution = Promise.resolve().then(async () =>
      authority.desiredTitle(threadId),
    );
    authority.owner.track(resolution);
    void resolution.then(
      (title) => this.#resolveRepair(repair, title),
      (error: unknown) => {
        if (this.#repairs.get(threadId) !== repair) return;
        this.#retireRepair(threadId, true, repair);
        if (authority.owner.isCurrent())
          console.warn(
            `Could not reconcile a late ZenX native title mirror: ${describeError(error)}`,
          );
      },
    );
  }

  #resolveRepair(repair: NativeMirrorRepair, title: string | undefined): void {
    if (this.#repairs.get(repair.threadId) !== repair) return;
    this.#repairs.delete(repair.threadId);
    repair.disposeRetirement?.();
    repair.disposeRetirement = undefined;
    if (
      title === undefined ||
      this.#authority !== repair.authority ||
      !repair.authority.owner.isCurrent()
    ) {
      repair.reservation.release();
      if (this.#authority !== repair.authority)
        this.#scheduleRepair(repair.threadId);
      return;
    }
    this.#queueReserved(
      repair.threadId,
      title,
      repair.authority.owner,
      repair.authority.setNativeName,
      repair.reservation,
    );
  }

  #retireRepair(
    threadId: string,
    diagnose: boolean,
    expected?: NativeMirrorRepair,
  ): void {
    const repair = this.#repairs.get(threadId);
    if (repair === undefined || (expected !== undefined && repair !== expected))
      return;
    this.#repairs.delete(threadId);
    repair.disposeRetirement?.();
    repair.disposeRetirement = undefined;
    repair.reservation.release();
    if (diagnose)
      this.#appendDiagnostic({
        threadId,
        title: "<latest-authority-repair>",
        ownerId: repair.authority.owner.id,
      });
  }

  #appendDiagnostic(job: NativeMirrorJob | NativeMirrorDiagnostic): void {
    while (
      this.#reservations + this.#quarantined.length >=
      MAX_NATIVE_MIRROR_STATE
    ) {
      if (this.#quarantined.length === 0) return;
      this.#quarantined.shift();
    }
    this.#quarantined.push(
      "ownerId" in job
        ? job
        : {
            threadId: job.threadId,
            title: job.title,
            ownerId: job.owner.id,
          },
    );
  }

  #makeRoomFromDiagnostics(): void {
    while (
      this.#quarantined.length > 0 &&
      this.#reservations + this.#quarantined.length >= MAX_NATIVE_MIRROR_STATE
    ) {
      this.#quarantined.shift();
    }
  }

  #warnCapacity(): void {
    if (this.#capacityWarned) return;
    this.#capacityWarned = true;
    console.warn(
      `Could not mirror ZenX thread title: ${String(MAX_NATIVE_MIRROR_STATE)} live or queued native mirror operations already occupy the bounded transaction`,
    );
  }

  #authorityFor(
    owner: ZenXThreadTitleOwnershipTransaction,
  ): NativeMirrorAuthority | undefined {
    const authority = this.#authority;
    return authority !== undefined &&
      authority.owner.root === owner.root &&
      authority.owner.isCurrent() &&
      owner.isCurrent()
      ? authority
      : undefined;
  }

  #reserve(): NativeMirrorReservation | undefined {
    this.#makeRoomFromDiagnostics();
    if (
      this.#reservations + this.#quarantined.length >=
      MAX_NATIVE_MIRROR_STATE
    ) {
      this.#warnCapacity();
      return undefined;
    }
    this.#reservations += 1;
    this.#capacityWarned = false;
    return new NativeMirrorReservation(() => {
      this.#reservations -= 1;
      if (
        this.#reservations + this.#quarantined.length <
        MAX_NATIVE_MIRROR_STATE
      )
        this.#capacityWarned = false;
    });
  }
}

function nativeMirrorQueue(ownershipDomain: object): NativeMirrorQueue {
  const existing = nativeMirrorQueues.get(ownershipDomain);
  if (existing !== undefined) return existing;
  const queue = new NativeMirrorQueue();
  nativeMirrorQueues.set(ownershipDomain, queue);
  return queue;
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
