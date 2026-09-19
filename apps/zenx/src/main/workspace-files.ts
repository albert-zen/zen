import { createHash, randomUUID } from "node:crypto";
import { rename, rm, stat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceFileListing {
  path: string;
  entries: { name: string; path: string; kind: "directory" | "file" }[];
  truncated: boolean;
}
export interface WorkspaceTextFile {
  path: string;
  text: string;
  revision: string;
}
export type WorkspaceFileSaveResult = {
  status: "saved" | "conflict";
  file: WorkspaceTextFile;
};

// A bounded text editor of the selected Thread's cwd, not a tool permission policy.
// Path checks bound ordinary navigation; they do not sandbox a hostile local process
// concurrently replacing filesystem entries (Node has no portable openat confinement).
async function resolveWorkspacePath(root: string, relative: unknown) {
  if (
    typeof relative !== "string" ||
    relative.length > 4096 ||
    relative.includes("\0") ||
    path.isAbsolute(relative)
  )
    throw new Error("Invalid workspace-relative path");
  const base = await realpath(root);
  const candidate = path.resolve(base, relative);
  const inside = (target: string) => {
    const value = path.relative(base, target);
    if (
      value === ".." ||
      value.startsWith(`..${path.sep}`) ||
      path.isAbsolute(value)
    )
      throw new Error("Path is outside this workspace");
  };
  inside(candidate);
  const resolved = await realpath(candidate);
  inside(resolved);
  return {
    resolved,
    relative: path.relative(base, resolved).split(path.sep).join("/") || ".",
  };
}

export async function listWorkspaceFiles(
  root: string,
  relative: unknown,
): Promise<WorkspaceFileListing> {
  const target = await resolveWorkspacePath(root, relative);
  const entries: WorkspaceFileListing["entries"] = [];
  let truncated = false;
  const directory = await opendir(target.resolved);
  for await (const entry of directory) {
    // Symlinks are omitted; the viewer does not offer traversal outside cwd.
    if (!entry.isDirectory() && !entry.isFile()) continue;
    if (entries.length === 2000) {
      truncated = true;
      break;
    }
    entries.push({
      name: entry.name,
      path:
        target.relative === "."
          ? entry.name
          : `${target.relative}/${entry.name}`,
      kind: entry.isDirectory() ? "directory" : "file",
    });
  }
  entries.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
  return { path: target.relative, entries, truncated };
}

export async function readWorkspaceFile(
  root: string,
  relative: unknown,
): Promise<WorkspaceTextFile> {
  const target = await resolveWorkspacePath(root, relative);
  const handle = await open(target.resolved, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Only a regular file can be displayed");
    const limit = 1024 * 1024;
    if (stat.size > limit)
      throw new Error("File is too large to preview (1 MiB limit)");
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, null);
      if (chunk.bytesRead === 0) break;
      size += chunk.bytesRead;
    }
    if (size > limit)
      throw new Error("File is too large to preview (1 MiB limit)");
    if (bytes.subarray(0, size).includes(0))
      throw new Error("Binary files cannot be displayed as text");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, size),
      );
    } catch {
      throw new Error("Only UTF-8 text files can be displayed");
    }
    return {
      path: target.relative,
      text,
      revision: fileRevision(target.resolved, bytes.subarray(0, size)),
    };
  } finally {
    await handle.close();
  }
}

function fileRevision(resolved: string, bytes: Uint8Array) {
  return createHash("sha256")
    .update(resolved)
    .update("\0")
    .update(bytes)
    .digest("hex");
}

// Serialize this Host's saves to the same canonical file, including across Threads.
// External edits are checked immediately before atomic replacement; portable filesystems
// have no compare-and-swap, so this is optimistic conflict detection, not a file lock.
const saves = new Map<string, Promise<unknown>>();
export async function saveWorkspaceFile(
  root: string,
  relative: unknown,
  text: unknown,
  expectedRevision: unknown,
): Promise<WorkspaceFileSaveResult> {
  if (
    typeof text !== "string" ||
    text.includes("\0") ||
    Buffer.byteLength(text, "utf8") > 1024 * 1024
  )
    throw new Error("Only UTF-8 text up to 1 MiB can be saved");
  if (
    typeof expectedRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedRevision)
  )
    throw new Error("Read the file before saving");
  const target = await resolveWorkspacePath(root, relative);
  const previous = saves.get(target.resolved) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async (): Promise<WorkspaceFileSaveResult> => {
      const current = await readWorkspaceFile(root, relative);
      if (current.revision !== expectedRevision)
        return { status: "conflict", file: current };
      const temporary = path.join(
        path.dirname(target.resolved),
        `.zenx-save-${randomUUID()}.tmp`,
      );
      let created = false;
      try {
        const metadata = await stat(target.resolved);
        const handle = await open(temporary, "wx", metadata.mode);
        created = true;
        try {
          await handle.chmod(metadata.mode);
          await handle.writeFile(text, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        const latest = await readWorkspaceFile(root, relative);
        if (latest.revision !== expectedRevision)
          return { status: "conflict", file: latest };
        await rename(temporary, target.resolved);
        return {
          status: "saved",
          file: {
            path: target.relative,
            text,
            revision: fileRevision(target.resolved, Buffer.from(text, "utf8")),
          },
        };
      } finally {
        if (created) await rm(temporary, { force: true });
      }
    });
  saves.set(target.resolved, operation);
  try {
    return await operation;
  } finally {
    if (saves.get(target.resolved) === operation) saves.delete(target.resolved);
  }
}
