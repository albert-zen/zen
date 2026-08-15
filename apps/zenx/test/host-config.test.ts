import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  resolveZenDataDirectory,
  resolveZenXHostConfig,
} from "../src/main/host-config.js";

test("keeps shared ~/.zen authoritative and ignores CODEX_HOME", () => {
  const home = path.resolve("/tmp/zen-home");
  assert.equal(
    resolveZenDataDirectory(
      { CODEX_HOME: path.resolve("/tmp/codex-home") },
      home,
    ),
    path.join(home, ".zen"),
  );
  assert.equal(
    resolveZenDataDirectory({ ZENX_DATA_DIR: "/tmp/explicit-zen" }, home),
    path.resolve("/tmp/explicit-zen"),
  );
});

test("resolves fake and subscription hosts from external ZenX config", () => {
  const fake = resolveZenXHostConfig({
    ZENX_CWD: "/tmp/zenx-cwd",
    ZENX_DATA_DIR: "/tmp/zenx-data",
  });
  assert.equal(fake.provider.type, "fake");
  assert.equal(fake.model, "fake");
  assert.deepEqual(fake.models, ["fake"]);

  const subscription = resolveZenXHostConfig({
    ZENX_PROVIDER: "openai-subscription",
    ZENX_DATA_DIR: "/tmp/zenx-subscription",
  });
  assert.equal(subscription.provider.type, "openai-subscription");
  if (subscription.provider.type === "openai-subscription") {
    assert.equal(
      subscription.provider.profilePath,
      path.join(
        path.resolve("/tmp/zenx-subscription"),
        "openai-subscription-auth.json",
      ),
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
