import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "./thread-title-types.js";

export class ZenXThreadTitleStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async read(): Promise<ThreadTitleSnapshot> {
    let handle;
    try {
      handle = await open(this.#filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!isRecord(value))
        throw new Error("ZenX thread title store is invalid");
      return Object.fromEntries(
        Object.entries(value).map(([threadId, projection]) => [
          threadId,
          validateProjection(threadId, projection),
        ]),
      );
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("ZenX thread title store contains invalid JSON");
      throw error;
    } finally {
      await handle.close();
    }
  }

  async write(
    snapshot: ThreadTitleSnapshot,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (!isCurrent()) {
      await rm(temporary, { force: true });
      return;
    }
    await rename(temporary, this.#filePath);
  }
}

function validateProjection(
  threadId: string,
  value: unknown,
): ThreadTitleProjection {
  if (
    !isRecord(value) ||
    value.threadId !== threadId ||
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    typeof value.source !== "string" ||
    value.source.length === 0 ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    !["provisional", "generating", "generated", "manual", "failed"].includes(
      String(value.status),
    ) ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    throw new Error(`ZenX thread title projection ${threadId} is invalid`);
  }
  return value as unknown as ThreadTitleProjection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
