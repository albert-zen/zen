import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  FileTraceStore,
  type RuntimeTrace,
  type TraceReader,
  type TraceEvent,
} from "../../../../src/trace.js";
import {
  applySidebarPatch,
  emptySidebarState,
  parseSidebarUpdate,
  sidebarOwner,
  sidebarOwnerKey,
  type SidebarOwner,
  type SidebarAdmission,
  type SidebarChangeSource,
  type ThreadSidebarPort,
  type ThreadSidebarState,
  type ThreadSidebarUpdate,
} from "../thread-sidebar-state.js";

const ownerHash = (input: SidebarOwner | string) =>
  createHash("sha256").update(sidebarOwnerKey(input)).digest("hex");
export function sidebarOwnerFile(
  directory: string,
  input: SidebarOwner | string,
) {
  return path.join(directory, `${ownerHash(input)}.json`);
}
/** Partition identity only, not an Agent Thread or new product object. */
export const sidebarTracePartition = (input: SidebarOwner | string) =>
  `sidebar-${ownerHash(input)}`;
type SidebarTrace = RuntimeTrace &
  Pick<TraceReader, "read"> & {
    flush?: () => Promise<void>;
  };
const cacheFormat = "trace-sidebar-cache";

function savedState(value: unknown, owner: SidebarOwner): ThreadSidebarState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid saved sidebar state");
  const { owner: savedOwner, revision, ...patch } = value as ThreadSidebarState;
  const parsed = parseSidebarUpdate({
    owner: savedOwner,
    expectedRevision: revision,
    patch,
  });
  if (sidebarOwnerKey(parsed.owner) !== sidebarOwnerKey(owner))
    throw Error("Sidebar owner does not match its persistence partition");
  const state = applySidebarPatch(emptySidebarState(owner), parsed.patch);
  state.revision = revision;
  if (!isDeepStrictEqual(state, value))
    throw Error("Incomplete saved sidebar state");
  return state;
}

