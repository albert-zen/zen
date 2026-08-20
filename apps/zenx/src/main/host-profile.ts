import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ZenXHostConfig } from "./host-messages.js";

export type ZenXProviderProfile =
  | { type: "fake"; displayName: string }
  | { type: "openai-subscription"; displayName: string }
  | {
      type: "openai-compatible";
      name: string;
      displayName: string;
      baseUrl: string;
    };

export interface ZenXSidebarOrder {
  projectKeys: string[];
  threadIdsByProject: Record<string, string[]>;
}

export interface ZenXHostProfile {
  version: 1;
  onboardingComplete: boolean;
  provider: ZenXProviderProfile;
  defaultModel: string;
  titleModel: string;
  models: string[];
  workspace: string | null;
  workspaces: string[];
  lastUsedWorkspace: string | null;
  approvalPolicy: "always" | "never";
  pinnedThreadIds: string[];
  sidebarOrder: ZenXSidebarOrder;
}

export type ZenXSettingsUpdate = Pick<
  ZenXHostProfile,
  | "onboardingComplete"
  | "provider"
  | "defaultModel"
  | "titleModel"
  | "models"
  | "approvalPolicy"
>;

export interface PublicHostSettings {
  profile: ZenXHostProfile;
  hasApiKey: boolean;
  subscription: {
    authenticated: boolean;
    expired: boolean;
    accountId?: string;
    expiresAt?: number;
  };
}

export class ZenXHostProfileStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async read(fallback: ZenXHostProfile): Promise<ZenXHostProfile> {
    return (await this.readOptional()) ?? fallback;
  }

  async readOptional(): Promise<ZenXHostProfile | undefined> {
    let handle;
    try {
      handle = await open(this.#filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile())
        throw new Error("ZenX host profile is not a regular file");
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      return validateHostProfile(value);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("ZenX host profile contains invalid JSON");
      throw error;
    } finally {
      await handle.close();
    }
  }

  async write(profile: ZenXHostProfile): Promise<void> {
    const validated = validateHostProfile(profile);
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#filePath);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}

export function validateHostProfile(value: unknown): ZenXHostProfile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.provider)) {
    throw new Error("ZenX host profile is invalid");
  }
  const provider = validateProvider(value.provider);
  const defaultModel = nonEmpty(value.defaultModel, "default model");
  const titleModel =
    value.titleModel === undefined
      ? "gpt-5.6-luna"
      : nonEmpty(value.titleModel, "title model");
  if (!Array.isArray(value.models))
    throw new Error("ZenX model list is invalid");
  const models = [
    ...new Set(value.models.map((model) => nonEmpty(model, "model"))),
  ];
  if (models.length === 0 || !models.includes(defaultModel)) {
    throw new Error("ZenX model list must include the default model");
  }
  if (value.approvalPolicy !== "always" && value.approvalPolicy !== "never") {
    throw new Error("ZenX approval policy is invalid");
  }
  const workspace =
    value.workspace === null
      ? null
      : path.resolve(nonEmpty(value.workspace, "workspace"));
  const workspaces = normalizeWorkspaces(value.workspaces, workspace);
  const lastUsedWorkspace = normalizeLastUsedWorkspace(
    value.lastUsedWorkspace,
    workspaces,
  );
  const pinnedThreadIds = normalizePinnedThreadIds(value.pinnedThreadIds);
  const sidebarOrder = normalizeSidebarOrder(value.sidebarOrder);
  return {
    version: 1,
    onboardingComplete: value.onboardingComplete === true,
    provider,
    defaultModel,
    titleModel,
    models,
    workspace,
    workspaces,
    lastUsedWorkspace,
    approvalPolicy: value.approvalPolicy,
    pinnedThreadIds,
    sidebarOrder,
  };
}

function normalizeSidebarOrder(value: unknown): ZenXSidebarOrder {
  if (value === undefined) {
    return { projectKeys: [], threadIdsByProject: {} };
  }
  if (!isRecord(value) || !isRecord(value.threadIdsByProject)) {
    throw new Error("ZenX Sidebar order is invalid");
  }
  const projectKeys = normalizeOrderIdentifiers(
    value.projectKeys,
    "Project key",
    32_768,
  );
  const entries = Object.entries(value.threadIdsByProject);
  if (entries.length > 4_096) {
    throw new Error("ZenX Sidebar Thread order is invalid");
  }
  let totalThreadIds = 0;
  const threadIdsByProject = Object.fromEntries(
    entries.map(([projectKey, threadIds]) => {
      const normalizedProjectKey = normalizeOrderIdentifier(
        projectKey,
        "Project key",
        32_768,
      );
      const normalizedThreadIds = normalizeOrderIdentifiers(
        threadIds,
        "Thread id",
        512,
      );
      totalThreadIds += normalizedThreadIds.length;
      if (totalThreadIds > 4_096) {
        throw new Error("ZenX Sidebar Thread order is invalid");
      }
      return [normalizedProjectKey, normalizedThreadIds] as const;
    }),
  );
  return { projectKeys, threadIdsByProject };
}

