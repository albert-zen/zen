import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the actual fixture function without importing its native entrypoint.
// This verifies invocation/lifecycle only; the macOS job must compile and run it.
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
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "startNative",
);
assert.ok(declaration);
const executable = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiler = "/Applications/Xcode Test.app/Toolchains/usr/bin/swiftc";
const sdk = "/Applications/Xcode Test.app/SDKs/MacOSX.sdk";

function fixture(options = {}) {
  const calls = [],
    started = [],
    written = [];
  let now = 1_000;
  const start = runInNewContext(`${executable}; startNative`, {
    assert,
    Date: { now: () => now },
    path: path.posix,
    process: { platform: options.platform ?? "darwin" },
    MAC_NATIVE: "fixed swift source",
    WINDOWS_NATIVE: "fixed powershell source",
    writeFile: async (...args) => written.push(args),
    runFile: async (file, args, limits) => {
      const stage =
        file === "/usr/bin/xcode-select"
          ? "developer"
          : args.includes("--find")
            ? "compiler"
            : args.includes("--show-sdk-path")
              ? "sdk"
              : "compile";
      calls.push({ file, args: Array.from(args), limits });
      if (stage === options.failAt) throw options.error;
      const elapsed = options.elapsed?.[stage] ?? 0;
      if (elapsed > limits.timeout)
        throw new Error(`fixture ${stage} discovery exceeded its budget`);
      now += elapsed;
      if (stage === options.pauseAfter) now += options.pauseMs;
      if (stage === "compiler")
        return { stdout: options.compiler ?? `${compiler}\n` };
      if (stage === "sdk") return { stdout: options.sdk ?? `${sdk}\n` };
      return { stdout: "" };
    },
    Native: class {
      constructor(file, args) {
        started.push({ file, args: Array.from(args) });
      }
    },
  });
  return { start, calls, started, written };
}

test("parallel Mac helper selects and passes the exact macOS SDK as a single argument", async () => {
  const f = fixture();
  await f.start("/tmp/owned fixture");
  assert.deepEqual(
    f.calls.map(({ file, args }) => ({ file, args })),
    [
      { file: "/usr/bin/xcode-select", args: ["--print-path"] },
      { file: "/usr/bin/xcrun", args: ["--sdk", "macosx", "--find", "swiftc"] },
      { file: "/usr/bin/xcrun", args: ["--sdk", "macosx", "--show-sdk-path"] },
      {
        file: compiler,
        args: [
          "-sdk",
          sdk,
          "-swift-version",
          "5",
          "-module-cache-path",
          "/tmp/owned fixture/swift-cache",
          "/tmp/owned fixture/Native.swift",
          "-o",
          "/tmp/owned fixture/native-fixture",
        ],
      },
    ],
  );
  assert.deepEqual(
    f.calls.map(({ limits }) => limits.timeout),
    [5000, 20000, 20000, 60000],
  );
  assert.deepEqual(f.started, [
    { file: "/tmp/owned fixture/native-fixture", args: [] },
  ]);
  assert.equal(f.written.length, 1);
});

for (const field of ["compiler", "sdk"]) {
  test(`parallel Mac helper refuses empty ${field} discovery before compilation`, async () => {
    const f = fixture({ [field]: " \n" });
    await assert.rejects(f.start("/tmp/owned"), /absolute path/);
    assert.equal(f.started.length, 0);
    assert.equal(
      f.calls.some(({ file }) => file === compiler || file.trim() === ""),
      false,
    );
  });
}
for (const stage of ["developer", "compiler", "sdk", "compile"]) {
  test(`parallel Mac helper retains ${stage} failure without retry or launch`, async () => {
    const error = new Error(`original ${stage} failure`);
    const f = fixture({ failAt: stage, error });
    await assert.rejects(f.start("/tmp/owned"), (value) => value === error);
    assert.equal(f.started.length, 0);
    assert.ok(f.calls.filter(({ file }) => file === compiler).length <= 1);
  });
}

test("Windows native fixture does not discover or compile a macOS SDK", async () => {
  const f = fixture({ platform: "win32" });
  await f.start("/tmp/owned");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.started, [
    {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "fixed powershell source",
      ],
    },
  ]);
});

// Cold xcrun lookup can exceed five seconds on a fresh hosted macOS runner.
// The three read-only discoveries share one budget; nothing is retried.
test("parallel Mac discovery admits a cold lookup within one 20-second budget", async () => {
  const f = fixture({
    elapsed: { developer: 1000, compiler: 9000, sdk: 2000 },
  });
  await f.start("/tmp/owned");
  assert.deepEqual(
    f.calls.map(({ limits }) => limits.timeout),
    [5000, 19000, 10000, 60000],
  );
  assert.equal(f.calls.length, 4);
  assert.equal(f.started.length, 1);
});

test("parallel Mac discovery failure uses only the remaining budget without replay", async () => {
  const f = fixture({
    elapsed: { developer: 1000, compiler: 14000, sdk: 6000 },
  });
  await assert.rejects(
    f.start("/tmp/owned"),
    /sdk discovery exceeded its budget/,
  );
  assert.deepEqual(
    f.calls.map(({ limits }) => limits.timeout),
    [5000, 19000, 5000],
  );
  assert.equal(f.written.length, 0);
  assert.equal(f.started.length, 0);
});

for (const stage of ["developer", "compiler", "sdk"]) {
  test(`parallel Mac discovery refuses work after the shared deadline at ${stage}`, async () => {
    const f = fixture({ pauseAfter: stage, pauseMs: 20000 });
    await assert.rejects(
      f.start("/tmp/owned"),
      /macOS toolchain discovery timed out/,
    );
    assert.equal(
      f.calls.length,
      ["developer", "compiler", "sdk"].indexOf(stage) + 1,
    );
    assert.equal(f.written.length, 0);
    assert.equal(f.started.length, 0);
  });
}
