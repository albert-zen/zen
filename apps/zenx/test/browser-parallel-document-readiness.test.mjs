import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { UserBrowserDocumentChangedBeforeDispatchError } from "../src/main/capabilities/user-browser-provider.ts";

// Execute the actual fixture statements and its unchanged poll with a fake
// clock. No browser, screenshot, native focus or OS input is started here.
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
const poll = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "poll",
);
assert.ok(poll);

function actualPoll(label) {
  const matches = [];
  function visit(node) {
    if (
      ts.isExpressionStatement(node) &&
      ts.isAwaitExpression(node.expression) &&
      ts.isCallExpression(node.expression.expression)
    ) {
      const call = node.expression.expression;
      if (
        call.expression.getText(ast) === "poll" &&
        call.arguments[1]?.getText(ast) === label
      )
        matches.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1, `Expected one actual ${label} poll`);
  const statement = matches[0];
  assert.ok(ts.isBlock(statement.parent));
  const siblings = statement.parent.statements;
  const remaining = siblings.slice(siblings.indexOf(statement));
  const compile = (statements) =>
    ts.transpileModule(
      `${poll.getText(ast)}\nasync function run() {\n${statements
        .map((node) => node.getText(ast))
        .join("\n")}\nreturn "ready";\n}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
  return { only: compile([statement]), remaining: compile(remaining) };
}

const paths = [
  { name: "user", label: '"user fixture document"', rpc: "userRpc" },
  { name: "agent", label: '"agent fixture document"', rpc: "agentRpc" },
  {
    name: "contract",
    label: "`contract ${mode} document`",
    rpc: "rpc",
  },
].map((entry) => ({ ...entry, code: actualPoll(entry.label) }));
const inspection = actualPoll('"initial Agent document lifecycle"');

function fixture(
  entry,
  { values = [], repeat = false, remaining = false } = {},
) {
  let now = 0;
  const reads = [];
  const later = [];
  const unexpected = (operation) => async () => {
    later.push(operation);
    throw new Error(`Unexpected post-readiness operation: ${operation}`);
  };
  const rpc = {
    evaluate: async (expression) => {
      if (
        !expression.startsWith("Boolean(") &&
        !expression.startsWith("window.contract")
      )
        return await unexpected("focus/state evaluation")();
      reads.push(expression);
      const value =
        reads.length <= values.length ? values[reads.length - 1] : repeat;
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const backend = new Proxy(
    {},
    { get: (_target, method) => unexpected(`backend.${String(method)}`) },
  );
  const run = runInNewContext(
    `${entry.code[remaining ? "remaining" : "only"]}; run`,
    {
      assert,
      Date: { now: () => now },
      delay: async (ms) => {
        assert.equal(ms, 50);
        now += ms;
      },
      [entry.rpc]: rpc,
      // The remainder is the actual surrounding source, including later focus,
      // inspect and input calls, rather than a test-created continuation.
      phase: "readiness",
      mode: "ordinary-dom",
      sessionId: "owned-session",
      opened: { tabId: "owned-agent" },
      connection: { backend },
      browserRpc: { send: unexpected("browser.send") },
      native: { call: unexpected("native.call") },
      options: {
        onPhase: () => {
          later.push("contract actions phase");
        },
      },
      state: unexpected("contract state"),
      focus: unexpected("contract focus"),
      inspect: unexpected("contract inspect"),
      paired: unexpected("contract input"),
      backend,
      UserBrowserDocumentChangedBeforeDispatchError,
    },
  );
  return { run, reads, later, elapsed: () => now };
}

for (const entry of paths) {
  test(`${entry.name} document polls known false then succeeds on the second read`, async () => {
    const f = fixture(entry, { values: [false, true] });
    assert.equal(await f.run(), "ready");
    assert.equal(f.reads.length, 2);
    assert.equal(f.elapsed(), 50);
    assert.equal(f.reads[0], f.reads[1]);
  });

  test(`${entry.name} document retains the original 20-second false-result budget`, async () => {
    const f = fixture(entry);
    await assert.rejects(f.run(), /Timed out waiting for .* document/);
    assert.equal(f.reads.length, 400);
    assert.equal(f.elapsed(), 20_000);
  });

  for (const reason of [
    "timeout",
    "socket closed",
    "protocol failure",
    "evaluation exception",
  ]) {
    test(`${entry.name} document preserves the first ${reason} and stops before later actions`, async () => {
      const error = new Error(`original ${reason}`);
      const f = fixture(entry, { values: [error, true], remaining: true });
      await assert.rejects(f.run(), (actual) => actual === error);
      assert.equal(f.reads.length, 1);
      assert.equal(f.elapsed(), 0);
      assert.deepEqual(f.later, []);
    });
  }

  for (const value of [undefined, null, 0, "", "true", 1]) {
    test(`${entry.name} document rejects non-boolean ${JSON.stringify(value)} without polling`, async () => {
      const f = fixture(entry, { values: [value, true] });
      await assert.rejects(f.run(), /readiness must be boolean/);
      assert.equal(f.reads.length, 1);
      assert.equal(f.elapsed(), 0);
    });
  }
}

function inspectFixture(values) {
  let now = 0;
  const calls = [];
  const run = runInNewContext(`${inspection.only}; run`, {
    Date: { now: () => now },
    delay: async (ms) => {
      now += ms;
    },
    UserBrowserDocumentChangedBeforeDispatchError,
    sessionId: "owned-session",
    opened: { tabId: "owned-agent" },
    connection: {
      backend: {
        inspect: async (...args) => {
          calls.push(args);
          const value = values[calls.length - 1];
          if (value instanceof Error) throw value;
          return value;
        },
      },
    },
  });
  return { run, calls, elapsed: () => now };
}

test("startup inspect retries only a document change before dispatch", async () => {
  const f = inspectFixture([
    new UserBrowserDocumentChangedBeforeDispatchError(),
    {},
  ]);
  assert.equal(await f.run(), "ready");
  assert.deepEqual(f.calls, [
    ["owned-session", "owned-agent"],
    ["owned-session", "owned-agent"],
  ]);
  assert.equal(f.elapsed(), 50);
});

for (const reason of [
  "unknown outcome",
  "Page.createIsolatedWorld timeout",
  "document changed before action dispatch",
]) {
  test(`startup inspect preserves ${reason} without retry`, async () => {
    const error = new Error(reason);
    const f = inspectFixture([error, {}]);
    await assert.rejects(f.run(), (actual) => actual === error);
    assert.equal(f.calls.length, 1);
    assert.equal(f.elapsed(), 0);
  });
}
