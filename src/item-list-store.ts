import { randomUUID } from "node:crypto";
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
export class FileItemListStore {
  readonly #directory: string;
  readonly #phase:
    ((phase: PublicationPhase) => void | Promise<void>) | undefined;
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
      await this.#bytes(threadId);
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
  #decode(threadId: string, bytes: Buffer): ContextItem[] {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text !== "" && !text.endsWith("\n"))
      throw new Error("Incomplete semantic JSONL tail; no automatic repair");
    const items = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => decodeContextItem(JSON.parse(line)));
    this.#validate(threadId, items);
    return items;
  }
  #validate(threadId: string, items: readonly ContextItem[]): void {
    const seen = new Set<string>();
    for (const raw of items) {
      const item = decodeContextItem(raw);
      if (item.threadId !== threadId || seen.has(item.id))
        throw new Error("Mixed Thread or duplicate semantic identity");
      seen.add(item.id);
    }
  }
  async read(threadId: string): Promise<ContextItem[]> {
    try {
      return this.#decode(threadId, await this.#bytes(threadId));
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
    const write = this.#chain.then(async () => {
      const original = await this.#bytes(threadId);
      const prior = this.#decode(threadId, original);
      this.#validate(threadId, [...prior, ...snapshot]);
      try {
        await replaceFile(
          this.#path(threadId),
          Buffer.concat([
            original,
            Buffer.from(
              snapshot.map((item) => JSON.stringify(item)).join("\n") + "\n",
            ),
          ]),
          this.#phase,
        );
      } catch (error) {
        throw new ThreadJournalAppendOutcomeUnknownError(error);
      }
    });
    this.#chain = write.catch(() => undefined);
    await write;
  }
}
