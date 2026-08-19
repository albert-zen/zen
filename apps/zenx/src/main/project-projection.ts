import path from "node:path";

export interface ProjectProjectionThread {
  id: string;
  cwd: string | null;
}

export interface ZenXProjectProjectionEntry {
  key: string;
  workspace: string;
  configured: boolean;
  isDefault: boolean;
  threadIds: string[];
}

export interface ZenXProjectProjectionSnapshot {
  projects: ZenXProjectProjectionEntry[];
  unavailableThreadIds: string[];
  lastUsedWorkspace: string | null;
}

/** Shared ZenX product projection; it owns workspace configuration, never Project or Thread state. */
export class ZenXProjectProjection {
  readonly #platform: NodeJS.Platform;
  #workspaces: string[] = [];
  #defaultWorkspace: string | null = null;
  #lastUsedWorkspace: string | null = null;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.#platform = platform;
  }

  updateConfiguration(
    workspaces: readonly string[],
    defaultWorkspace: string | null,
    lastUsedWorkspace: string | null = null,
  ): void {
    const unique = new Map<string, string>();
    const candidates =
      defaultWorkspace === null
        ? workspaces
        : [defaultWorkspace, ...workspaces];
    for (const workspace of candidates) {
      const resolved = projectPath(workspace, this.#platform);
      const key = projectPathKey(resolved, this.#platform);
      if (!unique.has(key)) unique.set(key, resolved);
    }
    this.#workspaces = [...unique.values()];
    this.#defaultWorkspace =
      defaultWorkspace === null
        ? null
        : projectPath(defaultWorkspace, this.#platform);
    this.#lastUsedWorkspace =
      lastUsedWorkspace === null
        ? null
        : this.configuredWorkspace(lastUsedWorkspace);
  }

  project(
    threads: readonly ProjectProjectionThread[],
  ): ZenXProjectProjectionSnapshot {
    const projects = new Map<string, ZenXProjectProjectionEntry>();
    const defaultKey =
      this.#defaultWorkspace === null
        ? null
        : projectPathKey(this.#defaultWorkspace, this.#platform);
    for (const workspace of this.#workspaces) {
      const key = projectPathKey(workspace, this.#platform);
      projects.set(key, {
        key,
        workspace,
        configured: true,
        isDefault: key === defaultKey,
        threadIds: [],
      });
    }
    const unavailableThreadIds: string[] = [];
    for (const thread of threads) {
      if (thread.cwd === null || thread.cwd.trim().length === 0) {
        unavailableThreadIds.push(thread.id);
        continue;
      }
      const workspace = projectPath(thread.cwd, this.#platform);
      const key = projectPathKey(workspace, this.#platform);
      const project = projects.get(key) ?? {
        key,
        workspace,
        configured: false,
        isDefault: key === defaultKey,
        threadIds: [],
      };
      project.threadIds.push(thread.id);
      projects.set(key, project);
    }
    return {
      projects: [...projects.values()].sort((left, right) =>
        left.workspace.localeCompare(right.workspace),
      ),
      unavailableThreadIds,
      lastUsedWorkspace: this.#lastUsedWorkspace,
    };
  }

  configuredWorkspace(value: string): string | null {
    const key = projectPathKey(value, this.#platform);
    return (
      this.#workspaces.find(
        (workspace) => projectPathKey(workspace, this.#platform) === key,
      ) ?? null
    );
  }
}

export function projectPathKey(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = projectPath(value, platform);
  return platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function projectPath(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.win32.resolve(value) : path.resolve(value);
}
