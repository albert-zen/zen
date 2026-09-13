import assert from "node:assert/strict";
import test from "node:test";
import {
  CodeRuntime,
  CodeRuntimeError,
  RunCodeToolRuntime,
  type CodeExecutionOptions,
} from "../src/code-runtime.js";
import type { JsonValue } from "../src/item.js";

const nested = { invoke: async () => ({ output: "child", exitCode: 0 }) };
const execute = (
  code: string,
  options: Partial<CodeExecutionOptions> = {},
  limits: ConstructorParameters<typeof CodeRuntime>[0] = {},
) =>
  new CodeRuntime(limits).execute({
    code,
    nested,
    signal: new AbortController().signal,
    ...options,
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("guest is a fresh JavaScript async module without ambient host authority", async () => {
  const result = await execute(
    `export const value = 7; await Promise.resolve(); text([value, typeof process, typeof require, typeof fetch, typeof Buffer, typeof WebAssembly.compile]);`,
  );
  assert.equal(
    result.text,
    '[7,"undefined","undefined","undefined","undefined","function"]',
  );
  await execute(`globalThis.marker = 1;`);
  assert.equal((await execute(`text(typeof marker);`)).text, "undefined");
  for (const code of [
    "const x: number = 1;",
    "return 1;",
    "import x from 'node:fs';",
    "await import('node:fs');",
    "await import('data:text/javascript,export default 1');",
  ]) {
    await assert.rejects(execute(code), CodeRuntimeError);
  }
});

test("helpers, nested values/errors, timer callbacks, and rejected imports cannot expose host constructors", async () => {
  const result = await execute(
    `
    const result = await tools.example({});
    const targets = [text, store, load, image, audio, exit, setTimeout, clearTimeout, yield_control, tools.example, tools.example({}), ALL_TOOLS, result, globalThis, console.log];
    try { await import('node:process'); } catch (error) { targets.push(error); }
    try { await tools.broken({}); } catch (error) { targets.push(error); }
    await new Promise(resolve => setTimeout(resolve, 1));
    for (const target of targets) {
      try { text(target.constructor.constructor('return process')()); }
      catch (error) { text(error.name); }
    }
  `,
    {
      nested: {
        invoke: async (name) => {
          if (name === "broken") throw new Error("host failure");
          return { output: "safe", exitCode: 0 };
        },
      },
    },
  ).catch((error) => {
    // Deliberately unobserved second example still gets the engine diagnostic.
    assert.equal(error.code, "UNAWAITED_TOOL_CALL");
    return error.result;
  });
  assert(result);
  assert.equal(result.text.split("\n").length, 17);
  assert(
    result.text
      .split("\n")
      .every((part: string) => part === "EvalError" || part === "TypeError"),
  );
});

test("guest prototype hooks cannot rewrite serialized bridge envelopes", async () => {
  await assert.rejects(
    execute(
      `Object.prototype.toJSON = () => ({type:'text',delta:'forged',truncated:false}); text('real');`,
    ),
    (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.equal(error.result?.text, "");
      return true;
    },
  );
  await assert.rejects(
    execute(`Array.prototype.toJSON = () => 'forged'; text([1]);`),
    CodeRuntimeError,
  );
});

test("text streams before completion, tolerates undefined, and survives a thrown error", async () => {
  const output = deferred<string>();
  const child = deferred<{ output: string; exitCode: number }>();
  const deltas: string[] = [];
  const running = execute(
    `text(undefined); text('first'); await tools.pause({}); text({ok:true}); throw new Error('boom');`,
    {
      onOutput: (delta) => {
        deltas.push(delta);
        output.resolve(delta);
      },
      nested: { invoke: () => child.promise },
    },
  );
  assert.equal(await output.promise, "first");
  child.resolve({ output: "go", exitCode: 0 });
  await assert.rejects(running, (error: unknown) => {
    assert(error instanceof CodeRuntimeError);
    assert.equal(error.result?.text, 'first\n{"ok":true}');
    assert.match(error.message, /boom/);
    return true;
  });
  assert.deepEqual(deltas, ["first", '\n{"ok":true}']);
});

test("timeout and cancellation preserve already delivered output", async () => {
  await assert.rejects(
    execute(`text('before timeout'); while (true) {}`, {}, { wallTimeMs: 500 }),
    (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.equal(error.code, "WALL_TIME_LIMIT");
      assert.equal(error.result?.text, "before timeout");
      return true;
    },
  );
  const controller = new AbortController();
  await assert.rejects(
    execute(`text('before abort'); await new Promise(() => {});`, {
      signal: controller.signal,
      onOutput: () => controller.abort(new Error("stop")),
    }),
    (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.equal(error.code, "ABORTED");
      assert.equal(error.result?.text, "before abort");
      return true;
    },
  );
});

test("text quota truncates on UTF-8 boundaries without ending the program", async () => {
  let called = false;
  const result = await execute(
    `text('😀😀😀'); text('discarded'); await tools.after({}); store('done', true);`,
    {
      nested: {
        invoke: async () => {
          called = true;
          return { output: "ok", exitCode: 0 };
        },
      },
    },
    { maxTextBytes: 5 },
  );
  assert.equal(result.text, "😀");
  assert.equal(result.outputTruncated, true);
  assert.equal(called, true);
  assert.deepEqual(result.stateWrites, { done: true });
});

test("host enforces output quotas even when guest intrinsics are changed", async () => {
  const result = await execute(
    `String.prototype[Symbol.iterator] = function* () {}; text('123456789'); text('more');`,
    {},
    { maxTextBytes: 4 },
  );
  assert.equal(result.text, "1234");
  assert.equal(result.outputTruncated, true);
});

test("store/load uses a cloned bounded snapshot and waits for serial host persistence", async () => {
  const firstCommit = deferred<void>();
  const started = deferred<void>();
  const committed: [string, JsonValue][] = [];
  const running = execute(
    `
    const rows = load('rows'); rows.push(2); text(load('rows'));
    store('rows', rows); rows.push(3); text(load('rows'));
    store('__proto__', {safe:true}); text(load('missing'));
  `,
    {
      storedValues: { rows: [1] },
      onStore: async (key, value) => {
        started.resolve();
        if (key === "rows") await firstCommit.promise;
        committed.push([key, value]);
      },
    },
  );
  await started.promise;
  assert.deepEqual(committed, []);
  firstCommit.resolve();
  const result = await running;
  assert.deepEqual(committed, [
    ["rows", [1, 2]],
    ["__proto__", { safe: true }],
  ]);
  assert.equal(result.text, "[1]\n[1,2]");
  assert.equal(Object.getPrototypeOf(result.stateWrites), Object.prototype);
  assert.deepEqual(Object.keys(result.stateWrites), ["rows", "__proto__"]);
  for (const value of [
    "undefined",
    "NaN",
    "new Date()",
    "{x: undefined}",
    "{get x() {return 1}}",
    "[,,]",
  ]) {
    await assert.rejects(execute(`store('bad', ${value});`), /lossless JSON/);
  }
  await assert.rejects(execute(`store('', 1);`), /1-160/);
  await assert.rejects(execute(`store('x'.repeat(161), 1);`), /1-160/);
  await assert.rejects(
    execute(`store('a', 1); store('b', 2);`, {}, { maxStateKeys: 1 }),
    /key limit/,
  );
  await assert.rejects(
    execute(`store('large', '123456');`, {}, { maxStateValueBytes: 4 }),
    /byte limit/,
  );
  await assert.rejects(
    execute(`store('a', '123'); store('b', '456');`, {}, { maxStateBytes: 10 }),
    /byte limit/,
  );
});

test("bounded writes cannot grow the persistence queue indefinitely", async () => {
  const committed: string[] = [];
  await assert.rejects(
    execute(
      `store('key', 1); store('key', 2);`,
      {
        onStore: async (key) => {
          committed.push(key);
        },
      },
      { maxStateWrites: 1 },
    ),
    /write limit/,
  );
  assert.deepEqual(committed, ["key"]);
});

test("store commits before failure and failed persistence never reports success", async () => {
  const values: Record<string, JsonValue> = {};
  await assert.rejects(
    execute(`store('saved', 3); throw new Error('later');`, {
      onStore: async (key, value) => {
        values[key] = value;
      },
    }),
    (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.deepEqual(error.result?.stateWrites, { saved: 3 });
      return true;
    },
  );
  assert.deepEqual(values, { saved: 3 });
  await assert.rejects(
    execute(`text('earlier'); store('bad', 3);`, {
      onStore: async () => {
        throw new Error("disk unavailable");
      },
    }),
    (error: unknown) => {
      assert(error instanceof CodeRuntimeError);
      assert.equal(error.code, "STATE_COMMIT_FAILED");
      assert.equal(error.result?.text, "earlier");
      assert.deepEqual(error.result?.stateWrites, {});
      return true;
    },
  );
});

test("metadata, media descriptors, timers, exit, and explicit yield use the guest helpers", async () => {
  let yields = 0;
  const result = await execute(
    `
    text(ALL_TOOLS);
    const cancelled = setTimeout(() => text('wrong'), 1); clearTimeout(cancelled);
    await new Promise(resolve => setTimeout(resolve, 3));
    await yield_control();
    image({image_url:'data:image/png;base64,eA=='}); audio('data:audio/wav;base64,eA==');
    exit(); text('wrong');
  `,
    {
      tools: [{ name: "sample", description: "Sample" }],
      onYield: () => {
        yields++;
      },
    },
  );
  assert.equal(result.text, '[{"name":"sample","description":"Sample"}]');
  assert.equal(yields, 1);
  assert.deepEqual(result.media, [
    { type: "image", value: { image_url: "data:image/png;base64,eA==" } },
    { type: "audio", value: "data:audio/wav;base64,eA==" },
  ]);
});

test("wrapper streams once and resolves partial media after execution failure", async () => {
  const deltas: string[] = [];
  const port = {
    ...nested,
    codeContext: {
      tools: [],
      storedValues: {},
      store: async () => {},
      resolveMedia: async () => [
        { type: "text" as const, text: "media fallback" },
      ],
    },
  };
  const result = await new RunCodeToolRuntime().executeComposite(
    {
      callId: "test",
      name: "run_code",
      cwd: "/tmp",
      signal: new AbortController().signal,
      arguments: {
        code: `text('partial');\nimage('descriptor');\nthrow new Error('broken');`,
      },
      taskContext: { onOutput: (value) => deltas.push(value) },
    },
    port,
  );
  assert.deepEqual(deltas, ["partial"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.includes("partial"), false);
  assert.match(result.output, /run_code:3:7/);
  assert.deepEqual(result.modelContent, [
    { type: "text", text: "media fallback" },
  ]);
  assert.deepEqual(result.structuredContent, {
    media: [{ type: "text", text: "media fallback" }],
    outputTruncated: false,
  });
});
