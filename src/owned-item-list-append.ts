import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { decodeContextItem, type ContextItem } from "./item-list.js";
import { ThreadJournalAppendOutcomeUnknownError } from "./journal.js";
import { StorageWriterOwnership } from "./storage-writer-ownership.js";

export interface OwnedItemListAppendHandle {
  /** A disposable initial read, not a dispatch or recovery authorization. */
  readonly initialItems: readonly ContextItem[];
  append(items: readonly ContextItem[]): Promise<readonly ContextItem[]>;
  close(): Promise<void>;
}

const claims = new WeakMap<StorageWriterOwnership, Map<string, symbol>>();

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStamp(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  );
}

function regular(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    throw new Error("Owned semantic file must be an unaliased regular file");
}

async function directories(directory: string): Promise<void> {
  for (const target of [directory, path.join(directory, "items")]) {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Owned semantic directory must not be an alias");
  }
}

function assertOwner(owner: StorageWriterOwnership, directory: string): void {
  // Calling the actual method enforces its private-field brand and exact namespace.
  StorageWriterOwnership.prototype.assertDirectory.call(owner, directory);
}

/**
 * Disabled foundation: Domain admission does not call this capability yet.
 * The factory, never its caller, validates and owns the prefix and file stamp.
 */
export async function openOwnedItemListAppend(
  owner: StorageWriterOwnership,
  directory: string,
  threadId: string,
): Promise<OwnedItemListAppendHandle> {
  directory = path.resolve(directory);
  assertOwner(owner, directory);
  if (!/^[A-Za-z0-9_-]+$/.test(threadId))
    throw new Error("Invalid Thread identity");
  const filename = path.join(directory, "items", `${threadId}.jsonl`);
  const held = claims.get(owner) ?? new Map<string, symbol>();
  if (held.has(filename)) throw new Error("Owned semantic append is already open");
  claims.set(owner, held);
  const token = Symbol("owned semantic append");
  held.set(filename, token);
  const release = () => {
    if (held.get(filename) === token) held.delete(filename);
  };
  let stamp: BigIntStats;
  let initial: ContextItem[];
  try {
    await directories(directory);
    const before = await lstat(filename, { bigint: true });
    regular(before);
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat({ bigint: true });
      regular(opened);
      if (!sameStamp(before, opened)) throw new Error("Semantic prefix changed during open");
      const bytes = await file.readFile();
      const after = await file.stat({ bigint: true });
      const named = await lstat(filename, { bigint: true });
      regular(named);
      if (!sameStamp(opened, after) || !sameStamp(after, named))
        throw new Error("Semantic prefix changed during validation");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text !== "" && !text.endsWith("\n"))
        throw new Error("Incomplete semantic tail requires explicit owned source recovery");
      initial = text.split("\n").filter(Boolean).map((line) => decodeContextItem(JSON.parse(line)));
      const ids = new Set<string>();
      for (const item of initial) {
        if (item.threadId !== threadId || ids.has(item.id))
          throw new Error("Mixed Thread or duplicate semantic identity");
        ids.add(item.id);
      }
      stamp = named;
    } finally {
      await file.close();
    }
    await directories(directory);
    assertOwner(owner, directory);
  } catch (error) {
    release();
    throw error;
  }
  const ids = new Set(initial.map((item) => item.id));
  let chain: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let poisoned = false;
  return Object.freeze({
    initialItems: structuredClone(initial),
    async append(items: readonly ContextItem[]): Promise<readonly ContextItem[]> {
      if (closing !== undefined) throw new Error("Owned semantic append is closed");
      const batch = structuredClone(items).map(decodeContextItem);
      const bytes = Buffer.from(batch.map((item) => JSON.stringify(item)).join("\n") + (batch.length ? "\n" : ""));
      const pending = chain.then(async () => {
        if (poisoned) throw new Error("Owned semantic append requires explicit recovery");
        assertOwner(owner, directory);
        const nextIds = new Set<string>();
        for (const item of batch) {
          if (item.threadId !== threadId || ids.has(item.id) || nextIds.has(item.id))
            throw new Error("Mixed Thread or duplicate semantic identity");
          nextIds.add(item.id);
        }
        if (batch.length === 0) return [];
        let file: FileHandle | undefined;
        let failure: unknown;
        let failed = false;
        let after: BigIntStats | undefined;
        try {
          await directories(directory);
          const named = await lstat(filename, { bigint: true });
          regular(named);
          if (!sameStamp(stamp, named)) throw new Error("Semantic prefix changed outside its owner");
          file = await open(
            filename,
            constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
          );
          const opened = await file.stat({ bigint: true });
          regular(opened);
          if (!sameStamp(stamp, opened)) throw new Error("Semantic prefix changed during append open");
          assertOwner(owner, directory);
          let offset = 0;
          while (offset < bytes.length) {
            const result = await file.write(bytes, offset, bytes.length - offset);
            if (result.bytesWritten === 0) throw new Error("Semantic append made no progress");
            offset += result.bytesWritten;
          }
          await file.sync();
          after = await file.stat({ bigint: true });
          regular(after);
          const current = await lstat(filename, { bigint: true });
          regular(current);
          if (
            !sameFile(stamp, after) ||
            after.size !== stamp.size + BigInt(bytes.length) ||
            !sameStamp(after, current)
          )
            throw new Error("Semantic file changed during append");
          await directories(directory);
          assertOwner(owner, directory);
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          if (file !== undefined) {
            try {
              await file.close();
            } catch (error) {
              failure = failed ? new AggregateError([failure, error]) : error;
              failed = true;
            }
          }
        }
        if (failed || after === undefined) {
          poisoned = true;
          throw new ThreadJournalAppendOutcomeUnknownError(failure);
        }
        stamp = after;
        for (const id of nextIds) ids.add(id);
        return structuredClone(batch);
      });
      chain = pending.catch(() => undefined);
      return await pending;
    },
    close(): Promise<void> {
      return closing ??= chain.then(() => release());
    },
  });
}
