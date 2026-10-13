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
  const start = runInNewContext(`${executable}; startNative`, {
    assert,
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
    [5000, 5000, 5000, 60000],
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
for (const stage of ["compiler", "sdk", "compile"]) {
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
