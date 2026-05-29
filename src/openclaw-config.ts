import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenClawModelConfig = {
  readonly providerName: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly params: Readonly<Record<string, unknown>>;
};

export type OpenClawConfigOptions = {
  readonly path?: string;
};

export function loadOpenClawModelConfig(
  options: OpenClawConfigOptions = {}
): OpenClawModelConfig {
  const configPath =
    options.path ?? join(homedir(), ".openclaw", "openclaw.json");
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  const root = readRecord(raw, "OpenClaw config");
  const primary = readStringPath(root, [
    "agents",
    "defaults",
    "model",
    "primary"
  ]);
  const [providerName, modelId] = primary.includes("/")
    ? (primary.split("/", 2) as [string, string])
    : ["", primary];
  const provider = readRecordPath(root, [
    "models",
    "providers",
    providerName
  ]);
  const baseUrl = readString(provider.baseUrl, `provider ${providerName}.baseUrl`);
  const apiKey = readString(provider.apiKey, `provider ${providerName}.apiKey`);
  const models = Array.isArray(provider.models) ? provider.models : [];
  const model = models
    .map((entry) => readRecord(entry, "model"))
    .find((entry) => entry.id === modelId);

  if (!model) {
    throw new Error(`Model ${primary} was not found in OpenClaw config`);
  }

  return {
    providerName,
    modelId,
    displayName: readString(model.name, `model ${primary}.name`),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    params: readParams(model.params)
  };
}

function readStringPath(
  root: Readonly<Record<string, unknown>>,
  path: readonly string[]
): string {
  let current: unknown = root;

  for (const part of path) {
    current = readRecord(current, path.join("."))[part];
  }

  return readString(current, path.join("."));
}

function readRecordPath(
  root: Readonly<Record<string, unknown>>,
  path: readonly string[]
): Readonly<Record<string, unknown>> {
  let current: unknown = root;

  for (const part of path) {
    current = readRecord(current, path.join("."))[part];
  }

  return readRecord(current, path.join("."));
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

function readParams(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }

  return {};
}
