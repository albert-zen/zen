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

export type ProjectRealpath = (candidate: string) => Promise<string>;

export interface ProjectPathIdentity {
  readonly displayPath: string;
  readonly key: string;
}

export type ProjectPathSnapshot = readonly ProjectPathIdentity[];

interface ProjectConfigurationSnapshot {
  readonly workspaces: readonly string[];
  readonly defaultWorkspace: string | null;
  readonly lastUsedWorkspace: string | null;
}

const nodeProjectRealpath: ProjectRealpath = async (candidate) =>
  await realpath(candidate);

/** Shared ZenX product projection; it owns workspace configuration, never Project or Thread state. */
export class ZenXProjectProjection {
  readonly #platform: NodeJS.Platform;
  readonly #realpath: ProjectRealpath;
  #configuration: ProjectConfigurationSnapshot = Object.freeze({
    workspaces: Object.freeze([]),
    defaultWorkspace: null,
    lastUsedWorkspace: null,
  });
  #configurationRevision = 0;

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
    const revision = ++this.#configurationRevision;
    const unique = new Map<string, ProjectPathIdentity>();
    const candidates =
      defaultWorkspace === null
        ? workspaces
        : [defaultWorkspace, ...workspaces];
    const values = [
      ...candidates,
      ...(lastUsedWorkspace === null ? [] : [lastUsedWorkspace]),
    ];
    const identities = await this.#canonicalSnapshot(values);
    const workspaceIdentities = identities.slice(0, candidates.length);
    for (const workspace of workspaceIdentities) {
      if (!unique.has(workspace.key)) unique.set(workspace.key, workspace);
    }
    const nextWorkspaces = [...unique.values()].map(
      (workspace) => workspace.displayPath,
    );
    const nextDefaultKey =
      defaultWorkspace === null ? null : workspaceIdentities[0]?.key;
    const nextDefaultWorkspace =
      nextDefaultKey === null || nextDefaultKey === undefined
        ? null
        : (unique.get(nextDefaultKey)?.displayPath ?? null);
    const lastUsedIdentity =
      lastUsedWorkspace === null ? undefined : identities.at(-1);
    const lastUsedKey =
      lastUsedWorkspace === null ? null : (lastUsedIdentity?.key ?? null);
    const nextLastUsedWorkspace =
      lastUsedKey === null
        ? null
        : (unique.get(lastUsedKey)?.displayPath ?? null);
    if (revision !== this.#configurationRevision) return;
    this.#configuration = Object.freeze({
      workspaces: Object.freeze(nextWorkspaces),
      defaultWorkspace: nextDefaultWorkspace,
      lastUsedWorkspace: nextLastUsedWorkspace,
    });
  }

  async project(
    threads: readonly ProjectProjectionThread[],
  ): Promise<ZenXProjectProjectionSnapshot> {
    const configuration = this.#configuration;
    const availableThreads = threads.filter(
      (thread): thread is ProjectProjectionThread & { cwd: string } =>
        thread.cwd !== null && thread.cwd.trim().length > 0,
    );
    const defaultIndex =
      configuration.defaultWorkspace === null
        ? undefined
        : configuration.workspaces.length;
    const lastUsedIndex =
      configuration.lastUsedWorkspace === null
        ? undefined
        : configuration.workspaces.length +
          (defaultIndex === undefined ? 0 : 1);
    const threadOffset =
      configuration.workspaces.length +
      (defaultIndex === undefined ? 0 : 1) +
      (lastUsedIndex === undefined ? 0 : 1);
    const identities = await this.#canonicalSnapshot([
      ...configuration.workspaces,
      ...(configuration.defaultWorkspace === null
        ? []
        : [configuration.defaultWorkspace]),
      ...(configuration.lastUsedWorkspace === null
        ? []
        : [configuration.lastUsedWorkspace]),
      ...availableThreads.map((thread) => thread.cwd),
    ]);
    const configuredWorkspaces = identities.slice(
      0,
      configuration.workspaces.length,
    );
    const defaultKey =
      defaultIndex === undefined
        ? null
        : (identities[defaultIndex]?.key ?? null);
    const projects = new Map<string, ZenXProjectProjectionEntry>();
    for (const workspace of configuredWorkspaces) {
      if (projects.has(workspace.key)) continue;
      projects.set(workspace.key, {
        key: workspace.key,
        workspace: workspace.displayPath,
        configured: true,
        isDefault: workspace.key === defaultKey,
        threadIds: [],
      });
    }
    const unavailableThreadIds: string[] = [];
    let availableThreadIndex = 0;
    const resolvedThreads = threads.map((thread) => {
      if (thread.cwd === null || thread.cwd.trim().length === 0) {
        return { thread, identity: null };
      }
      const identity = identities[threadOffset + availableThreadIndex] ?? null;
      availableThreadIndex += 1;
      return { thread, identity };
    });
    for (const { thread, identity } of resolvedThreads) {
      if (identity === null) {
        unavailableThreadIds.push(thread.id);
        continue;
      }
      const project = projects.get(identity.key) ?? {
        key: identity.key,
        workspace: identity.displayPath,
        configured: true,
        isDefault: identity.key === defaultKey,
        threadIds: [],
      };
      project.threadIds.push(thread.id);
      projects.set(identity.key, project);
    }
    const lastUsedKey =
      lastUsedIndex === undefined
        ? null
        : (identities[lastUsedIndex]?.key ?? null);
    const resolvedLastUsedWorkspace =
      lastUsedKey === null || !projects.get(lastUsedKey)?.configured
        ? null
        : (projects.get(lastUsedKey)?.workspace ?? null);
    return {
      projects: [...projects.values()].sort((left, right) =>
        left.workspace.localeCompare(right.workspace),
      ),
      unavailableThreadIds,
      lastUsedWorkspace: resolvedLastUsedWorkspace,
    };
  }

  async configuredWorkspace(value: string): Promise<string | null> {
    const configuration = this.#configuration;
    const identities = await this.#canonicalSnapshot([
      ...configuration.workspaces,
      value,
    ]);
    const requested = identities.at(-1);
    if (requested === undefined) return null;
    return (
      identities
        .slice(0, configuration.workspaces.length)
        .find((workspace) => workspace.key === requested.key)?.displayPath ??
      null
    );
  }

  async canonicalKey(value: string): Promise<string> {
    return (await this.canonicalKeys([value]))[0]!;
  }

  async canonicalKeys(values: readonly string[]): Promise<readonly string[]> {
    return Object.freeze(
      (await this.#canonicalSnapshot(values)).map((identity) => identity.key),
    );
  }

  async #canonicalSnapshot(
    values: readonly string[],
  ): Promise<ProjectPathSnapshot> {
    return await projectPathSnapshot(values, this.#platform, this.#realpath);
  }
}