function normalizeOrderIdentifiers(
  value: unknown,
  label: string,
  maxLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > 4_096) {
    throw new Error(`ZenX Sidebar ${label} list is invalid`);
  }
  return [
    ...new Set(
      value.map((entry) => normalizeOrderIdentifier(entry, label, maxLength)),
    ),
  ];
}

function normalizeOrderIdentifier(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`ZenX Sidebar ${label} is invalid`);
  }
  const identifier = value.trim();
  if (identifier.length === 0 || identifier.length > maxLength) {
    throw new Error(`ZenX Sidebar ${label} is invalid`);
  }
  return identifier;
}

function normalizePinnedThreadIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4_096) {
    throw new Error("ZenX pinned Thread list is invalid");
  }
  return [
    ...new Set(
      value.map((entry) => {
        if (typeof entry !== "string")
          throw new Error("ZenX pinned Thread id is invalid");
        const threadId = entry.trim();
        if (threadId.length === 0 || threadId.length > 512)
          throw new Error("ZenX pinned Thread id is invalid");
        return threadId;
      }),
    ),
  ];
}

function normalizeLastUsedWorkspace(
  value: unknown,
  workspaces: readonly string[],
): string | null {
  if (value === undefined || value === null) return null;
  const key = workspaceKey(nonEmpty(value, "last used workspace"));
  return (
    workspaces.find((workspace) => workspaceKey(workspace) === key) ?? null
  );
}

function normalizeWorkspaces(
  value: unknown,
  workspace: string | null,
): string[] {
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error("ZenX workspace list is invalid");
  }
  const candidates = ((value ?? []) as unknown[]).map((entry) =>
    path.resolve(nonEmpty(entry, "workspace")),
  );
  if (workspace !== null) candidates.unshift(workspace);
  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    const key = workspaceKey(candidate);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

export function workspaceKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function hostConfigFromProfile(
  profile: ZenXHostProfile,
  options: {
    dataDirectory: string;
    subscriptionProfilePath: string;
    fallbackWorkspace: string;
    apiKey?: string;
  },
): ZenXHostConfig {
  const common = {
    cwd: profile.workspace ?? path.resolve(options.fallbackWorkspace),
    dataDirectory: options.dataDirectory,
    model: profile.defaultModel,
    models: profile.models,
    approvalPolicy: profile.approvalPolicy,
  } as const;
  if (profile.provider.type === "fake")
    return { ...common, provider: { type: "fake" } };
  if (profile.provider.type === "openai-subscription") {
    return {
      ...common,
      provider: {
        type: "openai-subscription",
        profilePath: options.subscriptionProfilePath,
      },
    };
  }
  if (options.apiKey === undefined || options.apiKey.length === 0) {
    throw new Error("Add an API key before activating this provider");
  }
  return {
    ...common,
    provider: {
      type: "openai-compatible",
      baseUrl: profile.provider.baseUrl,
      apiKey: options.apiKey,
      name: profile.provider.name,
    },
    secretEnvironmentVariables: [],
  };
}

function validateProvider(value: Record<string, unknown>): ZenXProviderProfile {
  const displayName = nonEmpty(value.displayName, "provider display name");
  if (value.type === "fake") return { type: "fake", displayName };
  if (value.type === "openai-subscription") {
    return { type: "openai-subscription", displayName };
  }
  if (value.type !== "openai-compatible")
    throw new Error("ZenX provider type is invalid");
  const baseUrl = nonEmpty(value.baseUrl, "base URL");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("ZenX provider base URL is invalid");
  }
  if (
    parsed.protocol !== "https:" &&
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "localhost"
  ) {
    throw new Error(
      "ZenX provider base URL must use HTTPS (loopback HTTP is allowed)",
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("ZenX provider base URL must not contain credentials");
  }
  return {
    type: "openai-compatible",
    name: nonEmpty(value.name, "provider name"),
    displayName,
    baseUrl: parsed.toString().replace(/\/$/u, ""),
  };
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`ZenX ${label} is required`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
