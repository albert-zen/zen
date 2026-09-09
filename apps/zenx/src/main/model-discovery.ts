import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ModelCatalogEntryInput,
  ModelInputModality,
} from "../../../../src/model-catalog.js";
import { builtInModelCatalogPreset } from "../../../../apps/cli/src/model-presets.js";
import { extractChatGptAccountId } from "../../../../src/model/openai-subscription.js";

const MAX_DISCOVERED_MODELS = 1_024;
const MAX_MODEL_ID_LENGTH = 512;
const TEXT_ONLY_INPUT: readonly ModelInputModality[] = Object.freeze(["text"]);
const DEFAULT_SUBSCRIPTION_MODELS_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/models";
// Zen's Codex compatibility boundary is pinned to this client generation.
// The backend uses this query to withhold metadata requiring newer semantics.
const DEFAULT_CLIENT_VERSION = "0.146.0";

export type DiscoveredModelCatalogEntry = Required<
  Pick<
    ModelCatalogEntryInput,
    | "id"
    | "displayName"
    | "description"
    | "hidden"
    | "source"
    | "supportedReasoningEfforts"
    | "defaultReasoningEffort"
    | "inputModalities"
    | "contextWindow"
  >
>;

export interface OpenAiSubscriptionDiscoveryResult {
  readonly models: readonly DiscoveredModelCatalogEntry[];
  readonly accountId: string;
  readonly etag?: string;
  readonly notModified: boolean;
}

export interface CachedOpenAiSubscriptionCatalog {
  readonly accountId: string;
  readonly fetchedAt: number;
  readonly etag?: string;
  readonly models: readonly DiscoveredModelCatalogEntry[];
}

export class ModelDiscoveryHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ModelDiscoveryHttpError";
  }
}

