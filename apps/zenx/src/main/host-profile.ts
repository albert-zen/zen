import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  builtInModelCatalogPreset,
  legacyModelCatalogEntries,
} from "../../../../apps/cli/src/model-presets.js";
import {
  normalizeModelCatalogEntry,
  type ModelCatalogEntry,
  type ModelCatalogEntryInput,
} from "../../../../src/model-catalog.js";
import type { ZenXHostConfig } from "./host-messages.js";
import { resolveProjectPath } from "./project-projection.js";

export type ZenXProviderConnection =
  | { type: "fake"; displayName: string }
  | { type: "openai-subscription"; displayName: string }
  | {
      type: "openai-compatible";
      name: string;
      displayName: string;
      baseUrl: string;
    };

export type ZenXProviderProfile = ZenXProviderConnection & {
  providerProfileId: string;
  models: ZenXModelCatalogEntry[];
};

export type ZenXModelCatalogEntry = Omit<ModelCatalogEntry, "isDefault">;

export interface ZenXModelReference {
  providerProfileId: string;
  modelId: string;
}

export interface ZenXSidebarOrder {
  projectKeys: string[];
  threadIdsByProject: Record<string, string[]>;
}

export interface ZenXHostProfile {
  version: 3;
  onboardingComplete: boolean;
  providerProfiles: ZenXProviderProfile[];
  defaultModel: ZenXModelReference;
  titleModel: ZenXModelReference;
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
  | "providerProfiles"
  | "defaultModel"
  | "titleModel"
  | "approvalPolicy"
>;

export interface ZenXProviderEditOptions {
  defaultModel?: ZenXModelReference;
  titleModel?: ZenXModelReference;
  apiKey?: string;
}

export type ZenXProviderDeleteReplacements = Omit<
  ZenXProviderEditOptions,
  "apiKey"
>;

export interface PublicHostSettings {
  profile: ZenXHostProfile;
  /** Credential presence for the profile referenced by defaultModel. */
  hasApiKey: boolean;
  apiKeyProviderProfileIds: string[];
  /** The sole configured OpenAI subscription profile, when present. */
  subscriptionProviderProfileId: string | null;
  subscription: {
    authenticated: boolean;
    expired: boolean;
    accountId?: string;
    expiresAt?: number;
  };
}

interface LegacyHostProfileV1 {
  version: 1;
  onboardingComplete?: unknown;
  provider: Record<string, unknown>;
  defaultModel: unknown;
  titleModel?: unknown;
  models: unknown;
  workspace: unknown;
  workspaces?: unknown;
  lastUsedWorkspace?: unknown;
  approvalPolicy: unknown;
  pinnedThreadIds?: unknown;
  sidebarOrder?: unknown;
}

interface LegacyHostProfileV2 {
  version: 2;
  onboardingComplete?: unknown;
  providerProfiles: unknown;
  defaultModel: unknown;
  titleModel: unknown;
  workspace: unknown;
  workspaces?: unknown;
  lastUsedWorkspace?: unknown;
  approvalPolicy: unknown;
  pinnedThreadIds?: unknown;
  sidebarOrder?: unknown;
}

const MAX_PROVIDER_PROFILE_ID_LENGTH = 512;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_PROVIDER_PROFILES = 128;
const MAX_MODELS_PER_PROFILE = 1_024;

export class ZenXHostProfileStore {
  readonly #filePath: string;
  readonly #projectPlatform: NodeJS.Platform;

  constructor(
    filePath: string,
    projectPlatform: NodeJS.Platform = process.platform,
  ) {
    this.#filePath = path.resolve(filePath);
    this.#projectPlatform = projectPlatform;
  }

