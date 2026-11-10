import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("  const paired = async (");
const end = source.indexOf("  const rejected = async (", start);
assert.ok(start > 0 && end > start);

test("product acceptance has no direct-CDP fixture oracle prerequisite", () => {
  assert.ok(!source.includes("direct-root-cdp-fixture-oracle"));
  assert.ok(!source.includes("directKinds"));
  const paired = source.slice(start, end);
  assert.match(paired, /await inspect\(\)/);
  assert.match(paired, /backend\.pointerClick!/);
  assert.match(paired, /backend\.keyPress!/);
  assert.ok(!paired.includes("rpc.send"));
  assert.match(source, /case: "provider-remote-canvas"/);
  assert.match(source, /case: "provider-remote-text"/);
});

function exercise(kind, fault) {
  const inputs = [];
  const calls = [];
  const id = kind === "click" ? "canvas" : "text-a";
  const before = {
    mode: "cross-origin-same-process",
    events: [],
    clicks: 0,
    values: { "text-a": "" },
  };
  const after = {
    ...before,
    events: (kind === "click"
      ? ["pointerdown", "pointerup"]
      : ["keydown", "keyup"]
    ).map((type) => ({
      type,
      trusted: fault !== "untrusted",
      target: fault === "wrong-target" ? "other" : id,
    })),
    clicks: fault === "wrong-effect" ? 0 : 1,
    values: { "text-a": fault === "wrong-effect" ? "" : " " },
  };
  let reads = 0;
  const dispatch = async (...args) => {
    calls.push({ kind, args });
    if (fault === "unknown") throw new Error("unknown input outcome");
    for (const type of kind === "click"
      ? ["mousePressed", "mouseReleased"]
      : ["keyDown", "keyUp"])
      inputs.push({
        type,
        method:
          kind === "click"
            ? "Input.dispatchMouseEvent"
            : "Input.dispatchKeyEvent",
        sessionId: "child",
        socketId: 1,
      });
  };
  const script = `(async () => { ${source.slice(start, end)}; return paired(${JSON.stringify(kind)}, ${JSON.stringify(id)}); })()`;
  const result = runInNewContext(
    ts.transpileModule(script, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      assert: {
        ...assert,
        deepEqual: (a, b) =>
          assert.deepEqual(
            JSON.parse(JSON.stringify(a)),
            JSON.parse(JSON.stringify(b)),
          ),
      },
      backend: { pointerClick: dispatch, keyPress: dispatch },
      sessionId: "product-session",
      tabId: "owned-tab",
      inspect: async () => {
        calls.push({ kind: "inspect" });
        if (fault === "capture") throw new Error("product capture failed");
        return {
          observationId: "product-observation",
          focusedInputAvailable: true,
        };
      },
      focus: async () => ({ inner: id }),
      point: async () => ({ x: 12, y: 34 }),
      state: async () => (reads++ === 0 ? before : after),
      inputs,
      isRemoteFrameMode: () => true,
      providerRootSession: {},
      providerPlacement: {},
      assertRemoteFixturePoint: () => {},
      assertRemoteProviderRoute: () => {
        if (fault === "wrong-route") throw new Error("wrong product route");
      },
      settleRemoteFixturePair: async (read) => ({ state: await read() }),
      guard: async () => {
        if (fault === "foreground") throw new Error("foreground drift");
      },
    },
  );
  return { result, calls };
}
for (const kind of ["click", "key"]) {
  test(`product ${kind} obtains its own observation and dispatches through backend`, async () => {
    const e = exercise(kind);
    await e.result;
    assert.deepEqual(
      e.calls.map((c) => c.kind),
      ["inspect", kind],
    );
    assert.deepEqual(e.calls[1].args.slice(0, 3), [
      "product-session",
      "owned-tab",
      "product-observation",
    ]);
  });
  for (const fault of [
    "untrusted",
    "wrong-target",
    "wrong-effect",
    "wrong-route",
    "foreground",
    "capture",
    "unknown",
  ]) {
    test(`product ${kind} still rejects ${fault} without replay`, async () => {
      const e = exercise(kind, fault);
      await assert.rejects(e.result);
      assert.equal(
        e.calls.filter((c) => c.kind === kind).length,
        fault === "capture" ? 0 : 1,
      );
    });
  }
}