/** Host-owned, replaceable cache of the last account-scoped subscription catalog. */
export class OpenAiSubscriptionModelCache {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async load(
    accountId: string,
  ): Promise<CachedOpenAiSubscriptionCatalog | undefined> {
    let handle;
    try {
      handle = await open(this.#filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      return readCachedSubscriptionCatalog(value, accountId);
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    } finally {
      await handle.close();
    }
  }

  async store(value: CachedOpenAiSubscriptionCatalog): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, ...value })}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      await rename(temporary, this.#filePath);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}

export async function discoverOpenAiSubscriptionModels(options: {
  accessToken: string;
  clientVersion?: string;
  endpoint?: string;
  etag?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<OpenAiSubscriptionDiscoveryResult> {
  const fetch = options.fetch ?? globalThis.fetch;
  const endpoint = new URL(
    options.endpoint ?? DEFAULT_SUBSCRIPTION_MODELS_ENDPOINT,
  );
  endpoint.searchParams.set(
    "client_version",
    options.clientVersion ?? DEFAULT_CLIENT_VERSION,
  );
  const accountId = extractChatGptAccountId(options.accessToken);
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${options.accessToken}`,
    "chatgpt-account-id": accountId,
    originator: "zen",
    "user-agent": "zen/0.1.0",
  });
  if (options.etag !== undefined) headers.set("if-none-match", options.etag);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    throw new Error("OpenAI subscription model discovery request failed");
  }
  if (response.status === 304) {
    return Object.freeze({
      models: Object.freeze([]),
      accountId,
      etag: response.headers.get("etag") ?? options.etag,
      notModified: true,
    });
  }
  if (!response.ok) {
    throw new ModelDiscoveryHttpError(
      `OpenAI subscription model discovery returned HTTP ${response.status}`,
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      "OpenAI subscription model discovery returned malformed JSON",
    );
  }
  const models = readSubscriptionModels(body);
  return Object.freeze({
    models,
    accountId,
    etag: response.headers.get("etag") ?? undefined,
    notModified: false,
  });
}

export async function discoverOpenAiCompatibleModels(options: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<readonly DiscoveredModelCatalogEntry[]> {
  const fetch = options.fetch ?? globalThis.fetch;
  const endpoint = new URL(`${options.baseUrl.replace(/\/+$/u, "")}/models`);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    throw new Error("Model discovery request failed");
  }
  if (!response.ok) {
    throw new Error(`Model discovery returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Model discovery returned malformed JSON");
  }
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("Model discovery returned a malformed model list");
  }
  if (body.data.length > MAX_DISCOVERED_MODELS) {
    throw new Error("Model discovery returned too many models");
  }
  const seen = new Set<string>();
  const models = body.data.map((value): DiscoveredModelCatalogEntry => {
    if (!isRecord(value) || typeof value.id !== "string") {
      throw new Error("Model discovery returned a malformed model entry");
    }
    const id = value.id.trim();
    if (
      id.length === 0 ||
      id.length > MAX_MODEL_ID_LENGTH ||
      /[\u0000-\u001f]/u.test(id)
    ) {
      throw new Error("Model discovery returned a malformed model id");
    }
    if (seen.has(id)) {
      throw new Error(`Model discovery returned duplicate model id: ${id}`);
    }
    seen.add(id);
    const catalog = builtInModelCatalogPreset("openai-subscription").find(
      (entry) => entry.id === id,
    );
    const providerModalities = readInputModalities(value);
    return Object.freeze({
      id,
      displayName: catalog?.displayName ?? id,
      description: catalog?.description ?? "",
      hidden: catalog?.hidden ?? false,
      source: catalog === undefined ? "discovered" : "preset",
      // Listing a model confirms a text endpoint exists; it does not confirm
      // any Provider-specific reasoning control. Keep that control absent
      // until a preset, explicit Provider metadata, or manual configuration
      // supplies it.
      supportedReasoningEfforts: catalog?.supportedReasoningEfforts ?? [],
      defaultReasoningEffort: catalog?.defaultReasoningEffort ?? null,
      inputModalities:
        providerModalities ?? catalog?.inputModalities ?? TEXT_ONLY_INPUT,
      contextWindow: catalog?.contextWindow ?? null,
    });
  });
  return Object.freeze(models);
}

function readSubscriptionModels(
  body: unknown,
): readonly DiscoveredModelCatalogEntry[] {
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new Error(
      "OpenAI subscription model discovery returned a malformed model list",
    );
  }
  if (body.models.length > MAX_DISCOVERED_MODELS) {
    throw new Error(
      "OpenAI subscription model discovery returned too many models",
    );
  }
  const seen = new Set<string>();
  const ranked: Array<{
    model: DiscoveredModelCatalogEntry;
    priority: number;
  }> = [];
  for (const value of body.models) {
    if (!isRecord(value) || typeof value.slug !== "string") {
      throw new Error(
        "OpenAI subscription model discovery returned a malformed model entry",
      );
    }
    const id = validModelId(value.slug, "OpenAI subscription model discovery");
    if (seen.has(id)) {
      throw new Error(
        `OpenAI subscription model discovery returned duplicate model id: ${id}`,
      );
    }
    seen.add(id);
    if (value.visibility !== "list") continue;
    const preset = builtInModelCatalogPreset("openai-subscription").find(
      (entry) => entry.id === id,
    );
    const modalities = readStrictModalities(value.input_modalities);
    if (!modalities.includes("text")) continue;
    const efforts = readReasoningEfforts(value.supported_reasoning_levels);
    const defaultEffort =
      typeof value.default_reasoning_level === "string"
        ? value.default_reasoning_level.trim()
        : null;
    if (
      defaultEffort !== null &&
      (defaultEffort.length === 0 || !efforts.includes(defaultEffort))
    ) {
      throw new Error(
        `OpenAI subscription model ${id} has an invalid default reasoning level`,
      );
    }
    const contextWindow = readPositiveInteger(value.context_window);
    ranked.push({
      priority:
        typeof value.priority === "number" && Number.isFinite(value.priority)
          ? value.priority
          : Number.MAX_SAFE_INTEGER,
      model: Object.freeze({
        id,
        displayName:
          typeof value.display_name === "string" &&
          value.display_name.trim().length > 0
            ? value.display_name.trim()
            : id,
        description:
          typeof value.description === "string" ? value.description.trim() : "",
        hidden: false,
        source: "discovered",
        supportedReasoningEfforts: Object.freeze(efforts),
        defaultReasoningEffort: defaultEffort,
        inputModalities: Object.freeze(modalities),
        contextWindow: contextWindow ?? preset?.contextWindow ?? null,
      }),
    });
  }
  ranked.sort((left, right) => left.priority - right.priority);
  return Object.freeze(ranked.map((entry) => entry.model));
}

function readReasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "OpenAI subscription model discovery returned malformed reasoning levels",
    );
  }
  const efforts = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.effort !== "string") {
      throw new Error(
        "OpenAI subscription model discovery returned malformed reasoning levels",
      );
    }
    const effort = entry.effort.trim();
    if (effort.length === 0) {
      throw new Error(
        "OpenAI subscription model discovery returned an empty reasoning level",
      );
    }
    return effort;
  });
  if (new Set(efforts).size !== efforts.length) {
    throw new Error(
      "OpenAI subscription model discovery returned duplicate reasoning levels",
    );
  }
  return efforts;
}

function readStrictModalities(value: unknown): ModelInputModality[] {
  if (!Array.isArray(value)) return ["text", "image"];
  if (
    !value.every(
      (entry) => entry === "text" || entry === "image" || entry === "audio",
    )
  ) {
    throw new Error(
      "OpenAI subscription model discovery returned malformed input modalities",
    );
  }
  const modalities = [...new Set(value)] as ModelInputModality[];
  return modalities;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function validModelId(value: string, label: string): string {
  const id = value.trim();
  if (
    id.length === 0 ||
    id.length > MAX_MODEL_ID_LENGTH ||
    /[\u0000-\u001f]/u.test(id)
  ) {
    throw new Error(`${label} returned a malformed model id`);
  }
  return id;
}

function readCachedSubscriptionCatalog(
  value: unknown,
  accountId: string,
): CachedOpenAiSubscriptionCatalog | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.accountId !== accountId ||
    typeof value.fetchedAt !== "number" ||
    !Number.isSafeInteger(value.fetchedAt) ||
    !Array.isArray(value.models) ||
    value.models.length > MAX_DISCOVERED_MODELS ||
    !(value.etag === undefined || typeof value.etag === "string")
  ) {
    return undefined;
  }
  const models: DiscoveredModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of value.models) {
    if (!isRecord(candidate) || typeof candidate.id !== "string")
      return undefined;
    let id: string;
    try {
      id = validModelId(candidate.id, "Cached model catalog");
    } catch {
      return undefined;
    }
    if (
      seen.has(id) ||
      typeof candidate.displayName !== "string" ||
      typeof candidate.description !== "string" ||
      typeof candidate.hidden !== "boolean" ||
      !Array.isArray(candidate.supportedReasoningEfforts) ||
      !candidate.supportedReasoningEfforts.every(
        (entry) => typeof entry === "string" && entry.trim().length > 0,
      ) ||
      !(
        candidate.defaultReasoningEffort === null ||
        typeof candidate.defaultReasoningEffort === "string"
      ) ||
      !Array.isArray(candidate.inputModalities) ||
      !candidate.inputModalities.every(
        (entry) => entry === "text" || entry === "image" || entry === "audio",
      ) ||
      !(
        candidate.contextWindow === null ||
        readPositiveInteger(candidate.contextWindow) !== null
      )
    ) {
      return undefined;
    }
    seen.add(id);
    models.push(
      Object.freeze({
        id,
        displayName: candidate.displayName,
        description: candidate.description,
        hidden: candidate.hidden,
        source: "discovered",
        supportedReasoningEfforts: Object.freeze([
          ...candidate.supportedReasoningEfforts,
        ]),
        defaultReasoningEffort: candidate.defaultReasoningEffort,
        inputModalities: Object.freeze([...candidate.inputModalities]),
        contextWindow: candidate.contextWindow,
      }),
    );
  }
  return Object.freeze({
    accountId,
    fetchedAt: value.fetchedAt,
    ...(value.etag === undefined ? {} : { etag: value.etag }),
    models: Object.freeze(models),
  });
}

function readInputModalities(
  value: Record<string, unknown>,
): readonly ("text" | "image" | "audio")[] | null {
  const architecture = isRecord(value.architecture)
    ? value.architecture
    : undefined;
  const modalities = isRecord(value.modalities) ? value.modalities : undefined;
  const capabilities = isRecord(value.capabilities)
    ? value.capabilities
    : undefined;
  const candidate =
    value.input_modalities ??
    architecture?.input_modalities ??
    modalities?.input ??
    capabilities?.input_modalities;
  if (
    Array.isArray(candidate) &&
    candidate.every((entry) => typeof entry === "string")
  ) {
    const supported = ["text", "image", "audio"].filter((entry) =>
      candidate.includes(entry),
    ) as Array<"text" | "image" | "audio">;
    return Object.freeze(supported);
  }
  const image = capabilities?.image_input ?? capabilities?.vision;
  if (typeof image === "boolean") {
    return Object.freeze(image ? ["text", "image"] : ["text"]);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
