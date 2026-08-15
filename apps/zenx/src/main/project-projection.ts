import path from "node:path";

import type { Thread } from "../protocol-client/index.js";

export interface ZenXProjectProjectionEntry {
  key: string;
  workspace: string;
  configured: boolean;
  isDefault: boolean;
  threads: Thread[];
}

/** Stateless ZenX product view; it never owns Project or Thread state. */
export function projectZenXProjects(
  workspaces: readonly string[],
  defaultWorkspace: string,
  threads: readonly Thread[],
  platform: NodeJS.Platform = process.platform,
): ZenXProjectProjectionEntry[] {
  const projects = new Map<string, ZenXProjectProjectionEntry>();
  const defaultKey = projectPathKey(defaultWorkspace, platform);
  for (const workspace of workspaces) {
    const resolved = path.resolve(workspace);
    const key = projectPathKey(resolved, platform);
    if (!projects.has(key)) {
      projects.set(key, {
        key,
        workspace: resolved,
        configured: true,
        isDefault: key === defaultKey,
        threads: [],
      });
    }
  }
  for (const thread of threads) {
    if (thread.cwd.length === 0 || thread.status.type === "systemError")
      continue;
    const workspace = path.resolve(thread.cwd);
    const key = projectPathKey(workspace, platform);
    const project = projects.get(key) ?? {
      key,
      workspace,
      configured: false,
      isDefault: key === defaultKey,
      threads: [],
    };
    project.threads.push(thread);
    projects.set(key, project);
  }
  return [...projects.values()].sort((left, right) =>
    left.workspace.localeCompare(right.workspace),
  );
}

export function projectPathKey(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}