/** Existing main-process owner queue; durable facts are authority, maps/JSON are caches. */
export class ThreadSidebarStore implements ThreadSidebarPort {
  readonly #states = new Map<string, ThreadSidebarState>();
  readonly #listeners = new Set<(state: ThreadSidebarState) => void>();
  readonly #queues = new Map<string, Promise<unknown>>();
  #closed = false;
  constructor(
    readonly directory: string,
    private readonly write: (file: string, data: string) => Promise<void> = (
      file,
      data,
    ) => writeFile(file, data, { encoding: "utf8", mode: 0o600 }),
    // Production injects the Host's existing .zen/trace facility. Isolated embedders
    // use the same implementation under their explicitly supplied data directory.
    private readonly trace: SidebarTrace = new FileTraceStore(
      path.join(directory, "trace"),
    ),
  ) {}
  onChanged(listener: (state: ThreadSidebarState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #serialize<T>(owner: SidebarOwner, action: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(Error("Sidebar store is closed"));
    const key = sidebarOwnerKey(owner);
    const result = (this.#queues.get(key) ?? Promise.resolve()).then(action);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, settled);
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return result;
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#queues.values()]);
    await this.trace.flush?.();
  }
  async #commit(
    owner: SidebarOwner,
    event: Omit<TraceEvent, "threadId">,
  ): Promise<void> {
    try {
      const receipt = await this.trace.record({
        ...event,
        threadId: sidebarTracePartition(owner),
      });
      if (receipt.durability !== "durable") throw Error(receipt.error);
    } catch (error) {
      // A failed acknowledgement can still have appended a fact. Re-read before
      // any further CAS decision; neither cache nor automatic retry decides it.
      this.#states.delete(sidebarOwnerKey(owner));
      throw new Error(
        "Sidebar log durability is unconfirmed; read current state before retrying",
        { cause: error },
      );
    }
  }
  async #cache(state: ThreadSidebarState): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = sidebarOwnerFile(this.directory, state.owner);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await this.write(
        temporary,
        JSON.stringify({ format: cacheFormat, state }),
      );
      await rename(temporary, file);
    } catch (error) {
      // The durable fact is already committed; a cache failure cannot undo it.
      console.warn(
        "Sidebar cache unavailable; durable log remains the recovery source",
        error,
      );
    }
  }
  async #load(owner: SidebarOwner): Promise<ThreadSidebarState> {
    const key = sidebarOwnerKey(owner);
    const cached = this.#states.get(key);
    if (cached) return cached;
    const history = await this.trace.read(sidebarTracePartition(owner));
    if (
      (history.completeness !== "complete" && history.issues.length === 0) ||
      history.completeness === "unavailable" ||
      history.issues.some((issue) => issue.kind !== "capture_gap")
    )
      throw Error("Sidebar log is incomplete; refusing snapshot fallback");
    let state = emptySidebarState(owner);
    let found = false;
    for (const record of history.records) {
      if (record.type === "trace_capture_gap") continue;
      if (record.origin)
        throw Error("Imported Trace cannot authorize local sidebar state");
      const data = record.data as
        | {
            state?: unknown;
            fromRevision?: unknown;
            patch?: unknown;
            source?: unknown;
          }
        | undefined;
      if (
        record.type === "sidebar_state_imported" &&
        !found &&
        data?.source === "legacy-sidebar-snapshot"
      ) {
        state = savedState(data.state, owner);
      } else if (record.type === "sidebar_state_changed" && data) {
        const update = parseSidebarUpdate({
          owner,
          expectedRevision: data.fromRevision,
          patch: data.patch,
        });
        if (update.expectedRevision !== state.revision)
          throw Error("Sidebar log revision chain is inconsistent");
        const next = applySidebarPatch(state, update.patch);
        if (!isDeepStrictEqual(next, savedState(data.state, owner)))
          throw Error("Sidebar log patch/state mismatch");
        state = next;
      } else throw Error("Unrecognized sidebar authority record");
      found = true;
    }
    if (!found) {
      let bytes: string | undefined;
      try {
        bytes = await readFile(sidebarOwnerFile(this.directory, owner), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (bytes !== undefined) {
        const raw = JSON.parse(bytes);
        if (raw?.format === cacheFormat)
          throw Error("Sidebar log is missing; cache cannot restore authority");
        state = savedState(raw, owner);
        await this.#commit(owner, {
          type: "sidebar_state_imported",
          data: {
            source: "legacy-sidebar-snapshot",
            historicalActivation: "unavailable",
            state,
          },
          artifacts: [
            {
              name: "legacy-sidebar-snapshot",
              mediaType: "application/json",
              bytes,
              captureLayer: "legacy-product-state-file",
            },
          ],
        });
        found = true;
      }
    }
    this.#states.set(key, state);
    if (found) await this.#cache(state);
    return state;
  }
  read(
    input: SidebarOwner | string,
    admit?: SidebarAdmission,
  ): Promise<ThreadSidebarState> {
    const owner = sidebarOwner(input);
    return this.#serialize(owner, async () => {
      const state = await this.#load(owner);
      admit?.();
      return structuredClone(state);
    });
  }
  update(
    input: ThreadSidebarUpdate,
    admit?: SidebarAdmission,
    source: SidebarChangeSource = { kind: "host" },
  ) {
    const request = parseSidebarUpdate(input);
    const observedSource = structuredClone(source);
    return this.#serialize(request.owner, async () => {
      const current = await this.#load(request.owner);
      // Trusted caller admission remains inside this owner's queue after I/O.
      // Once admitted, a commit may finish despite later revocation; no claim of
      // an OS-atomic transaction with Room membership storage is made.
      admit?.();
      if (current.revision !== request.expectedRevision)
        return { applied: false, state: structuredClone(current) };
      const next = applySidebarPatch(current, request.patch);
      await this.#commit(request.owner, {
        type: "sidebar_state_changed",
        data: {
          fromRevision: current.revision,
          patch: request.patch,
          state: next,
          source: observedSource,
        },
      });
      this.#states.set(sidebarOwnerKey(next.owner), next);
      await this.#cache(next);
      for (const listener of this.#listeners) {
        try {
          listener(structuredClone(next));
        } catch {
          /* fact already committed */
        }
      }
      return { applied: true, state: structuredClone(next) };
    });
  }
}