export async function projectPathKey(
  value: string,
  platform: NodeJS.Platform = process.platform,
  resolveRealpath: ProjectRealpath = nodeProjectRealpath,
): Promise<string> {
  return (await projectPathSnapshot([value], platform, resolveRealpath))[0]!
    .key;
}

export async function projectPathSnapshot(
  values: readonly string[],
  platform: NodeJS.Platform = process.platform,
  resolveRealpath: ProjectRealpath = nodeProjectRealpath,
): Promise<ProjectPathSnapshot> {
  const pathApi = projectPathApi(platform);
  const pending = new Map<string, Promise<string>>();
  const identities = await Promise.all(
    values.map(async (value) => {
      const displayPath = pathApi.resolve(value);
      const lexicalKey =
        platform === "win32"
          ? displayPath.toLocaleLowerCase("en-US")
          : displayPath;
      let key = pending.get(lexicalKey);
      if (key === undefined) {
        key = projectPathIdentity(displayPath, platform, resolveRealpath).then(
          (identity) => identity.key,
        );
        pending.set(lexicalKey, key);
      }
      return Object.freeze({ displayPath, key: await key });
    }),
  );
  return Object.freeze(identities);
}

async function projectPathIdentity(
  value: string,
  platform: NodeJS.Platform,
  resolveRealpath: ProjectRealpath,
): Promise<ProjectPathIdentity> {
  const pathApi = projectPathApi(platform);
  const displayPath = pathApi.resolve(value);
  const unresolved: string[] = [];
  let cursor = displayPath;
  let canonicalPath: string | undefined;
  let shouldRecheck = false;

  while (canonicalPath === undefined) {
    try {
      canonicalPath = await resolveRealpath(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        canonicalPath = displayPath;
        unresolved.length = 0;
        shouldRecheck = true;
        break;
      }
      const parent = pathApi.dirname(cursor);
      if (parent === cursor) {
        canonicalPath = cursor;
        break;
      }
      unresolved.unshift(pathApi.basename(cursor));
      cursor = parent;
      shouldRecheck = true;
    }
  }

  if (shouldRecheck) {
    try {
      canonicalPath = await resolveRealpath(displayPath);
      unresolved.length = 0;
    } catch {
      // Keep the bounded first result; a later operation will canonicalize again.
    }
  }

  const physicalPath = pathApi.normalize(
    pathApi.join(canonicalPath, ...unresolved),
  );
  return Object.freeze({
    displayPath,
    key:
      platform === "win32"
        ? physicalPath.toLocaleLowerCase("en-US")
        : physicalPath,
  });
}

export function resolveProjectPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return projectPathApi(platform).resolve(value);
}

function projectPathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}
