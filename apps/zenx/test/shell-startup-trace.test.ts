import assert from "node:assert/strict";
import test from "node:test";
import { createShellStartupTrace } from "./fixtures/shell-startup-trace.js";

test("startup observations distinguish control output from a split real prompt", () => {
  let now = 100;
  const messages: string[] = [];
  const trace = createShellStartupTrace({
    enabled: true,
    now: () => now,
    log: (message) => messages.push(message),
  });
  trace.stage("spawn started");
  now = 271;
  trace.stage("spawn returned");
  now = 300;
  trace.onData("\x1b[?9001h\x1b[?1004h");
  assert.equal(messages.length, 3);
  now = 17000;
  trace.onData("\x1b[?25hPS C:\\fixt");
  assert.equal(messages.length, 3);
  now = 17033;
  trace.onData("ure> ");
  trace.onData("later output\r\nPS C:\\fixture> ");
  assert.deepEqual(
    messages.map((message) =>
      JSON.parse(message.replace("[Shell startup] ", "")),
    ),
    [
      { stage: "spawn started", elapsedMs: 0 },
      { stage: "spawn returned", elapsedMs: 171 },
      { stage: "first output", elapsedMs: 200 },
      { stage: "first PowerShell prompt", elapsedMs: 16933 },
    ],
  );
});

test("disabled or failed diagnostics cannot interrupt shell observations", () => {
  const disabled = createShellStartupTrace({
    enabled: false,
    log: () => assert.fail("disabled diagnostics must not log"),
  });
  disabled.stage("spawn started");
  disabled.onData("PS C:\\fixture> ");
  const throwing = createShellStartupTrace({
    enabled: true,
    log: () => {
      throw new Error("sink failed");
    },
  });
  assert.doesNotThrow(() => {
    throwing.stage("spawn started");
    throwing.onData("PS C:\\fixture> ");
  });
});
