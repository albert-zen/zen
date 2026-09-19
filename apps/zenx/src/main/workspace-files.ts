import { open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceFileListing {
  path: string;
  entries: { name: string; path: string; kind: "directory" | "file" }[];
  truncated: boolean;
}
export interface WorkspaceTextFile {
  path: string;
  text: string;
}

// A bounded read-only view of the selected Thread's cwd, not a tool permission policy.
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
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, size),
      );
    } catch {
      throw new Error("Only UTF-8 text files can be displayed");
    }
    return { path: target.relative, text };
  } finally {
    await handle.close();
  }
}
