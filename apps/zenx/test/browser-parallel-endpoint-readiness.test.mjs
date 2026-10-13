import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the actual startup read and existing bounded poll, without launching
// Chrome or importing the native entrypoint. Native readiness still needs CI.
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
const main = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "main",
);
const poll = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "poll",
);
let port;
function findPort(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "port")
    port = node;
  ts.forEachChild(node, findPort);
}
assert.ok(main && poll);
findPort(main);
assert.ok(port && ts.isAwaitExpression(port.initializer));
const executable = ts.transpileModule(
  `${poll.getText(ast)}; async function discover() { return ${port.initializer.getText(ast)}; }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture(options = {}) {
  let now = 0;
  const reads = [];
  const browser = { exitCode: null, signalCode: null };
  const discover = runInNewContext(`${executable}; discover`, {
    path: path.posix,
    profile: "/tmp/owned/browser-profile",
    process: { platform: options.platform ?? "win32" },
    browser,
    browserError: "owned process stopped",
    Date: { now: () => now },
    delay: async (ms) => {
      assert.equal(ms, 50);
      now += ms;
      if (options.exitAfterDelay) browser.exitCode = 1;
    },
    readFile: async (...args) => {
      reads.push(args);
      const value = options.values?.[reads.length - 1] ?? options.repeat;
      if (value instanceof Error) throw value;
      assert.equal(typeof value, "string");
      return value;
    },
  });
  return { discover, reads, elapsed: () => now };
}
const failure = (code) =>
  Object.assign(new Error(`original ${code}`), { code });

test("owned Windows endpoint polls missing and writer-locked file before returning port", async () => {
  const f = fixture({
    values: [
      failure("ENOENT"),
      failure("EBUSY"),
      "",
      "53354\r\n/devtools/browser/owned\r\n",
    ],
  });
  assert.equal(await f.discover(), "53354");
  assert.equal(f.elapsed(), 150);
  assert.equal(f.reads.length, 4);
  for (const args of f.reads)
    assert.deepEqual(args, [
      "/tmp/owned/browser-profile/DevToolsActivePort",
      "utf8",
    ]);
});

test("owned Windows endpoint keeps repeated EBUSY within the original 20-second deadline", async () => {
  const f = fixture({ repeat: failure("EBUSY") });
  await assert.rejects(
    f.discover(),
    /Timed out waiting for owned browser DevTools endpoint/,
  );
  assert.equal(f.elapsed(), 20000);
  assert.equal(f.reads.length, 400);
});

for (const code of ["EACCES", "EPERM", "EIO", "EUNKNOWN", undefined]) {
  test(`owned endpoint preserves ${String(code)} read failure without polling`, async () => {
    const error = failure(code);
    const f = fixture({ repeat: error });
    await assert.rejects(f.discover(), (value) => value === error);
    assert.equal(f.elapsed(), 0);
    assert.equal(f.reads.length, 1);
  });
}

test("non-Windows endpoint preserves EBUSY without expanding transient errors", async () => {
  const error = failure("EBUSY");
  const f = fixture({ repeat: error, platform: "darwin" });
  await assert.rejects(f.discover(), (value) => value === error);
  assert.equal(f.reads.length, 1);
});

test("endpoint polling stops on owned browser exit before another file read", async () => {
  const f = fixture({ repeat: failure("EBUSY"), exitAfterDelay: true });
  await assert.rejects(
    f.discover(),
    /Owned browser exited: owned process stopped/,
  );
  assert.equal(f.reads.length, 1);
  assert.equal(f.elapsed(), 50);
});
