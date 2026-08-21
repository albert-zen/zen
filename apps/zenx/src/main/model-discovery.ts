import type { ModelCatalogEntryInput } from "../../../../src/model-catalog.js";

const MAX_DISCOVERED_MODELS = 1_024;
const MAX_MODEL_ID_LENGTH = 512;

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
    return Object.freeze({
      id,
      displayName: id,
      description: "",
      hidden: false,
      source: "discovered",
      supportedReasoningEfforts: null,
      defaultReasoningEffort: null,
      inputModalities: null,
      contextWindow: null,
    });
  });
  return Object.freeze(models);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
