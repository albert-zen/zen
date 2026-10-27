import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

export interface ZenXProjectlessWorkspaceAllocatorOptions {
  rootDirectory: string;
  registerWorkspace(cwd: string): Promise<void>;
  now?: () => Date;
}

/** Allocates product-owned directories; native thread/start remains the Thread authority. */
export class ZenXProjectlessWorkspaceAllocator {
  readonly #root: string;
  readonly #register: (cwd: string) => Promise<void>;
  readonly #now: () => Date;

  constructor(options: ZenXProjectlessWorkspaceAllocatorOptions) {
    if (!path.isAbsolute(options.rootDirectory))
      throw new Error("Projectless workspace root must be absolute");
    this.#root = path.resolve(options.rootDirectory);
    this.#register = options.registerWorkspace;
    this.#now = options.now ?? (() => new Date());
  }

  async allocate(directoryName?: string): Promise<string> {
    const now = this.#now();
    if (!Number.isFinite(now.getTime()))
      throw new Error("Projectless workspace date is invalid");
    const date = [
      String(now.getFullYear()).padStart(4, "0"),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    const root = await ensureDirectory(this.#root, true);
    const dated = path.join(this.#root, date);
    const day = await ensureDirectory(dated, false);
    const slug = workspaceSlug(directoryName);
    for (let collision = 0; collision < 10_000; collision++) {
      await assertDirectory(this.#root, root);
      await assertDirectory(dated, day);
      const cwd = path.join(
        dated,
        collision === 0 ? slug : `${slug}-${collision + 1}`,
      );
      try {
        await mkdir(cwd, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const allocated = await assertDirectory(cwd);
      await assertDirectory(this.#root, root);
      await assertDirectory(dated, day);
      // A failed profile write leaves the allocated directory for explicit inspection;
      // no cwd is returned to the caller and no Thread can be started from this result.
      await this.#register(cwd);
      await assertDirectory(this.#root, root);
      await assertDirectory(dated, day);
      await assertDirectory(cwd, allocated);
      return cwd;
    }
    throw new Error("Projectless workspace name collision limit reached");
  }
}

function workspaceSlug(value: string | undefined): string {
  const slug = Array.from(
    (value ?? "").normalize("NFC").replace(/[^\p{L}\p{N}\p{M}]+/gu, "-"),
  )
    .slice(0, 48)
    .join("")
    .replace(/^-+|-+$/gu, "");
  return !slug || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu.test(slug)
    ? "new-chat"
    : slug;
}

type DirectoryIdentity = { dev: number; ino: number };

async function assertDirectory(
  directory: string,
  expected?: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(
      "Projectless workspace directory must not be a symlink or file",
    );
  if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))
    throw new Error(
      "Projectless workspace directory changed during allocation",
    );
  return { dev: stat.dev, ino: stat.ino };
}

async function ensureDirectory(
  directory: string,
  recursive: boolean,
): Promise<DirectoryIdentity> {
  try {
    return await assertDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await mkdir(directory, { recursive, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return await assertDirectory(directory);
}