  async read(fallback: ZenXHostProfile): Promise<ZenXHostProfile> {
    return (
      (await this.readOptional()) ??
      validateHostProfile(fallback, this.#projectPlatform)
    );
  }

  async readOptional(): Promise<ZenXHostProfile | undefined> {
    let handle;
    try {
      handle = await open(this.#filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile())
        throw new Error("ZenX host profile is not a regular file");
      value = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("ZenX host profile contains invalid JSON");
      throw error;
    } finally {
      await handle.close();
    }

    const migratedV1 = isLegacyHostProfile(value);
    const migratedV2 = isLegacyHostProfileV2(value);
    const migrated = migratedV1 || migratedV2;
    const decoded = migratedV1
      ? migrateLegacyHostProfile(value, this.#projectPlatform)
      : migratedV2
        ? migrateHostProfileV2(value, this.#projectPlatform)
        : validateHostProfile(value, this.#projectPlatform);
    const profile = applyBuiltInModelCatalogPresets(
      decoded,
      this.#projectPlatform,
    );
    if (migrated || JSON.stringify(profile) !== JSON.stringify(decoded)) {
      await this.write(profile);
    }
    return profile;
  }

  async write(profile: ZenXHostProfile): Promise<void> {
    const validated = validateHostProfile(profile, this.#projectPlatform);
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

export function validateHostProfile(
  value: unknown,
  projectPlatform: NodeJS.Platform = process.platform,
): ZenXHostProfile {
  if (!isRecord(value) || value.version !== 3) {
    throw new Error("ZenX host profile is invalid");
  }
  if (
    !Array.isArray(value.providerProfiles) ||
    value.providerProfiles.length === 0 ||
    value.providerProfiles.length > MAX_PROVIDER_PROFILES
  ) {
    throw new Error("ZenX Provider profile list is invalid");
  }
  const providerProfiles = value.providerProfiles.map(validateProviderProfile);
  const profileIds = providerProfiles.map(
    (profile) => profile.providerProfileId,
  );
  if (new Set(profileIds).size !== profileIds.length) {
    throw new Error("ZenX Provider profile ids must be unique");
  }
  const defaultModel = validateModelReference(value.defaultModel, "default");
  const titleModel = validateModelReference(value.titleModel, "title");
  validateModelReferenceExists(defaultModel, providerProfiles, "default");
  validateModelReferenceExists(titleModel, providerProfiles, "title");
  const configuredDefault = providerProfiles
    .find(
      (profile) => profile.providerProfileId === defaultModel.providerProfileId,
    )!
    .models.find((model) => model.id === defaultModel.modelId)!;
  validateRunnableModel(configuredDefault, "default");
  const configuredTitle = providerProfiles
    .find(
      (profile) => profile.providerProfileId === titleModel.providerProfileId,
    )!
    .models.find((model) => model.id === titleModel.modelId)!;
  validateRunnableModel(configuredTitle, "title");
  if (value.approvalPolicy !== "always" && value.approvalPolicy !== "never") {
    throw new Error("ZenX approval policy is invalid");
  }
  const workspace =
    value.workspace === null
      ? null
      : resolveProjectPath(
          nonEmpty(value.workspace, "workspace"),
          projectPlatform,
        );
  const workspaces = normalizeWorkspaces(
    value.workspaces,
    workspace,
    projectPlatform,
  );
  const lastUsedWorkspace = normalizeLastUsedWorkspace(
    value.lastUsedWorkspace,
    workspaces,
    projectPlatform,
  );
  return {
    version: 3,
    onboardingComplete: value.onboardingComplete === true,
    providerProfiles,
    defaultModel,
    titleModel,
    workspace,
    workspaces,
    lastUsedWorkspace,
    approvalPolicy: value.approvalPolicy,
    pinnedThreadIds: normalizePinnedThreadIds(value.pinnedThreadIds),
    sidebarOrder: normalizeSidebarOrder(value.sidebarOrder),
  };
}

function validateRunnableModel(
  model: ZenXModelCatalogEntry,
  label: "default" | "title",
): void {
  if (model.defaultReasoningEffort === null) {
    throw new Error(
      `ZenX ${label} model requires a known default reasoning effort or manual override`,
    );
  }
  if (model.supportedReasoningEfforts === null) {
    throw new Error(
      `ZenX ${label} model requires known supported reasoning efforts or manual override`,
    );
  }
  if (
    model.inputModalities === null ||
    !model.inputModalities.includes("text")
  ) {
    throw new Error(
      `ZenX ${label} model requires known text input modalities or manual override`,
    );
  }
}

export function migratedProviderProfileId(
  provider: ZenXProviderConnection,
): string {
  if (provider.type === "fake") return "fake";
  if (provider.type === "openai-subscription") return "openai-codex";
  return provider.name;
}

export function migrateLegacyHostProfile(
  value: unknown,
  projectPlatform: NodeJS.Platform = process.platform,
): ZenXHostProfile {
  if (!isLegacyHostProfile(value)) {
    throw new Error("ZenX legacy host profile is invalid");
  }
  const provider = validateProviderConnection(value.provider);
  const providerProfileId = providerProfileIdentifier(
    migratedProviderProfileId(provider),
  );
  const defaultModel = modelIdentifier(value.defaultModel);
  const titleModel =
    value.titleModel === undefined
      ? "gpt-5.6-luna"
      : modelIdentifier(value.titleModel);
  const models = validateModelList(value.models);
  if (!models.includes(defaultModel)) {
    throw new Error("ZenX model list must include the default model");
  }
  // v1 allowed an independent title model outside its selectable catalog.
  if (!models.includes(titleModel)) models.push(titleModel);
  return migrateHostProfileV2(
    {
      version: 2,
      onboardingComplete: value.onboardingComplete === true,
      providerProfiles: [{ ...provider, providerProfileId, models }],
      defaultModel: { providerProfileId, modelId: defaultModel },
      titleModel: { providerProfileId, modelId: titleModel },
      workspace: value.workspace,
      workspaces: value.workspaces,
      lastUsedWorkspace: value.lastUsedWorkspace,
      approvalPolicy: value.approvalPolicy,
      pinnedThreadIds: value.pinnedThreadIds,
      sidebarOrder: value.sidebarOrder,
    },
    projectPlatform,
  );
}

export function migrateHostProfileV2(
  value: unknown,
  projectPlatform: NodeJS.Platform = process.platform,
): ZenXHostProfile {
  if (!isLegacyHostProfileV2(value)) {
    throw new Error("ZenX v2 host profile is invalid");
  }
  if (
    !Array.isArray(value.providerProfiles) ||
    value.providerProfiles.length === 0 ||
    value.providerProfiles.length > MAX_PROVIDER_PROFILES
  ) {
    throw new Error("ZenX Provider profile list is invalid");
  }
  const legacyProfiles = value.providerProfiles.map(
    validateLegacyProviderProfileV2,
  );
  const profileIds = legacyProfiles.map((profile) => profile.providerProfileId);
  if (new Set(profileIds).size !== profileIds.length) {
    throw new Error("ZenX Provider profile ids must be unique");
  }
  return validateHostProfile(
    {
      ...value,
      version: 3,
      providerProfiles: legacyProfiles.map((profile) => ({
        ...profile,
        models: structuredLegacyModelCatalog(profile.type, profile.models),
      })),
    },
    projectPlatform,
  );
}

export function hostConfigFromProfile(
  profile: ZenXHostProfile,
  options: {
    dataDirectory: string;
    subscriptionProfilePath: string;
    subscriptionProfilePaths?: Readonly<Record<string, string | undefined>>;
    fallbackWorkspace: string;
    apiKeys?: Readonly<Record<string, string | undefined>>;
  },
): ZenXHostConfig {
  const validated = validateHostProfile(profile);
  return {
    cwd: validated.workspace ?? path.resolve(options.fallbackWorkspace),
    dataDirectory: options.dataDirectory,
    approvalPolicy: validated.approvalPolicy,
    providers: validated.providerProfiles.map((providerProfile) => ({
      ...providerRuntimeCatalog(providerProfile, validated.defaultModel),
      providerProfileId: providerProfile.providerProfileId,
      provider: hostProviderFromProfile(providerProfile, options),
    })),
    defaultSelection: validated.defaultModel,
    secretEnvironmentVariables: [],
  };
}

function providerRuntimeCatalog(
  profile: ZenXProviderProfile,
  defaultModel: ZenXModelReference,
): {
  model: string;
  modelCatalog: ModelCatalogEntryInput[];
} {
  const model =
    defaultModel.providerProfileId === profile.providerProfileId
      ? defaultModel.modelId
      : profile.models[0]!.id;
  return {
    model,
    modelCatalog: profile.models.map((entry) => ({
      ...entry,
      isDefault: entry.id === model,
    })),
  };
}

function hostProviderFromProfile(
  profile: ZenXProviderProfile,
  options: {
    subscriptionProfilePath: string;
    subscriptionProfilePaths?: Readonly<Record<string, string | undefined>>;
    apiKeys?: Readonly<Record<string, string | undefined>>;
  },
) {
  if (profile.type === "fake") return { type: "fake" as const };
  if (profile.type === "openai-subscription") {
    return {
      type: "openai-subscription" as const,
      profilePath:
        options.subscriptionProfilePaths?.[profile.providerProfileId] ??
        options.subscriptionProfilePath,
    };
  }
  const apiKey = options.apiKeys?.[profile.providerProfileId];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      `Provider profile ${profile.providerProfileId} has no API key`,
    );
  }
  return {
    type: "openai-compatible" as const,
    baseUrl: profile.baseUrl,
    apiKey,
    name: profile.name,
  };
}

function validateProviderProfile(value: unknown): ZenXProviderProfile {
  if (!isRecord(value)) throw new Error("ZenX Provider profile is invalid");
  return {
    ...validateProviderConnection(value),
    providerProfileId: providerProfileIdentifier(value.providerProfileId),
    models: validateStructuredModelCatalog(value.models),
  };
}

function validateLegacyProviderProfileV2(
  value: unknown,
): ZenXProviderConnection & { providerProfileId: string; models: string[] } {
  if (!isRecord(value)) throw new Error("ZenX Provider profile is invalid");
  return {
    ...validateProviderConnection(value),
    providerProfileId: providerProfileIdentifier(value.providerProfileId),
    models: validateModelList(value.models),
  };
}

function validateProviderConnection(
  value: Record<string, unknown>,
): ZenXProviderConnection {
  const displayName = nonEmpty(value.displayName, "provider display name");
  if (value.type === "fake") return { type: "fake", displayName };
  if (value.type === "openai-subscription") {
    return { type: "openai-subscription", displayName };
  }
  if (value.type !== "openai-compatible") {
    throw new Error("ZenX provider type is invalid");
  }
  const baseUrl = nonEmpty(value.baseUrl, "base URL");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("ZenX provider base URL is invalid");
  }
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    )
  ) {
    throw new Error(
      "ZenX provider base URL must use HTTPS (loopback HTTP is allowed)",
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("ZenX provider base URL must not contain credentials");
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(
      "ZenX provider base URL must not contain query or fragment",
    );
  }
  return {
    type: "openai-compatible",
    name: providerProfileIdentifier(value.name),
    displayName,
    baseUrl: parsed.toString().replace(/\/$/u, ""),
  };
}

function validateModelList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MODELS_PER_PROFILE
  ) {
    throw new Error("ZenX model list is invalid");
  }
  const models = value.map(modelIdentifier);
  if (new Set(models).size !== models.length) {
    throw new Error("ZenX model ids must be unique per Provider profile");
  }
  return models;
}

function validateStructuredModelCatalog(
  value: unknown,
): ZenXModelCatalogEntry[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MODELS_PER_PROFILE
  ) {
    throw new Error("ZenX model catalog is invalid");
  }
  const models = value.map(validateStructuredModelCatalogEntry);
  if (new Set(models.map((entry) => entry.id)).size !== models.length) {
    throw new Error("ZenX model ids must be unique per Provider profile");
  }
  return models;
}

function validateStructuredModelCatalogEntry(
  value: unknown,
): ZenXModelCatalogEntry {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.description !== "string" ||
    typeof value.hidden !== "boolean" ||
    typeof value.source !== "string" ||
    !(
      value.supportedReasoningEfforts === null ||
      (Array.isArray(value.supportedReasoningEfforts) &&
        value.supportedReasoningEfforts.every(
          (entry) => typeof entry === "string",
        ))
    ) ||
    !(
      value.defaultReasoningEffort === null ||
      typeof value.defaultReasoningEffort === "string"
    ) ||
    !(
      value.inputModalities === null ||
      (Array.isArray(value.inputModalities) &&
        value.inputModalities.every((entry) => typeof entry === "string"))
    ) ||
    !(value.contextWindow === null || typeof value.contextWindow === "number")
  ) {
    throw new Error("ZenX model catalog metadata is invalid");
  }
  try {
    const normalized = normalizeModelCatalogEntry({
      id: modelIdentifier(value.id),
      displayName: value.displayName,
      description: value.description,
      hidden: value.hidden,
      source: value.source as ModelCatalogEntryInput["source"],
      supportedReasoningEfforts: value.supportedReasoningEfforts as
        string[] | null,
      defaultReasoningEffort: value.defaultReasoningEffort,
      inputModalities: value.inputModalities as Array<"text" | "image"> | null,
      contextWindow: value.contextWindow,
    });
    const { isDefault: _isDefault, ...entry } = normalized;
    return entry;
  } catch (error) {
    throw new Error(
      `ZenX model catalog metadata is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function structuredLegacyModelCatalog(
  providerType: ZenXProviderConnection["type"],
  modelIds: readonly string[],
): ZenXModelCatalogEntry[] {
  return legacyModelCatalogEntries(providerType, modelIds).map((entry) => {
    const normalized = normalizeModelCatalogEntry(entry);
    const { isDefault: _isDefault, ...model } = normalized;
    return model;
  });
}

export function applyBuiltInModelCatalogPresets(
  profile: ZenXHostProfile,
  projectPlatform: NodeJS.Platform = process.platform,
): ZenXHostProfile {
  const validated = validateHostProfile(profile, projectPlatform);
  const providerProfiles = validated.providerProfiles.map((provider) => {
    if (provider.type !== "openai-subscription") return provider;
    const existingById = new Map(
      provider.models.map((model) => [model.id, model]),
    );
    const presetModels = builtInModelCatalogPreset("openai-subscription").map(
      (preset) => {
        const existing = existingById.get(preset.id);
        if (existing !== undefined) existingById.delete(preset.id);
        if (existing?.source === "manual") return existing;
        const normalized = normalizeModelCatalogEntry(preset);
        const { isDefault: _isDefault, ...model } = normalized;
        return model;
      },
    );
    return {
      ...provider,
      models: [...presetModels, ...existingById.values()],
    };
  });
  return validateHostProfile(
    { ...validated, providerProfiles },
    projectPlatform,
  );
}

function validateModelReference(
  value: unknown,
  label: "default" | "title",
): ZenXModelReference {
  if (!isRecord(value)) throw new Error(`ZenX ${label} model is invalid`);
  return {
    providerProfileId: providerProfileIdentifier(value.providerProfileId),
    modelId: modelIdentifier(value.modelId),
  };
}

function validateModelReferenceExists(
  reference: ZenXModelReference,
  profiles: readonly ZenXProviderProfile[],
  label: "default" | "title",
): void {
  const profile = profiles.find(
    (candidate) => candidate.providerProfileId === reference.providerProfileId,
  );
  if (profile === undefined) {
    throw new Error(
      `ZenX ${label} model references an unknown Provider profile`,
    );
  }
  if (!profile.models.some((model) => model.id === reference.modelId)) {
    throw new Error(
      `ZenX ${label} model is absent from Provider profile ${reference.providerProfileId}`,
    );
  }
}

function providerProfileIdentifier(value: unknown): string {
  const identifier = nonEmpty(value, "Provider profile id");
  if (
    identifier.length > MAX_PROVIDER_PROFILE_ID_LENGTH ||
    /[\u0000-\u001f]/u.test(identifier)
  ) {
    throw new Error("ZenX Provider profile id is invalid");
  }
  return identifier;
}

function modelIdentifier(value: unknown): string {
  const identifier = nonEmpty(value, "model");
  if (
    identifier.length > MAX_MODEL_ID_LENGTH ||
    /[\u0000-\u001f]/u.test(identifier)
  ) {
    throw new Error("ZenX model id is invalid");
  }
  return identifier;
}

function isLegacyHostProfile(value: unknown): value is LegacyHostProfileV1 {
  return isRecord(value) && value.version === 1 && isRecord(value.provider);
}

function isLegacyHostProfileV2(value: unknown): value is LegacyHostProfileV2 {
  return isRecord(value) && value.version === 2;
}

function normalizeSidebarOrder(value: unknown): ZenXSidebarOrder {
  if (value === undefined) return { projectKeys: [], threadIdsByProject: {} };
  if (!isRecord(value) || !isRecord(value.threadIdsByProject)) {
    throw new Error("ZenX Sidebar order is invalid");
  }
  const projectKeys = normalizeOrderIdentifiers(
    value.projectKeys,
    "Project key",
    32_768,
  );
  const entries = Object.entries(value.threadIdsByProject);
  if (entries.length > 4_096)
    throw new Error("ZenX Sidebar Thread order is invalid");
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
      if (totalThreadIds > 4_096)
        throw new Error("ZenX Sidebar Thread order is invalid");
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
  if (typeof value !== "string")
    throw new Error(`ZenX Sidebar ${label} is invalid`);
  const identifier = value.trim();
  if (identifier.length === 0 || identifier.length > maxLength)
    throw new Error(`ZenX Sidebar ${label} is invalid`);
  return identifier;
}

function normalizePinnedThreadIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4_096)
    throw new Error("ZenX pinned Thread list is invalid");
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
  projectPlatform: NodeJS.Platform,
): string | null {
  if (value === undefined || value === null) return null;
  const key = workspaceKey(
    nonEmpty(value, "last used workspace"),
    projectPlatform,
  );
  return (
    workspaces.find(
      (workspace) => workspaceKey(workspace, projectPlatform) === key,
    ) ?? null
  );
}

function normalizeWorkspaces(
  value: unknown,
  workspace: string | null,
  projectPlatform: NodeJS.Platform,
): string[] {
  if (value !== undefined && !Array.isArray(value))
    throw new Error("ZenX workspace list is invalid");
  const candidates = ((value ?? []) as unknown[]).map((entry) =>
    resolveProjectPath(nonEmpty(entry, "workspace"), projectPlatform),
  );
  if (workspace !== null) candidates.unshift(workspace);
  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    const key = workspaceKey(candidate, projectPlatform);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

export function workspaceKey(
  value: string,
  projectPlatform: NodeJS.Platform = process.platform,
): string {
  const resolved = resolveProjectPath(value, projectPlatform);
  return projectPlatform === "win32" ? resolved.toLowerCase() : resolved;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`ZenX ${label} is required`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
