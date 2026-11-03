import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { decodeContextItem, type ContextItem } from "./item-list.js";
import { ThreadJournalAppendOutcomeUnknownError } from "./journal.js";
import {
  assertOwnedFile,
  isMissing,
  replaceFile,
  syncDirectory,
  type PublicationPhase,
} from "./storage-files.js";
// Decoded JSON belongs to this scope; callbacks cannot desynchronize it from bytes.
function freezeSnapshot<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
/** Internal, callback-scoped access; callers must await each operation. */
export interface ItemListAppendSnapshot {
  read(): Promise<readonly ContextItem[]>;
  append(items: readonly ContextItem[]): Promise<void>;
}
export class FileItemListStore {
  readonly #directory: string;
  readonly #phase:
    ((phase: PublicationPhase) => void | Promise<void>) | undefined;
  #verifiedAppend:
    | {
        threadId: string;
        bytes: Buffer;
        items: ContextItem[];
        ids: Set<string>;
      }
    | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  constructor(
    directory: string,
    options: {
      onAppendPhase?: (phase: PublicationPhase) => void | Promise<void>;
    } = {},
  ) {
    this.#directory = path.resolve(directory);
    this.#phase = options.onAppendPhase;
  }
  #path(threadId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(threadId))
      throw new Error("Invalid Thread identity");
    return path.join(this.#directory, `${threadId}.jsonl`);
  }
  async exists(threadId: string): Promise<boolean> {
    try {
      const filename = this.#path(threadId);
      await assertOwnedFile(filename);
      // Probe readability without materializing the entire semantic history.
      // Keep the same owned-file gate; an existence result is not validation.
      const file = await open(
        filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error(
            `Storage file must be an unaliased regular file: ${filename}`,
          );
      } finally {
        await file.close();
      }
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  async #bytes(threadId: string): Promise<Buffer> {
    const filename = this.#path(threadId);
    await assertOwnedFile(filename);
    return readFile(filename);
  }
  #decode(
    threadId: string,
    bytes: Buffer,
  ): { items: ContextItem[]; ids: Set<string> } {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text !== "" && !text.endsWith("\n"))
      throw new Error("Incomplete semantic JSONL tail; no automatic repair");
    const items = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => decodeContextItem(JSON.parse(line)));
    // The complete schema pass above already decoded these plain JSON values.
    // Preserve parse-before-identity errors without cloning the history again.
    const ids = new Set<string>();
    for (const item of items) {
      if (item.threadId !== threadId || ids.has(item.id))
        throw new Error("Mixed Thread or duplicate semantic identity");
      ids.add(item.id);
    }
    return { items, ids };
  }
  #validate(
    threadId: string,
    items: readonly ContextItem[],
    priorIds?: ReadonlySet<string>,
  ): Set<string> {
    const seen = new Set<string>();
    for (const raw of items) {
      const item = decodeContextItem(raw);
      if (
        item.threadId !== threadId ||
        seen.has(item.id) ||
        priorIds?.has(item.id)
      )
        throw new Error("Mixed Thread or duplicate semantic identity");
      seen.add(item.id);
    }
    return seen;
  }
  async read(threadId: string): Promise<ContextItem[]> {
    try {
      return this.#decode(threadId, await this.#bytes(threadId)).items;
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
  async listThreadIds(): Promise<string[]> {
    try {
      return (await readdir(this.#directory, { withFileTypes: true }))
        .filter((e) => e.isFile() && /^[A-Za-z0-9_-]+\.jsonl$/.test(e.name))
        .map((e) => e.name.slice(0, -6))
        .sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
  async create(threadId: string, items: readonly ContextItem[]): Promise<void> {
    this.#validate(threadId, items);
    const target = this.#path(threadId);
    await mkdir(this.#directory, { recursive: true });
    const temporary = path.join(
      this.#directory,
      `.${threadId}.${randomUUID()}.tmp`,
    );
    const file = await open(temporary, "wx", 0o600);
    let closed = false;
    try {
      await file.writeFile(
        items.length
          ? items.map((item) => JSON.stringify(item)).join("\n") + "\n"
          : "",
      );
      await file.sync();
      await file.close();
      closed = true;
      await link(temporary, target);
      await syncDirectory(this.#directory);
    } finally {
      if (!closed) await file.close();
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  }
  async append(threadId: string, items: readonly ContextItem[]): Promise<void> {
    if (!items.length) return;
    const snapshot = items.map(decodeContextItem);
    await this.withAppendSnapshot(threadId, (scope) => scope.append(snapshot));
  }
  /** Domain operation -> existing store lane; never re-enter public append here. */
  async withAppendSnapshot<T>(
    threadId: string,
    use: (snapshot: ItemListAppendSnapshot) => Promise<T>,
  ): Promise<T> {
    const write = this.#chain.then(async () => {
      let active = true;
      let retained:
        { bytes: Buffer; items: ContextItem[]; ids: Set<string> } | undefined;
      let pending: Promise<void> | undefined;
      let failure: { error: unknown } | undefined;
      const run = <R>(action: () => Promise<R>): Promise<R> => {
        if (!active || pending !== undefined)
          return Promise.reject(
            new Error("ItemList append snapshot is inactive or busy"),
          );
        const operation = action().catch((error: unknown) => {
          active = false;
          retained = undefined;
          this.#verifiedAppend = undefined;
          failure = { error };
          throw error;
        });
        pending = operation.then(
          () => {
            pending = undefined;
          },
          () => {
            pending = undefined;
          },
        );
        return operation;
      };
      const load = async () => {
        if (retained === undefined) {
          const bytes = await this.#bytes(threadId);
          const known = this.#verifiedAppend;
          if (known?.threadId === threadId && bytes.equals(known.bytes)) {
            retained = { bytes, items: known.items, ids: known.ids };
          } else {
            const decoded = this.#decode(threadId, bytes);
            retained = {
              bytes,
              items: freezeSnapshot(decoded.items),
              ids: decoded.ids,
            };
          }
          // The owned file is still read in full for every operation. Only exact
          // byte equality can reuse a private immutable decoded prefix.
          this.#verifiedAppend = { threadId, ...retained };
        }
        return retained;
      };
      const scope: ItemListAppendSnapshot = {
        read: () =>
          run(async () => {
            try {
              return (await load()).items;
            } catch (error) {
              // Absence is not a validated prefix: reconciliation may create it.
              if (isMissing(error)) return [];
              throw error;
            }
          }),
        append: (items) => {
          return run(async () => {
            const suffix = items.map(decodeContextItem);
            if (!suffix.length) return;
            const prior = await load();
            const combined = freezeSnapshot([...prior.items, ...suffix]);
            // The frozen prefix and its IDs are private to this active scope.
            // Still validate detached suffixes: caller accessors may change on clone.
            const addedIds = this.#validate(threadId, suffix, prior.ids);
            // Keep the fresh readable/owned-file gate without rereading content.
            if (!(await this.exists(threadId)))
              throw Object.assign(new Error("Semantic source disappeared"), {
                code: "ENOENT",
              });
            const bytes = Buffer.concat([
              prior.bytes,
              Buffer.from(
                suffix.map((item) => JSON.stringify(item)).join("\n") + "\n",
              ),
            ]);
            try {
              await replaceFile(this.#path(threadId), bytes, this.#phase);
            } catch (error) {
              throw new ThreadJournalAppendOutcomeUnknownError(error);
            }
            for (const id of addedIds) prior.ids.add(id);
            retained = { bytes, items: combined, ids: prior.ids };
            this.#verifiedAppend = { threadId, ...retained };
          });
        },
      };
      try {
        const result = await use(scope);
        active = false;
        // Even an accidentally unawaited operation must settle before lane release.
        await pending;
        if (failure !== undefined) throw failure.error;
        return result;
      } catch (error) {
        this.#verifiedAppend = undefined;
        throw error;
      } finally {
        active = false;
        await pending;
        retained = undefined;
      }
    });
    this.#chain = write.catch(() => undefined);
    return write;
  }
}
