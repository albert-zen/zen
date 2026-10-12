// Convert a link to the workspace-relative argument of the existing Host file reader.
// The Host resolves real paths and enforces the workspace boundary and file permissions.
export function messageFilePath(
  value: string,
  cwd: string | undefined,
): string {
  if (!cwd || !cwd.startsWith("/"))
    throw new Error("Thread workspace is unavailable");
  const base = cwd.replace(/\/+$/u, "") || "/";
  const absolute = value.startsWith("/") ? value : `${base}/${value}`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  const normalized = `/${parts.join("/")}`;
  if (normalized === base) throw new Error("Link points to a directory");
  if (base !== "/" && !normalized.startsWith(`${base}/`))
    throw new Error("File link is outside this Thread workspace");
  return base === "/" ? normalized.slice(1) : normalized.slice(base.length + 1);
}
