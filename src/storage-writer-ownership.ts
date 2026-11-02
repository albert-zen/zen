import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const native = createRequire(import.meta.url)("fs-native-extensions") as {
  tryLock(fd: number): boolean;
};
const marker = Buffer.from("zen-storage-writer-native-v1\n");
/** One private OS lifetime lock, not business state. Never unlink/reclaim the public inode. */
export class StorageWriterOwnership {
  readonly #filename: string;
  #fd: number | undefined;
  readonly #dev: number;
  readonly #ino: number;
  constructor(
    directory: string,
    options: { onInitPhase?: (phase: "temporary" | "published") => void } = {},
  ) {
    mkdirSync(directory, { recursive: true });
    if (!lstatSync(directory).isDirectory())
      throw new Error("Writer directory must not be an alias");
    this.#filename = path.join(directory, ".writer.lock");
    let fd: number;
    let alreadyLocked = false;
    try {
      fd = this.#openExisting();
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      const temporary = path.join(directory, `.writer.${randomUUID()}.tmp`);
      const candidate = openSync(temporary, "wx+", 0o600);
      let published = false;
      let candidateOpen = true;
      try {
        writeFileSync(candidate, marker);
        fsyncSync(candidate);
        if (!native.tryLock(candidate))
          throw new Error("Cannot acquire fresh storage owner");
        options.onInitPhase?.("temporary");
        try {
          linkSync(temporary, this.#filename);
          published = true;
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            throw error;
        }
        if (published) {
          options.onInitPhase?.("published");
          syncParent(directory);
        }
      } catch (error) {
        closeSync(candidate);
        candidateOpen = false;
        throw error;
      } finally {
        try {
          unlinkSync(temporary);
        } catch (error) {
          if (candidateOpen) closeSync(candidate);
          throw error;
        }
      }
      if (published) {
        fd = candidate;
        alreadyLocked = true;
      } else {
        closeSync(candidate);
        fd = this.#openExisting();
      }
    }
    try {
      const stat = fstatSync(fd);
      const named = lstatSync(this.#filename);
      if (
        !stat.isFile() ||
        !named.isFile() ||
        stat.dev !== named.dev ||
        stat.ino !== named.ino
      )
        throw new Error("Storage owner path identity changed");
      if (!alreadyLocked && !native.tryLock(fd))
        throw new Error("Storage writer already owned by another Host");
      const bytes = Buffer.alloc(marker.length + 1);
      const size = readSync(fd, bytes, 0, bytes.length, 0);
      if (size !== marker.length || !bytes.subarray(0, size).equals(marker))
        throw new Error(
          "Unsupported/stale legacy writer lock; no automatic PID/TTL reclamation",
        );
      this.#dev = stat.dev;
      this.#ino = stat.ino;
      this.#fd = fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  #openExisting(): number {
    const stat = lstatSync(this.#filename);
    if (!stat.isFile())
      throw new Error("Storage writer lock must be a regular non-symlink file");
    return openSync(
      this.#filename,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
  }
  assertHeld(): void {
    if (this.#fd === undefined) throw new Error("Storage writer is closed");
    const file = fstatSync(this.#fd);
    const named = lstatSync(this.#filename);
    if (
      !named.isFile() ||
      file.dev !== this.#dev ||
      file.ino !== this.#ino ||
      named.dev !== this.#dev ||
      named.ino !== this.#ino
    )
      throw new Error("Storage writer inode replaced; refusing mutation");
  }
  /** Bind an owned storage capability to this exact journal namespace. */
  assertDirectory(directory: string): void {
    StorageWriterOwnership.prototype.assertHeld.call(this);
    if (path.resolve(directory) !== path.resolve(path.dirname(this.#filename)))
      throw new Error("Storage writer namespace mismatch");
    if (!lstatSync(path.dirname(this.#filename)).isDirectory())
      throw new Error("Storage writer directory must not be an alias");
  }
  /** Domain owner calls only after model/tool/Trace and its queued I/O are drained. */
  close(): void {
    const fd = this.#fd;
    this.#fd = undefined;
    if (fd !== undefined) closeSync(fd);
  }
}
function syncParent(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
