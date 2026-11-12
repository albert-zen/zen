import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { configuration } from "../dist/configuration.js";

const priorConfiguration = {
  pythonExecutable: path.join(os.tmpdir(), "python"),
  channelsConfigFile: path.join(os.tmpdir(), "channels.json"),
  cwd: os.tmpdir(),
};

test("old omitted IM continuation configuration defaults to soft steer", () => {
  const result = configuration(priorConfiguration);
  assert.equal(result.inputContinuation, "steer");
  for (const [key, value] of Object.entries(priorConfiguration))
    assert.equal(result[key], value);
});

test("IM continuation is a closed independent configuration value", () => {
  for (const inputContinuation of ["steer", "queue"])
    assert.equal(
      configuration({ ...priorConfiguration, inputContinuation })
        .inputContinuation,
      inputContinuation,
    );
  for (const inputContinuation of [
    null,
    "",
    "QUEUE",
    " queue ",
    "interrupt",
    true,
    1,
    {},
  ])
    assert.throws(
      () => configuration({ ...priorConfiguration, inputContinuation }),
      /inputContinuation/,
    );
});
