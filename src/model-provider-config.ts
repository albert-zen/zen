import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL_PROVIDER_CONFIG_PATH = join(
  homedir(),
  ".zen",
  "model-provider.json"
);

export type ModelProviderConfig = {
  readonly providerName?: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly params: Readonly<Record<string, unknown>>;
};

export type ModelProviderConfigOptions = {
  readonly path?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export function loadModelProviderConfig(
  options: ModelProviderConfigOptions = {}
): ModelProviderConfig {
  const env = options.env ?? process.env;
  const envConfig = readEnvConfig(env);

  if (envConfig) {
    return envConfig;
  }

  const configPath =
    options.path ?? env.ZEN_MODEL_PROVIDER_CONFIG ?? DEFAULT_MODEL_PROVIDER_CONFIG_PATH;
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  const root = readRecord(raw, "model provider config");

  return {
    providerName: readOptionalString(root.providerName, "providerName"),
    modelId: readString(root.model, "model"),
    displayName: readOptionalString(root.displayName, "displayName"),
    baseUrl: readString(root.baseUrl, "baseUrl").replace(/\/+$/, ""),
    apiKey: readString(root.apiKey, "apiKey"),
    params: readParams(root.params)
  };
}

function readEnvConfig(
  env: Readonly<Record<string, string | undefined>>
): ModelProviderConfig | undefined {
  const baseUrl = env.ZEN_MODEL_BASE_URL;
  const apiKey = env.ZEN_MODEL_API_KEY;
  const modelId = env.ZEN_MODEL;

  if (!baseUrl && !apiKey && !modelId) {
    return undefined;
  }

  return {
    providerName: env.ZEN_MODEL_PROVIDER,
    modelId: readString(modelId, "ZEN_MODEL"),
    displayName: env.ZEN_MODEL_DISPLAY_NAME,
    baseUrl: readString(baseUrl, "ZEN_MODEL_BASE_URL").replace(/\/+$/, ""),
    apiKey: readString(apiKey, "ZEN_MODEL_API_KEY"),
    params: readEnvParams(env.ZEN_MODEL_PARAMS)
  };
}

function readEnvParams(value: string | undefined): Readonly<Record<string, unknown>> {
  if (!value) {
    return {};
  }

  return readParams(JSON.parse(value) as unknown);
}

function readRecord(
  value: unknown,
  label: string
): Readonly<Record<string, unknown>> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }

  throw new Error(`${label} must be an object`);
}

function readString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`${label} must be a non-empty string`);
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readString(value, label);
}

function readParams(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined) {
    return {};
  }

  return readRecord(value, "params");
}
