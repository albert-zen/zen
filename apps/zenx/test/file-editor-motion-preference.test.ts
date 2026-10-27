import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const { prepareFileEditorMotion } = createRequire(import.meta.url)(
  "../scripts/file-editor-motion-preference.cjs",
);

function fixture(reduced = true) {
  const calls: string[] = [];
  const receipts: any[] = [];
  let navigated = false;
  const webContents = {
    async loadURL(url: string) {
      assert.equal(url, "about:blank");
      calls.push("navigate");
      navigated = true;
    },
    debugger: {
      attach(version: string) {
        assert.equal(version, "1.3");
        assert.ok(
          navigated,
          "must navigate before attaching/awaiting renderer commands",
        );
        calls.push("attach");
      },
      async sendCommand(method: string, params: unknown) {
        assert.ok(navigated);
        assert.equal(method, "Emulation.setEmulatedMedia");
        assert.deepEqual(params, {
          features: [
            {
              name: "prefers-reduced-motion",
              value: reduced ? "reduce" : "no-preference",
            },
          ],
        });
        calls.push("emulate");
      },
    },
    async executeJavaScript(expression: string) {
      assert.match(expression, /matchMedia/u);
      calls.push("verify");
      return reduced;
    },
  };
  return {
    webContents,
    calls,
    receipts,
    save: async (receipt: any) => {
      receipts.push(receipt);
    },
  };
}

test("unset preference is inert; both requested modes bootstrap before any renderer command", async () => {
  const untouched = fixture();
  await prepareFileEditorMotion(
    untouched.webContents,
    undefined,
    untouched.save,
  );
  assert.deepEqual(untouched.calls, []);
  assert.deepEqual(untouched.receipts, []);
  for (const reduced of [true, false]) {
    const f = fixture(reduced);
    const result = await prepareFileEditorMotion(
      f.webContents,
      reduced ? "reduce" : "no-preference",
      f.save,
    );
    assert.deepEqual(f.calls, ["navigate", "attach", "emulate", "verify"]);
    assert.equal(result.status, "ready");
    assert.equal(result.reducedMotion, reduced);
  }
});

test("missing bootstrap document preserves its failure without evaluating a target", async () => {
  const f = fixture();
  const original = new Error("bootstrap did not navigate");
  f.webContents.loadURL = async () => {
    throw original;
  };
  await assert.rejects(
    prepareFileEditorMotion(f.webContents, "reduce", f.save),
    (error) => error === original,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.receipts.at(-1).phase, "bootstrap-document");
  assert.equal(f.receipts.at(-1).status, "failed");
});

test("media command timeout leaves failure metadata and late completion cannot advance setup", async () => {
  const f = fixture();
  let complete: () => void = () => {};
  f.webContents.debugger.sendCommand = () =>
    new Promise<void>((resolve) => {
      complete = resolve;
    });
  await assert.rejects(
    prepareFileEditorMotion(f.webContents, "reduce", f.save, 1),
    /Motion setup exceeded 1 ms at emulate-media/u,
  );
  const receiptCount = f.receipts.length;
  complete();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(f.receipts.length, receiptCount);
  assert.equal(f.receipts.at(-1).status, "failed");
  assert.ok(!f.calls.includes("verify"));
});

test("command rejection and actual-media mismatch fail before native fixture input", async () => {
  const f = fixture();
  const original = new Error("emulation rejected");
  f.webContents.debugger.sendCommand = async () => {
    throw original;
  };
  await assert.rejects(
    prepareFileEditorMotion(f.webContents, "reduce", f.save),
    (error) => error === original,
  );
  assert.equal(f.receipts.at(-1).phase, "emulate-media");
  assert.ok(!f.calls.includes("verify"));
  const mismatch = fixture();
  mismatch.webContents.executeJavaScript = async () => false;
  await assert.rejects(
    prepareFileEditorMotion(mismatch.webContents, "reduce", mismatch.save),
    /Bootstrap renderer uses the requested media preference/u,
  );
  assert.equal(mismatch.receipts.at(-1).status, "failed");
  assert.equal(mismatch.receipts.at(-1).phase, "verify-media");
  assert.equal(mismatch.receipts.at(-1).reducedMotion, false);
});

test("failure-receipt persistence cannot replace the original command error", async () => {
  const f = fixture();
  const original = new Error("original command failure");
  f.webContents.debugger.sendCommand = async () => {
    throw original;
  };
  await assert.rejects(
    prepareFileEditorMotion(f.webContents, "reduce", async (receipt: any) => {
      f.receipts.push(receipt);
      if (receipt.status === "failed")
        throw new Error("receipt persistence failure");
    }),
    (error) => error === original,
  );
  assert.match(f.receipts.at(-1).failure, /original command failure/u);
});

test("an unresponsive bootstrap or verification target is bounded without renderer-dependent failure capture", async () => {
  for (const phase of ["bootstrap-document", "verify-media"]) {
    const f = fixture();
    if (phase === "bootstrap-document")
      f.webContents.loadURL = () => new Promise<void>(() => {});
    else f.webContents.executeJavaScript = () => new Promise<boolean>(() => {});
    await assert.rejects(
      prepareFileEditorMotion(f.webContents, "reduce", f.save, 1),
      new RegExp(`Motion setup exceeded 1 ms at ${phase}`, "u"),
    );
    assert.equal(f.receipts.at(-1).status, "failed");
    assert.equal(f.receipts.at(-1).phase, phase);
    if (phase === "bootstrap-document") assert.deepEqual(f.calls, []);
  }
});
