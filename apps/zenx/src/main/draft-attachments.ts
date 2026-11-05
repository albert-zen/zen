import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  AttachmentStoreError,
  FileAttachmentStore,
  type AttachmentRef,
  type AttachmentStore,
} from "../../../../src/attachment.js";
import {
  assertOwnedFile,
  isMissing,
  replaceFile,
} from "../../../../src/storage-files.js";
import {
  importImageDrafts,
  importLocalImageDrafts,
  isAttachmentRef,
  type ZenXImageDraft,
  type ZenXImageImport,
} from "./image-attachments.js";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[a-f0-9-]{36}$/u;
const UNPUBLISHED_LEASE = /^\.[a-f0-9-]{36}\.json\.[a-f0-9-]{36}\.tmp$/u;
const GRACE_MS = 60_000;
interface DraftRecord {
  id: string;
  session: string;
  owner: number;
  attachment: AttachmentRef;
  abandonedAt?: number;
}

export interface DraftAttachmentInventory {
  retainedBytes: number;
  abandonedBytes: number;
  unknownBytes: number;
  /** Present in the durable store, not proof that a message was admitted. */
  publishedBytes: number;
  candidates: { sha256: string; byteLength: number; eligibleAt: number }[];
}

/** Disposable draft storage is separate from the immutable, never-collected history store. */
export class ZenXDraftAttachments {
  readonly #directory: string;
  readonly #staged: FileAttachmentStore;
  readonly #permanent: Pick<AttachmentStore, "read" | "importBytes">;
  readonly #session = randomUUID();
  readonly #now: () => number;
  readonly #graceMs: number;
  readonly #autoCollect: boolean;
  #tail: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    directory: string,
    permanent: Pick<AttachmentStore, "read" | "importBytes">,
    options: {
      now?: () => number;
      graceMs?: number;
      autoCollect?: boolean;
    } = {},
  ) {
    this.#directory = path.resolve(directory);
    this.#staged = new FileAttachmentStore(this.#directory);
    this.#permanent = permanent;
    this.#now = options.now ?? Date.now;
    this.#graceMs = options.graceMs ?? GRACE_MS;
    this.#autoCollect = options.autoCollect ?? true;
  }

  importImages(
    owner: number,
    images: readonly ZenXImageImport[],
  ): Promise<ZenXImageDraft[]> {
    return this.#run(async () => {
      const drafts: ZenXImageDraft[] = [];
      // A rejected batch must not leave still-running imports outside the lane.
      for (const image of images)
        drafts.push(...(await importImageDrafts(this.#staged, [image])));
      return this.#retain(owner, drafts);
    });
  }

  importLocalImages(
    owner: number,
    filenames: readonly string[],
  ): Promise<ZenXImageDraft[]> {
    return this.#run(async () => {
      const drafts: ZenXImageDraft[] = [];
      for (const filename of filenames)
        drafts.push(
          ...(await importLocalImageDrafts(this.#staged, [filename])),
        );
      return this.#retain(owner, drafts);
    });
  }

  /** Import failures leave unknown blobs; they never grant deletion authority. */
  async #retain(
    owner: number,
    images: ZenXImageDraft[],
  ): Promise<ZenXImageDraft[]> {
    for (const image of images) {
      await this.#save({
        id: image.id,
        session: this.#session,
        owner,
        attachment: image.attachment,
      });
    }
    return images;
  }

  read(ref: AttachmentRef): Promise<Uint8Array> {
    return this.#run(() => this.#read(ref));
  }

  async #read(ref: AttachmentRef): Promise<Uint8Array> {
    try {
      return await this.#permanent.read(ref);
    } catch (error) {
      if (!(
        error instanceof AttachmentStoreError &&
        error.code === "attachment_missing"
      ))
        throw error;
      return this.#staged.read(ref);
    }
  }

  /** Complete durable publication before any local input request can reach the Host. */
  prepareRequest(method: string, params: unknown): Promise<void> {
    if (
      ![
        "turn/start",
        "turn/steer",
        "turn/replace",
        "zen/turn/send",
        "zen/turn/send-unarchived",
        "zen/thread/queue/edit",
      ].includes(method)
    )
      return Promise.resolve();
    if (
      typeof params !== "object" ||
      params === null ||
      !("input" in params) ||
      !Array.isArray(params.input)
    )
      return Promise.resolve();
    const input = params.input;
    return this.#run(async () => {
      const refs = input.flatMap((part: unknown) => {
        if (
          typeof part !== "object" ||
          part === null ||
          !("type" in part) ||
          !["image", "attachment"].includes(String(part.type)) ||
          !("attachment" in part) ||
          !isAttachmentRef(part.attachment)
        )
          return [];
        return [part.attachment];
      });
      for (const ref of refs) {
        const bytes = await this.#read(ref);
        const published = await this.#permanent.importBytes(
          bytes,
          ref.mediaType,
        );
        if (
          published.sha256 !== ref.sha256 ||
          published.byteLength !== ref.byteLength ||
          published.mediaType !== ref.mediaType ||
          published.width !== ref.width ||
          published.height !== ref.height
        )
          throw new Error(
            "Draft attachment identity changed during publication",
          );
        // All readers prefer the verified durable copy. Removing this redundant
        // staging copy cannot invalidate any draft, including another window's.
        await this.#permanent.read(ref);
        await this.#removeStaged(ref.sha256);
      }
    });
  }

  /** Only an explicit removal of this process/window's exact draft lease can retire it. */
  abandon(owner: number, ids: readonly string[]): Promise<void> {
    return this.#run(async () => {
      for (const id of ids) {
        if (!ID.test(id)) continue; // Canonical/old references have no draft lease.
        const record = await this.#record(id);
        if (
          record?.session !== this.#session ||
          record.owner !== owner ||
          record.abandonedAt !== undefined
        )
          continue;
        await this.#save({ ...record, abandonedAt: this.#now() });
      }
      this.#schedule(this.#graceMs + 1);
    });
  }

  inventory(): Promise<DraftAttachmentInventory> {
    return this.#run(async () => (await this.#inspect()).inventory);
  }

  /** Rechecks every lease under the same import/read/publication lane before deleting staging only. */
  collectAbandoned(): Promise<string[]> {
    return this.#run(async () => {
      const { inventory, records } = await this.#inspect();
      const removed: string[] = [];
      for (const candidate of inventory.candidates) {
        if (candidate.eligibleAt > this.#now()) {
          this.#schedule(candidate.eligibleAt - this.#now() + 1);
          continue;
        }
        await rm(path.join(this.#directory, "sha256", candidate.sha256), {
          recursive: true,
        });
        removed.push(candidate.sha256);
        for (const record of records.filter(
          (entry) => entry.attachment.sha256 === candidate.sha256,
        )) {
          await rm(this.#filename(record.id), { force: true });
        }
      }
      return removed;
    });
  }

  #schedule(delay: number): void {
    if (!this.#autoCollect || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.collectAbandoned().catch((error: unknown) =>
        console.warn(
          "Draft attachment cleanup failed; uncollected files were retained",
          error,
        ),
      );
    }, delay);
    this.#timer.unref();
  }

  async #removeStaged(hash: string): Promise<void> {
    // FileAttachmentStore.read validated this staging tree before publication;
    // if a durable-only reference was supplied, there may be no staging tree.
    const names = await this.#entries(path.join(this.#directory, "leases"));
    const records: DraftRecord[] = [];
    for (const name of names) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      const record = ID.test(id) ? await this.#record(id) : undefined;
      if (record?.attachment.sha256 === hash) records.push(record);
    }
    const hashRoot = path.join(this.#directory, "sha256");
    if ((await this.#entries(hashRoot)).includes(hash)) {
      await rm(path.join(hashRoot, hash), { recursive: true, force: true });
    }
    for (const record of records)
      await rm(this.#filename(record.id), { force: true });
  }

  async #inspect(): Promise<{
    inventory: DraftAttachmentInventory;
    records: DraftRecord[];
  }> {
    const inventory: DraftAttachmentInventory = {
      retainedBytes: 0,
      abandonedBytes: 0,
      unknownBytes: 0,
      publishedBytes: 0,
      candidates: [],
    };
    const records: DraftRecord[] = [];
    let uncertain = false;
    for (const name of await this.#entries(
      path.join(this.#directory, "leases"),
    )) {
      // replaceFile acknowledges only its final JSON after rename + fsync.
      // An interrupted temporary is not a live lease; keep it, and let its
      // payload remain unknown unless a valid final record independently owns it.
      if (UNPUBLISHED_LEASE.test(name)) continue;
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      const record = ID.test(id) ? await this.#record(id) : undefined;
      if (record === undefined) uncertain = true;
      else records.push(record);
    }
    for (const hash of await this.#entries(
      path.join(this.#directory, "sha256"),
    )) {
      if (!HASH.test(hash)) continue; // Unknown/incomplete import directories are never reclaimed.
      const related = records.filter(
        (record) => record.attachment.sha256 === hash,
      );
      const filename = path.join(this.#directory, "sha256", hash, "payload");
      const stat = await lstat(filename).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (stat === undefined) continue;
      const ref = related[0]?.attachment;
      let valid = false;
      if (ref !== undefined) {
        try {
          await this.#staged.read(ref);
          valid = true;
        } catch {
          /* Corruption is unknown, never cleanup authority. */
        }
      }
      if (
        uncertain ||
        !valid ||
        ref === undefined ||
        related.some(
          (record) =>
            record.attachment.byteLength !== ref.byteLength ||
            record.attachment.mediaType !== ref.mediaType ||
            record.attachment.width !== ref.width ||
            record.attachment.height !== ref.height,
        ) ||
        related.some(
          (record) =>
            record.session !== this.#session &&
            record.abandonedAt === undefined,
        )
      ) {
        inventory.unknownBytes += stat.size;
        continue;
      }
      let published = false;
      try {
        await this.#permanent.read(ref);
        published = true;
      } catch (error) {
        if (!(
          error instanceof AttachmentStoreError &&
          error.code === "attachment_missing"
        )) {
          inventory.unknownBytes += stat.size;
          continue;
        }
      }
      const retained = related.some(
        (record) => record.abandonedAt === undefined,
      );
      if (published) inventory.publishedBytes += stat.size;
      else if (retained) inventory.retainedBytes += stat.size;
      else inventory.abandonedBytes += stat.size;
      // Even a published blob keeps its active staging lease: admission outcome is not inferred.
      if (!retained)
        inventory.candidates.push({
          sha256: hash,
          byteLength: stat.size,
          eligibleAt:
            Math.max(...related.map((record) => record.abandonedAt!)) +
            this.#graceMs,
        });
    }
    return { inventory, records };
  }

  async #entries(directory: string): Promise<string[]> {
    try {
      if (
        !(await lstat(this.#directory)).isDirectory() ||
        !(await lstat(directory)).isDirectory()
      )
        throw new Error("Draft attachment directory must not be a symlink");
      return await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  #filename(id: string): string {
    return path.join(this.#directory, "leases", `${id}.json`);
  }

  async #record(id: string): Promise<DraftRecord | undefined> {
    try {
      const directory = path.dirname(this.#filename(id));
      if (
        !(await lstat(this.#directory)).isDirectory() ||
        !(await lstat(directory)).isDirectory()
      )
        return undefined;
      await assertOwnedFile(this.#filename(id));
      const value = JSON.parse(
        await readFile(this.#filename(id), "utf8"),
      ) as Partial<DraftRecord>;
      if (
        value.id !== id ||
        typeof value.session !== "string" ||
        !Number.isSafeInteger(value.owner) ||
        !isAttachmentRef(value.attachment) ||
        (value.abandonedAt !== undefined &&
          (!Number.isFinite(value.abandonedAt) || value.abandonedAt < 0))
      )
        return undefined;
      return value as DraftRecord;
    } catch {
      return undefined;
    }
  }

  async #save(record: DraftRecord): Promise<void> {
    const directory = path.dirname(this.#filename(record.id));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (
      !(await lstat(this.#directory)).isDirectory() ||
      !(await lstat(directory)).isDirectory()
    )
      throw new Error("Draft attachment directory must not be a symlink");
    await replaceFile(
      this.#filename(record.id),
      Buffer.from(JSON.stringify(record)),
    );
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }
}
