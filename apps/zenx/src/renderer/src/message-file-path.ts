// Convert a link to the workspace-relative argument of the existing Host file reader.
// The Host resolves real paths and enforces the workspace boundary and file permissions.
export function messageFilePath(
  value: string,
  cwd: string | undefined,
): string {
  if (!cwd || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error("Thread workspace is unavailable");
  if (/^(?:\\\\|\/\/)/u.test(value))
    throw new Error("Network file links are not supported");
  const windows = /^[a-z]:[\\/]/iu.test(cwd);
  if (!windows && !cwd.startsWith("/"))
    throw new Error("Thread workspace is unavailable");
  const normalize = (path: string) => {
    const parts: string[] = [];
    for (const segment of path.split("/")) {
      if (segment === "..") parts.pop();
      else if (segment && segment !== ".") parts.push(segment);
    }
    return parts.join("/");
  };
  if (windows) {
    const base = cwd.replace(/\\/gu, "/").replace(/\/+$/u, "");
    const target = value.replace(/\\/gu, "/");
    if (target.startsWith("/") || /^[a-z]:(?!\/)/iu.test(target))
      throw new Error("File link is outside this Thread workspace");
    const drive = base.slice(0, 2);
    const absolute = /^[a-z]:\//iu.test(target) ? target : `${base}/${target}`;
    if (
      absolute.slice(0, 2).toLowerCase() !== drive.toLowerCase() ||
      /[:]/u.test(absolute.slice(2))
    )
      throw new Error("File link is outside this Thread workspace");
    const root = normalize(base.slice(2));
    const path = normalize(absolute.slice(2));
    if (path.toLowerCase() === root.toLowerCase())
      throw new Error("Link points to a directory");
    if (root && !path.toLowerCase().startsWith(`${root.toLowerCase()}/`))
      throw new Error("File link is outside this Thread workspace");
    return root ? path.slice(root.length + 1) : path;
  }
  if (/^[a-z]:/iu.test(value) || value.startsWith("\\"))
    throw new Error("File link is outside this Thread workspace");
  const base = cwd.replace(/\/+$/u, "") || "/";
  const absolute = value.startsWith("/") ? value : `${base}/${value}`;
  const normalized = `/${normalize(absolute)}`;
  if (normalized === base) throw new Error("Link points to a directory");
  if (base !== "/" && !normalized.startsWith(`${base}/`))
    throw new Error("File link is outside this Thread workspace");
  return base === "/" ? normalized.slice(1) : normalized.slice(base.length + 1);
}
