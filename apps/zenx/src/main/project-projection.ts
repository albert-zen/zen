import { realpath } from "node:fs/promises";
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

type ProjectRealpath = (candidate: string) => Promise<string>;

interface ProjectPathIdentity {
  displayPath: string;
  key: string;
}

const nodeProjectRealpath: ProjectRealpath = async (candidate) =>
  await realpath(candidate);

/** Shared ZenX product projection; it owns workspace configuration, never Project or Thread state. */
export class ZenXProjectProjection {
  readonly #platform: NodeJS.Platform;
  readonly #realpath: ProjectRealpath;
  #workspaces: ProjectPathIdentity[] = [];
  #defaultKey: string | null = null;
  #lastUsedWorkspace: string | null = null;

  constructor(
    platform: NodeJS.Platform = process.platform,
    resolveRealpath: ProjectRealpath = nodeProjectRealpath,
  ) {
    this.#platform = platform;
    this.#realpath = resolveRealpath;
  }

  async updateConfiguration(
    workspaces: readonly string[],
    defaultWorkspace: string | null,
    lastUsedWorkspace: string | null = null,
  ): Promise<void> {
    const unique = new Map<string, ProjectPathIdentity>();
    const candidates =
      defaultWorkspace === null
        ? workspaces
        : [defaultWorkspace, ...workspaces];
    for (const workspace of await Promise.all(
      candidates.map(
        async (candidate) =>
          await projectPathIdentity(candidate, this.#platform, this.#realpath),
      ),
    )) {
      if (!unique.has(workspace.key)) unique.set(workspace.key, workspace);
    }
    const nextWorkspaces = [...unique.values()];
    const nextDefaultKey =
      defaultWorkspace === null
        ? null
        : (
            await projectPathIdentity(
              defaultWorkspace,
              this.#platform,
              this.#realpath,
            )
          ).key;
    const lastUsedKey =
      lastUsedWorkspace === null
        ? null
        : (
            await projectPathIdentity(
              lastUsedWorkspace,
              this.#platform,
              this.#realpath,
            )
          ).key;
    const nextLastUsedWorkspace =
      lastUsedKey === null
        ? null
        : (nextWorkspaces.find((workspace) => workspace.key === lastUsedKey)
            ?.displayPath ?? null);
    this.#workspaces = nextWorkspaces;
    this.#defaultKey = nextDefaultKey;
    this.#lastUsedWorkspace = nextLastUsedWorkspace;
  }

  async project(
    threads: readonly ProjectProjectionThread[],
  ): Promise<ZenXProjectProjectionSnapshot> {
    const configuredWorkspaces = this.#workspaces;
    const defaultKey = this.#defaultKey;
    const lastUsedWorkspace = this.#lastUsedWorkspace;
    const projects = new Map<string, ZenXProjectProjectionEntry>();
    for (const workspace of configuredWorkspaces) {
      projects.set(workspace.key, {
        key: workspace.key,
        workspace: workspace.displayPath,
        configured: true,
        isDefault: workspace.key === defaultKey,
        threadIds: [],
      });
    }
    const unavailableThreadIds: string[] = [];
    const resolvedThreads = await Promise.all(
      threads.map(async (thread) => ({
        thread,
        identity:
          thread.cwd === null || thread.cwd.trim().length === 0
            ? null
            : await projectPathIdentity(
                thread.cwd,
                this.#platform,
                this.#realpath,
              ),
      })),
    );
    for (const { thread, identity } of resolvedThreads) {
      if (identity === null) {
        unavailableThreadIds.push(thread.id);
        continue;
      }
      const project = projects.get(identity.key) ?? {
        key: identity.key,
        workspace: identity.displayPath,
        configured: false,
        isDefault: identity.key === defaultKey,
        threadIds: [],
      };
      project.threadIds.push(thread.id);
      projects.set(identity.key, project);
    }
    return {
      projects: [...projects.values()].sort((left, right) =>
        left.workspace.localeCompare(right.workspace),
      ),
      unavailableThreadIds,
      lastUsedWorkspace,
    };
  }

  async configuredWorkspace(value: string): Promise<string | null> {
    const key = await this.canonicalKey(value);
    return (
      this.#workspaces.find((workspace) => workspace.key === key)
        ?.displayPath ?? null
    );
  }

  async canonicalKey(value: string): Promise<string> {
    return (await projectPathIdentity(value, this.#platform, this.#realpath))
      .key;
  }
}

export async function projectPathKey(
  value: string,
  platform: NodeJS.Platform = process.platform,
  resolveRealpath: ProjectRealpath = nodeProjectRealpath,
): Promise<string> {
  return (await projectPathIdentity(value, platform, resolveRealpath)).key;
}

async function projectPathIdentity(
  value: string,
  platform: NodeJS.Platform,
  resolveRealpath: ProjectRealpath,
): Promise<ProjectPathIdentity> {
  const pathApi = platform === "win32" ? path.win32 : path;
  const displayPath = pathApi.resolve(value);
  const unresolved: string[] = [];
  let cursor = displayPath;
  let canonicalPath: string | undefined;

  while (canonicalPath === undefined) {
    try {
      canonicalPath = await resolveRealpath(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        canonicalPath = displayPath;
        unresolved.length = 0;
        break;
      }
      const parent = pathApi.dirname(cursor);
      if (parent === cursor) {
        canonicalPath = cursor;
        break;
      }
      unresolved.unshift(pathApi.basename(cursor));
      cursor = parent;
    }
  }

  const physicalPath = pathApi.normalize(
    pathApi.join(canonicalPath, ...unresolved),
  );
  return {
    displayPath,
    key:
      platform === "win32"
        ? physicalPath.toLocaleLowerCase("en-US")
        : physicalPath,
  };
}
