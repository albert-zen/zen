import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveZenXHostConfig } from "../src/main/host-config.js";

test("resolves fake and subscription hosts from external ZenX config", () => {
  const cwd = path.join(os.tmpdir(), "zenx-cwd");
  const dataDirectory = path.join(os.tmpdir(), "zenx-data");
  const fake = resolveZenXHostConfig({
    ZENX_CWD: cwd,
    ZENX_DATA_DIR: dataDirectory,
  });
  assert.equal(fake.provider.type, "fake");
  assert.equal(fake.model, "fake");
  assert.deepEqual(fake.models, ["fake"]);

  const subscriptionDirectory = path.join(os.tmpdir(), "zenx-subscription");
  const subscription = resolveZenXHostConfig({
    ZENX_PROVIDER: "openai-subscription",
    ZENX_DATA_DIR: subscriptionDirectory,
  });
  assert.equal(subscription.provider.type, "openai-subscription");
  if (subscription.provider.type === "openai-subscription") {
    assert.equal(
      subscription.provider.profilePath,
      path.join(subscriptionDirectory, "openai-subscription-auth.json"),
    );
  }
});

test("moves an OpenAI-compatible key into host config and blocks shell inheritance", () => {
  const environment: NodeJS.ProcessEnv = {
    ZENX_PROVIDER: "openai-compatible",
    ZENX_MODEL: "local-model",
    ZENX_API_KEY_ENV: "ZENX_TEST_KEY",
    ZENX_TEST_KEY: "private-key",
  };
  const config = resolveZenXHostConfig(environment);
  assert.equal(config.provider.type, "openai-compatible");
  if (config.provider.type === "openai-compatible") {
    assert.equal(config.provider.apiKey, "private-key");
  }
  assert.deepEqual(config.secretEnvironmentVariables, ["ZENX_TEST_KEY"]);
  assert.equal(environment["ZENX_TEST_KEY"], undefined);
});
