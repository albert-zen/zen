import assert from "node:assert/strict";
import test from "node:test";
import { CodeRuntime, CodeRuntimeError } from "../src/code-runtime.js";

const execute = (code: string) =>
  new CodeRuntime().execute({
    code,
    nested: { invoke: async () => ({ output: "", exitCode: 0 }) },
    signal: new AbortController().signal,
  });

test("uncaught user errors report their source position and preserve prior output", async () => {
  await assert.rejects(
    execute('text("before");\nthrow new Error("boom");'),
    (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.match(
        error.message,
        /boom\nrun_code:2:7\nthrow new Error\("boom"\);\n {6}\^/,
      );
      assert.doesNotMatch(
        error.message,
        /node:internal|code-runtime-worker|evalmachine/,
      );
      assert.equal(error.result?.text, "before");
      return true;
    },
  );
});

test("syntax errors identify the input token before execution", async () => {
  await assert.rejects(
    execute('text("not executed");\nconst x = ;'),
    (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.match(error.message, /run_code:2:11\nconst x = ;\n {10}\^/);
      assert.equal(error.result?.text, "");
      return true;
    },
  );
});

test("import.meta and timer failures use user positions", async () => {
  for (const [code, location] of [
    // V8 attributes import.meta initialization to the enclosing statement.
    ['text("before");\ntext(import.meta);', /run_code:2:1/],
    [
      'await new Promise(() => {\n  setTimeout(() => { throw new Error("timer"); }, 1);\n});',
      /run_code:2:28/,
    ],
  ] as const) {
    await assert.rejects(execute(code), (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.match(error.message, location);
      assert.doesNotMatch(error.message, /node:internal|evalmachine/);
      return true;
    });
  }
});

test("static imports and re-exports locate their declaration, dynamic imports retain their callsite", async () => {
  for (const code of [
    'const x = 1;\nimport "node:fs";',
    'const x = 1;\nexport * from "node:fs";',
    'const x = 1;\nawait import("node:fs");',
  ]) {
    await assert.rejects(execute(code), (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.match(error.message, /Imports are unavailable/);
      assert.match(error.message, /run_code:2:\d+/);
      assert.doesNotMatch(error.message, /node:internal|code-runtime-worker/);
      return true;
    });
  }
});

test("pragma and CRLF lines count toward source locations and snippets stay short", async () => {
  const prefix = " ".repeat(400);
  await assert.rejects(
    execute(
      '// @exec: {"yield_time_ms": 10000}\r\n' +
        prefix +
        'throw new Error("long");',
    ),
    (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.match(error.message, /run_code:2:407/);
      assert(error.message.length < 400);
      assert.match(error.message, /…/);
      return true;
    },
  );
});

test("unlocatable thrown values and hostile stack getters preserve useful messages", async () => {
  for (const code of [
    'throw "plain failure";',
    'const error = new Error("plain failure"); Object.defineProperty(error, "stack", {get() {throw 1}}); throw error;',
  ]) {
    await assert.rejects(execute(code), (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.equal(error.message, "plain failure");
      return true;
    });
  }
});
