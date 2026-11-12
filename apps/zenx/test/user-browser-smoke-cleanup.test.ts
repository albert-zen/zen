import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the actual Windows smoke's cleanup stage with only its native boundary
// replaced. This is orchestration evidence, not real Windows/CDP acceptance.
const source = readFileSync(
  new URL("../src/main/user-browser-smoke.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf(
  '  const closing = backend.closeSession("windows-smoke");',
);
const end = source.indexOf("  stopLive();", start);
assert.ok(start >= 0 && end > start);
const cleanupStage = ts.transpileModule(
  `(async () => { ${source.slice(start, end)}; return detached; })()`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;

function fixture(
  options: {
    omitStatus?: boolean;
    lateEvent?: boolean;
    closeError?: Error;
  } = {},
) {
  const events: unknown[] = [];
  let release!: () => void;
  const settlement = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stoppedStatus: unknown;
  const context = createContext({
    assert,
    liveEvents: events,
    setTimeout: (callback: () => void) => callback(),
    backend: {
      closeSession(sessionId: string) {
        assert.equal(sessionId, "windows-smoke");
        if (!options.omitStatus) events.push(stoppedStatus);
        return settlement.then(() => {
          if (options.lateEvent) events.push({ type: "metadata" });
          if (options.closeError) throw options.closeError;
          return 1;
        });
      },
    },
  });
  stoppedStatus = runInContext(
    `({ type: "status", status: "unavailable", message: "Live observation stopped because browser session cleanup was requested." })`,
    context,
  );
  const outcome: Promise<unknown> = runInContext(cleanupStage, context);
  return { events, release, outcome };
}

test("Windows cleanup smoke requires an immediate stopped signal before close settles", async () => {
  const smoke = fixture();
  assert.equal(smoke.events.length, 1);
  let settled = false;
  void smoke.outcome.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  smoke.release();
  assert.equal(await smoke.outcome, 1);
});

test("Windows cleanup smoke fails if observation is silently stopped", async () => {
  const smoke = fixture({ omitStatus: true });
  smoke.release();
  await assert.rejects(smoke.outcome, /Expected values to be/u);
});

test("Windows cleanup smoke rejects events that arrive after the stop signal", async () => {
  const smoke = fixture({ lateEvent: true });
  smoke.release();
  await assert.rejects(smoke.outcome, /stop live metadata and frames/u);
});

test("Windows cleanup smoke never treats an unknown close as confirmed release", async () => {
  const error = new Error("Synthetic detach outcome is unknown");
  const smoke = fixture({ closeError: error });
  smoke.release();
  await assert.rejects(smoke.outcome, (actual: unknown) => actual === error);
});
