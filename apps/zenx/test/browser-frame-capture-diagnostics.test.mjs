import assert from "node:assert/strict";
import test from "node:test";
import { observeFramePreparation } from "../scripts/browser-frame-capture-diagnostics.mjs";

test("frame preparation observer preserves the exact promise, success object and receiver", async () => {
  const capture = {
    snapshot: {
      documentKey: "fixture-document",
      viewport: { width: 800 },
      focusId: null,
    },
  };
  const promise = Promise.resolve(capture);
  let receiver, parameters;
  const prototype = {
    prepare(...args) {
      receiver = this;
      parameters = args;
      return promise;
    },
  };
  const original = prototype.prepare;
  const observer = observeFramePreparation(prototype, (record) => {
    if (record.viewport) record.viewport.width = 1;
    throw Error("Diagnostic sink failure must not affect capture");
  });
  const instance = Object.create(prototype);
  const tree = {};
  assert.equal(instance.prepare(tree), promise);
  assert.equal(await promise, capture);
  assert.equal(receiver, instance);
  assert.deepEqual(parameters, [tree]);
  assert.equal(capture.snapshot.viewport.width, 800);
  assert.equal(observer.receipt.calls, 1);
  assert.equal(observer.receipt.successes, 1);
  assert.equal(observer.receipt.observerErrors, 1);
  observer.restore();
  assert.equal(prototype.prepare, original);
});

test("frame preparation observer preserves original rejection and synchronous throw", async () => {
  const error = new Error("Original observer refusal");
  const promise = Promise.reject(error);
  const prototype = {
    prepare() {
      return promise;
    },
  };
  const observer = observeFramePreparation(prototype, () => {
    throw Error("ignored");
  });
  assert.equal(prototype.prepare(), promise);
  await assert.rejects(promise, (value) => value === error);
  assert.equal(observer.receipt.failures, 1);
  assert.equal(observer.receipt.head[0].message, error.message);
  assert.equal(observer.receipt.head[0].stack, error.stack);
  observer.restore();
  prototype.prepare = () => {
    throw error;
  };
  const sync = observeFramePreparation(prototype);
  assert.throws(
    () => prototype.prepare(),
    (value) => value === error,
  );
  assert.equal(sync.receipt.failures, 1);
  sync.restore();
});

test("frame preparation evidence is bounded and restores only its own wrapper", async () => {
  const error = new Error("x".repeat(2000));
  error.stack = "s".repeat(8000);
  const prototype = {
    prepare() {
      return Promise.reject(error);
    },
  };
  const observer = observeFramePreparation(prototype);
  for (let i = 0; i < 25; i++)
    await assert.rejects(prototype.prepare(), (value) => value === error);
  assert.equal(observer.receipt.calls, 25);
  assert.equal(observer.receipt.failures, 25);
  assert.equal(observer.receipt.head.length, 4);
  assert.equal(observer.receipt.tail.length, 4);
  assert.equal(observer.receipt.head[0].message.length, 1024);
  assert.equal(observer.receipt.head[0].stack.length, 4096);
  const replacement = () => Promise.resolve(undefined);
  prototype.prepare = replacement;
  observer.restore();
  assert.equal(prototype.prepare, replacement);
});
