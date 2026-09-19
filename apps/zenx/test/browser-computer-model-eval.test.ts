import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvaluationPrompt,
  parseRunnerArgs,
  resolveRequestedModel,
} from "../scripts/browser-computer-model-eval.js";
import type { ModelSummary } from "../src/protocol-client/index.js";

test("evaluation prompt exposes the task and constraints without its oracle", () => {
  const prompt = buildEvaluationPrompt(
    {
      id: "B6",
      prompt: "Open {baseUrl}/preferences and save the preferences.",
    },
    "http://127.0.0.1:4321",
    "b6-trial-session",
  );

  assert.match(prompt, /http:\/\/127\.0\.0\.1:4321\/preferences/);
  assert.match(prompt, /sessionId b6-trial-session/);
  assert.match(prompt, /normal Browser tools/);
  assert.match(prompt, /code only as transport/);
  assert.match(prompt, /view screenshots produced by Browser observations/);
  assert.match(prompt, /final Browser observation/);
  assert.doesNotMatch(prompt, /success|failure|PASS marker|oracle/i);
});

test("CLI bounds repeated trials and accepts only a loopback fixture", () => {
  const parsed = parseRunnerArgs([
    "--descriptor",
    "runtime/app-server.json",
    "--model",
    "Luna",
    "--base-url",
    "http://localhost:4567/",
    "--task",
    "B6",
    "--output",
    "private-results",
    "--trials",
    "3",
    "--timeout-ms",
    "120000",
  ]);
  assert.equal(parsed.baseUrl, "http://localhost:4567");
  assert.equal(parsed.trials, 3);
  assert.equal(parsed.timeoutMs, 120_000);
  assert.doesNotThrow(() =>
    parseRunnerArgs([
      "--descriptor",
      "app-server.json",
      "--model",
      "Luna",
      "--base-url",
      "http://[::1]:4567",
      "--task",
      "B1",
      "--output",
      "results-v6",
    ]),
  );
  assert.throws(
    () =>
      parseRunnerArgs([
        "--descriptor",
        "app-server.json",
        "--model",
        "Luna",
        "--base-url",
        "https://example.com",
        "--task",
        "B1",
        "--output",
        "results",
      ]),
    /loopback/,
  );
});

test("model selection requires one exact model/list label or id", () => {
  const first = model("opaque-a", "Luna");
  const second = model("opaque-b", "Sol");
  assert.equal(resolveRequestedModel([first, second], "opaque-a"), first);
  assert.equal(resolveRequestedModel([first, second], "Sol"), second);
  assert.throws(
    () => resolveRequestedModel([first, model("opaque-c", "Luna")], "Luna"),
    /ambiguous/,
  );
  assert.throws(
    () => resolveRequestedModel([first, second], "lun"),
    /did not exactly match/,
  );
});

function model(id: string, displayName: string): ModelSummary {
  return {
    id,
    model: id,
    displayName,
    description: "test",
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
  };
}
