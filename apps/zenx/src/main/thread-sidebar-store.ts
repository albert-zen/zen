import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  applySidebarPatch,
  emptySidebarState,
  parseSidebarUpdate,
  sidebarOwner,
  sidebarOwnerKey,
  type SidebarOwner,
  type SidebarAdmission,
  type ThreadSidebarPort,
  type ThreadSidebarState,
  type ThreadSidebarUpdate,
} from "../thread-sidebar-state.js";

export function sidebarOwnerFile(
  directory: string,
  input: SidebarOwner | string,
) {
  return path.join(
    directory,
    `${createHash("sha256").update(sidebarOwnerKey(input)).digest("hex")}.json`,
  );
}

/** One authority; independent owners never queue behind each other's persistence. */
export class ThreadSidebarStore implements ThreadSidebarPort {
  readonly #states = new Map<string, ThreadSidebarState>();
  readonly #listeners = new Set<(state: ThreadSidebarState) => void>();
  readonly #queues = new Map<string, Promise<unknown>>();
  constructor(
    readonly directory: string,
    private readonly write: (file: string, data: string) => Promise<void> = (
      file,
      data,
    ) => writeFile(file, data, { encoding: "utf8", mode: 0o600 }),
  ) {}
  onChanged(listener: (state: ThreadSidebarState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #serialize<T>(owner: SidebarOwner, action: () => Promise<T>): Promise<T> {
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
  async #load(owner: SidebarOwner): Promise<ThreadSidebarState> {
    const key = sidebarOwnerKey(owner);
    const cached = this.#states.get(key);
    if (cached) return cached;
    let state: ThreadSidebarState;
    try {
      const raw = JSON.parse(
        await readFile(sidebarOwnerFile(this.directory, owner), "utf8"),
      );
      const { owner: savedOwner, revision, ...patch } = raw;
      const parsed = parseSidebarUpdate({
        owner: savedOwner,
        expectedRevision: revision,
        patch,
      });
      if (sidebarOwnerKey(parsed.owner) !== key)
        throw new Error("Sidebar owner does not match its persistence file");
      state = applySidebarPatch(emptySidebarState(owner), parsed.patch);
      state.revision = revision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = emptySidebarState(owner);
    }
    this.#states.set(key, state);
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
  update(input: ThreadSidebarUpdate, admit?: SidebarAdmission) {
    const request = parseSidebarUpdate(input);
    return this.#serialize(request.owner, async () => {
      const current = await this.#load(request.owner);
      // Trusted caller admission happens inside this owner's queue, after I/O.
      // Once admitted, an atomic write may finish despite later revocation.
      // We do not claim an OS-atomic transaction with Room membership storage.
      admit?.();
      if (current.revision !== request.expectedRevision)
        return { applied: false, state: structuredClone(current) };
      const next = applySidebarPatch(current, request.patch);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = sidebarOwnerFile(this.directory, request.owner);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await this.write(temporary, JSON.stringify(next));
      await rename(temporary, file);
      this.#states.set(sidebarOwnerKey(next.owner), next);
      for (const listener of this.#listeners) {
        try {
          listener(structuredClone(next));
        } catch {
          /* state already committed */
        }
      }
      return { applied: true, state: structuredClone(next) };
    });
  }
}
