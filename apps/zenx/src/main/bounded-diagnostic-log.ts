import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_BYTES = 256 * 1024;

/** Local support-data storage. Every caller must supply a strict allowlist
 * normalizer; arbitrary input objects are never serialized directly. */
export class BoundedLocalDiagnosticLog<TRecord extends object> {
  readonly #directory: string;
  readonly #file: string;
  readonly #maxBytes: number;
  readonly #normalize: (input: unknown) => TRecord | null;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: {
    userDataDirectory: string;
    fileName: string;
    normalize(input: unknown): TRecord | null;
    maxBytes?: number;
  }) {
    if (!/^[a-z][a-z0-9-]{0,39}\.jsonl$/u.test(options.fileName))
      throw new Error("Invalid diagnostic file name");
    this.#directory = path.join(options.userDataDirectory, "diagnostics");
    this.#file = path.join(this.#directory, options.fileName);
    this.#normalize = options.normalize;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (
      !Number.isSafeInteger(this.#maxBytes) ||
      this.#maxBytes < 512 ||
      this.#maxBytes > 1024 * 1024
    )
      throw new Error("Invalid diagnostic size limit");
  }

  record(input: unknown): Promise<boolean> {
    const value = this.#normalize(input);
    if (value === null) return Promise.resolve(false);
    const line = `${JSON.stringify(value)}\n`;
    const operation = this.#pending.then(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.#directory);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error("Diagnostic directory is not a directory");
      await chmod(this.#directory, 0o700);
      const size = await this.#existingFileSize();
      if (size > this.#maxBytes) {
        await rm(this.#file);
        await rm(`${this.#file}.1`, { force: true });
      } else if (size > 0 && size + Buffer.byteLength(line) > this.#maxBytes) {
        await rm(`${this.#file}.1`, { force: true });
        await rename(this.#file, `${this.#file}.1`);
        await chmod(`${this.#file}.1`, 0o600);
      }
      const handle = await open(
        this.#file,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.chmod(0o600);
        await handle.writeFile(line, "utf8");
      } finally {
        await handle.close();
      }
    });
    this.#pending = operation.catch(() => undefined);
    return operation.then(() => true);
  }

  async #existingFileSize(): Promise<number> {
    try {
      const file = await lstat(this.#file);
      if (!file.isFile() || file.isSymbolicLink())
        throw new Error("Diagnostic file is not a regular file");
      return file.size;
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return 0;
      throw error;
    }
  }
}
