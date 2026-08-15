import { access, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface DirectoryLocation {
  label: string;
  path: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  breadcrumbs: DirectoryLocation[];
  directories: DirectoryEntry[];
}

export interface DirectoryBrowserSnapshot {
  locations: DirectoryLocation[];
  initialPath: string;
}

/** Read-only, canonical filesystem projection used by ZenX's directory picker. */
export class ZenXDirectoryBrowser {
  readonly #home: string;
  readonly #documents: string;
  readonly #platform: NodeJS.Platform;

  constructor(options: {
    home: string;
    documents: string;
    platform?: NodeJS.Platform;
  }) {
    this.#home = path.resolve(options.home);
    this.#documents = path.resolve(options.documents);
    this.#platform = options.platform ?? process.platform;
  }

  async snapshot(): Promise<DirectoryBrowserSnapshot> {
    const locations: DirectoryLocation[] = [];
    await this.#addLocation(locations, "Home", this.#home);
    if (this.#documents !== this.#home)
      await this.#addLocation(locations, "Documents", this.#documents);
    if (this.#platform === "win32") {
      const drives = await Promise.all(
        Array.from({ length: 26 }, async (_, index) => {
          const drive = `${String.fromCharCode(65 + index)}:\\`;
          return (await isPromptlyAccessible(drive))
            ? { label: drive, path: drive }
            : null;
        }),
      );
      locations.push(
        ...drives.filter((drive): drive is DirectoryLocation => drive !== null),
      );
    } else {
      locations.push({ label: "Root", path: "/" });
    }
    const initialPath =
      locations.find((location) => location.label === "Documents")?.path ??
      locations[0]?.path;
    if (initialPath === undefined)
      throw new Error("No readable starting location is available");
    return { locations, initialPath };
  }

  async list(requestedPath: string): Promise<DirectoryListing> {
    if (requestedPath.trim().length === 0)
      throw new Error("A directory path is required");
    let canonical: string;
    try {
      canonical = await realpath(path.resolve(requestedPath));
      const metadata = await stat(canonical);
      if (!metadata.isDirectory()) throw new Error("Path is not a directory");
    } catch (error) {
      throw new Error(`Could not open directory: ${describeFsError(error)}`);
    }
    let children;
    try {
      children = await readdir(canonical, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Could not read directory: ${describeFsError(error)}`);
    }
    const candidates = await Promise.all(
      children.map(async (entry): Promise<DirectoryEntry | null> => {
        const childPath = path.join(canonical, entry.name);
        if (entry.isDirectory()) return { name: entry.name, path: childPath };
        if (!entry.isSymbolicLink()) return null;
        try {
          const target = await realpath(childPath);
          return (await stat(target)).isDirectory()
            ? { name: entry.name, path: target }
            : null;
        } catch {
          return null;
        }
      }),
    );
    const root = path.parse(canonical).root;
    return {
      path: canonical,
      parent: canonical === root ? null : path.dirname(canonical),
      breadcrumbs: breadcrumbs(canonical),
      directories: candidates
        .filter((entry): entry is DirectoryEntry => entry !== null)
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          }),
        ),
    };
  }

  async #addLocation(
    locations: DirectoryLocation[],
    label: string,
    candidate: string,
  ): Promise<void> {
    try {
      const canonical = await realpath(candidate);
      if ((await stat(canonical)).isDirectory())
        locations.push({ label, path: canonical });
    } catch {
      // A missing conventional folder must not prevent the picker from opening.
    }
  }
}

async function isPromptlyAccessible(candidate: string): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      access(candidate).then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 300);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function breadcrumbs(directory: string): DirectoryLocation[] {
  const parsed = path.parse(directory);
  const relative = directory.slice(parsed.root.length);
  const result: DirectoryLocation[] = [
    { label: parsed.root, path: parsed.root },
  ];
  let current = parsed.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    result.push({ label: segment, path: current });
  }
  return result;
}

function describeFsError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return "permission denied";
    if (code === "ENOENT") return "the location is unavailable";
    return error.message;
  }
  return String(error);
}
