import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
const source = readFileSync(
  new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("        for (const kind of directKinds)");
const end = source.indexOf(
  '        if (options.remoteFrameInput === "supported")',
  start,
);
assert.ok(start > 0 && end > start);
function witness(mode, kind, fault) {
  const sends = [];
  let guardCalls = 0,
    read = 0;
  const before = {
    events: [],
    values: { "text-a": "" },
    clicks: 0,
    visibility: "hidden",
    documentId: "same-document",
  };
  const eventTypes =
    kind === "click" ? ["pointerdown", "pointerup"] : ["keydown", "keyup"];
  const after = {
    ...before,
    events: eventTypes.map((type) => ({
      type,
      trusted: fault !== "untrusted",
      target:
        fault === "wrong-target"
          ? "other"
          : kind === "click"
            ? "canvas"
            : "text-a",
    })),
    values: { "text-a": fault === "wrong-effect" ? "" : " " },
    clicks: fault === "wrong-effect" ? 0 : 1,
    visibility: fault === "visible" ? "visible" : "hidden",
  };
  const script = `(async () => { let remoteWitness; const cases = []; ${source.slice(start, end)}; return {remoteWitness,cases}; })()`;
  const result = runInNewContext(
    ts.transpileModule(script, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      // Normalize realm prototypes, not contents, for plain synthetic receipts.
      assert: {
        ...assert,
        deepEqual: (actual, expected) =>
          assert.deepEqual(
            JSON.parse(JSON.stringify(actual)),
            JSON.parse(JSON.stringify(expected)),
          ),
      },
      mode,
      directKinds: [kind],
      placement: {},
      console: { log() {} },
      focus: async () => ({
        inner: fault === "wrong-focus" ? "other" : "text-a",
      }),
      state: async () => (read++ === 0 ? before : after),
      guard: async () => {
        guardCalls++;
        if (fault === "foreground") throw new Error("foreground drift");
      },
      assertRemoteFixturePoint: (point, id, depth) => {
        assert.equal(id, "canvas");
        assert.equal(point.documentId, "same-document");
        assert.equal(depth, mode.startsWith("nested-") ? 2 : 1);
      },
      rpc: {
        evaluate: async () => ({
          x: 12,
          y: 34,
          documentId: fault === "document" ? "replacement" : "same-document",
        }),
        send: async (method, params) => {
          sends.push({ method, params });
          if (method === "Page.captureScreenshot")
            throw new Error("unnecessary compositor prerequisite");
          if (fault === "unknown") throw new Error("unknown dispatched input");
          return {};
        },
      },
      settleRemoteFixturePair: async (read) => ({
        state: await read(),
        reads: 1,
      }),
    },
  );
  return { result, sends, guards: () => guardCalls };
}
for (const mode of [
  "cross-origin-same-process",
  "cross-origin-oopif",
  "nested-oopif",
  "nested-same-process",
]) {
  for (const kind of mode === "cross-origin-same-process"
    ? ["click", "key"]
    : ["key"])
    test(`${mode} ${kind} witnesses exact trusted effect without a second image`, async () => {
      const f = witness(mode, kind);
      const r = await f.result;
      assert.equal(r.remoteWitness.status, "passed");
      assert.equal(r.remoteWitness.compositorCaptured, undefined);
      assert.deepEqual(
        f.sends.map((s) => s.method),
        Array(2).fill(
          kind === "click"
            ? "Input.dispatchMouseEvent"
            : "Input.dispatchKeyEvent",
        ),
      );
      assert.equal(f.guards(), 3);
      assert.equal(r.cases[0].trustedPair, true);
      assert.equal(r.cases[0].effect, true);
    });
}
for (const fault of ["untrusted", "wrong-target", "wrong-effect", "visible"])
  test(`direct key witness still rejects ${fault}`, async () => {
    const f = witness("nested-oopif", "key", fault);
    await assert.rejects(f.result);
    assert.equal(f.sends.length, 2);
  });
for (const fault of ["wrong-focus", "foreground"])
  test(`direct witness rejects ${fault} before input`, async () => {
    const f = witness("nested-oopif", "key", fault);
    await assert.rejects(f.result);
    assert.equal(f.sends.length, 0);
  });
test("unknown direct input never sends release or retries", async () => {
  const f = witness("nested-oopif", "key", "unknown");
  await assert.rejects(f.result, /unknown dispatched input/);
  assert.equal(f.sends.length, 1);
});
test("direct mouse geometry must belong to the same document", async () => {
  const f = witness("cross-origin-same-process", "click", "document");
  await assert.rejects(f.result);
  assert.equal(f.sends.length, 0);
});
