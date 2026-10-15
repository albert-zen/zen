import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the actual read-only barrier with controlled cross-process observations.
// These boundary tests do not substitute for macOS AX/native input execution.
const source = readFileSync(
  new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "fixture.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const declaration = ast.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "settleMacFixtureInput",
);
assert.ok(
  declaration,
  "Native fixture must observe consumption before dispatch",
);
const executable = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function fixture({
  samples,
  error,
  advanceRead = 0,
  abortAfterRead = false,
} = {}) {
  let now = 0;
  let reads = 0;
  const waits = [];
  const budgets = [];
  const controller = new AbortController();
  const settle = runInNewContext(`${executable}; settleMacFixtureInput`, {
    assert,
    performance: { now: () => now },
    withDeadline: async (promise, ms) => {
      budgets.push(ms);
      return await promise;
    },
    delay: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  return {
    run: (overrides = {}) =>
      settle({
        previousValue: "USER",
        expectedValue: "USERU0X",
        signal: controller.signal,
        read: async () => {
          now += advanceRead;
          const index = reads++;
          const sample = samples?.[Math.min(index, samples.length - 1)];
          if (abortAfterRead) controller.abort(new Error("fixture aborted"));
          if (error) throw error;
          return sample;
        },
        ...overrides,
      }),
    controller,
    waits,
    budgets,
    reads: () => reads,
  };
}
const sample = (domValue, nativeValueState) => ({ domValue, nativeValueState });

test("AX may lag the exact DOM value without another native event being dispatched", async () => {
  const f = fixture({
    samples: [
      sample("USERU0X", "pending"),
      sample("USERU0X", "pending"),
      sample("USERU0X", "matched"),
    ],
  });
  assert.equal(await f.run(), 3);
  assert.deepEqual(f.waits, [20, 20]);
  assert.deepEqual(f.budgets, [2000, 1980, 1960]);
});

test("both DOM consumption and the exact native value must settle", async () => {
  const f = fixture({
    samples: [
      sample("USERU", "pending"),
      sample("USERU0", "matched"),
      sample("USERU0X", "matched"),
    ],
  });
  assert.equal(await f.run(), 3);
});

for (const value of ["OTHER", "USERU0Y", "USERU0Xextra", "USE"]) {
  test(`unissued or regressed DOM value ${value} fails immediately`, async () => {
    const f = fixture({ samples: [sample(value, "pending")] });
    await assert.rejects(f.run(), /exact user fixture value/);
    assert.equal(f.reads(), 1);
    assert.equal(f.waits.length, 0);
  });
}
for (const state of ["invalid", undefined]) {
  test(`native ${String(state)} focus/value evidence fails without retry`, async () => {
    const f = fixture({ samples: [sample("USERU0X", state)] });
    await assert.rejects(f.run(), /exact issued input/);
    assert.equal(f.reads(), 1);
    assert.equal(f.waits.length, 0);
  });
}

test("unchanged stale AX fails within the single two-second observation budget", async () => {
  const f = fixture({ samples: [sample("USERU0X", "pending")] });
  await assert.rejects(f.run(), /did not settle/);
  assert.equal(f.reads(), 100);
  assert.equal(f.waits.length, 100);
  assert.equal(f.budgets.at(-1), 20);
});

test("a matched result arriving at or beyond the deadline is not accepted", async () => {
  const f = fixture({
    samples: [sample("USERU0X", "matched")],
    advanceRead: 2000,
  });
  await assert.rejects(f.run(), /did not settle/);
  assert.equal(f.reads(), 1);
});

test("foreground/target guard rejection stops observation without retry", async () => {
  const error = new Error("Native foreground PID changed");
  const f = fixture({ error });
  await assert.rejects(f.run(), (caught) => caught === error);
  assert.equal(f.reads(), 1);
  assert.equal(f.waits.length, 0);
});

test("cancellation before or during observation prevents success", async () => {
  const f = fixture({ samples: [sample("USERU0X", "matched")] });
  f.controller.abort(new Error("fixture aborted"));
  await assert.rejects(f.run(), /fixture aborted/);
  assert.equal(f.reads(), 0);
  const g = fixture({
    samples: [sample("USERU0X", "matched")],
    abortAfterRead: true,
  });
  await assert.rejects(g.run(), /fixture aborted/);
  assert.equal(g.reads(), 1);
});

test("native focusedValue is read-only and the immediate exact-value type guard is retained", () => {
  const nativeRead = source.slice(
    source.indexOf('  case "focusedValue":'),
    source.indexOf('  case "type":', source.indexOf('  case "focusedValue":')),
  );
  assert.match(nativeRead, /AXUIElementCopyAttributeValue/);
  assert.match(nativeRead, /observed == expectedValue/);
  assert.match(
    nativeRead,
    /observed\.hasPrefix\(previousValue\) && expectedValue\.hasPrefix\(observed\)/,
  );
  assert.doesNotMatch(
    nativeRead,
    /CGEvent\(|\.post\(|\.activate\(|SetAttributeValue|case "type"/,
  );
  assert.match(source, /\(value as\? String\) == expectedValue/);
  assert.match(
    source,
    /Foreground changed before OS event; stopped without replay/,
  );
  assert.match(source, /nativeSettlementReads/);
});

let userTask;
function findUserTask(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "userTask")
    userTask = node;
  ts.forEachChild(node, findUserTask);
}
findUserTask(ast);
assert.ok(userTask?.initializer);
const cycle = ts.transpileModule(
  `async function runCycle() { return ${userTask.initializer.getText(ast)}; }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
function cycleFixture({ settleError, value = "USER", focus = true } = {}) {
  const calls = [];
  const controller = new AbortController();
  const context = {
    assert,
    process: { platform: "darwin" },
    finished: false,
    produced: "",
    batchesWhileAgentRunning: 0,
    layer: "real-os-input",
    scenario: "chrome-foreground",
    userStart: { value: "USER" },
    controller,
    settleNativeInput: async () => {
      calls.push("settle");
      if (settleError) throw settleError;
    },
    guard: async () => {
      calls.push("guard");
      return { userState: { value, hasFocus: focus } };
    },
    native: {
      call: async (method, params) => {
        calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
        context.finished = true;
      },
    },
    delay: async () => calls.push("delay"),
  };
  const run = runInNewContext(`${cycle}; runCycle`, context);
  return { run, calls, controller, context };
}

test("actual native loop observes first and dispatches one exact batch only once", async () => {
  const f = cycleFixture();
  await f.run();
  assert.deepEqual(f.calls, [
    "settle",
    "guard",
    { method: "type", params: { text: "U0X", expectedValue: "USER" } },
    "delay",
  ]);
  assert.equal(f.context.produced, "U0X");
  assert.equal(f.context.batchesWhileAgentRunning, 1);
});

test("actual native loop aborts without dispatch when the barrier fails", async () => {
  const error = new Error("Native fixture input did not settle");
  const f = cycleFixture({ settleError: error });
  await assert.rejects(f.run(), (value) => value === error);
  assert.deepEqual(f.calls, ["settle"]);
  assert.equal(f.controller.signal.aborted, true);
  assert.equal(f.context.produced, "");
});
for (const options of [{ value: "changed" }, { focus: false }]) {
  test(`actual loop rejects value/focus change after settlement: ${JSON.stringify(options)}`, async () => {
    const f = cycleFixture(options);
    await assert.rejects(
      f.run(),
      /changed before the next batch|no longer has keyboard focus/,
    );
    assert.deepEqual(f.calls, ["settle", "guard"]);
    assert.equal(f.controller.signal.aborted, true);
  });
}
