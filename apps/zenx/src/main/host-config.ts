import os from "node:os";
import path from "node:path";

import type { HostProvider } from "../../../../apps/cli/src/host.js";
import { DEFAULT_OPENAI_SUBSCRIPTION_MODEL } from "../../../../src/model/openai-subscription.js";
import type { ZenXHostConfig } from "./host-messages.js";

export function resolveZenDataDirectory(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  return path.resolve(
    environment["ZENX_DATA_DIR"] ?? path.join(homeDirectory, ".zen"),
  );
}

export function resolveZenXHostConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ZenXHostConfig {
  const providerName = environment["ZENX_PROVIDER"] ?? "fake";
  const dataDirectory = path.resolve(
    environment["ZENX_DATA_DIR"] ?? path.join(os.homedir(), ".zen"),
  );
  const model =
    environment["ZENX_MODEL"] ??
    (providerName === "openai-subscription"
      ? DEFAULT_OPENAI_SUBSCRIPTION_MODEL
      : "fake");
  const models = (environment["ZENX_MODELS"] ?? model)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (models.length === 0 || !models.includes(model)) {
    throw new Error("ZENX_MODELS must include the configured ZENX_MODEL");
  }
  const approvalPolicy = environment["ZENX_APPROVAL_POLICY"] ?? "never";
  if (approvalPolicy !== "always" && approvalPolicy !== "never") {
    throw new Error("ZENX_APPROVAL_POLICY must be always or never");
  }

  let provider: HostProvider;
  let secretEnvironmentVariables: readonly string[] = [];
  if (providerName === "fake") {
    provider = { type: "fake" };
  } else if (providerName === "openai-subscription") {
    provider = {
      type: "openai-subscription",
      profilePath:
        environment["ZENX_SUBSCRIPTION_PROFILE"] ??
        path.join(dataDirectory, "openai-subscription-auth.json"),
    };
  } else if (providerName === "openai-compatible") {
    const keyName = environment["ZENX_API_KEY_ENV"] ?? "OPENAI_API_KEY";
    const apiKey = environment[keyName];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(`API key environment variable ${keyName} is not set`);
    }
    delete environment[keyName];
    provider = {
      type: "openai-compatible",
      baseUrl: environment["ZENX_BASE_URL"] ?? "https://api.openai.com/v1",
      apiKey,
      name: environment["ZENX_PROVIDER_NAME"] ?? "openai",
    };
    secretEnvironmentVariables = [keyName];
  } else {
    throw new Error(`Unsupported ZENX_PROVIDER: ${providerName}`);
  }

  return {
    cwd: path.resolve(environment["ZENX_CWD"] ?? process.cwd()),
    dataDirectory,
    model,
    models,
    approvalPolicy,
    provider,
    secretEnvironmentVariables,
  };
}
