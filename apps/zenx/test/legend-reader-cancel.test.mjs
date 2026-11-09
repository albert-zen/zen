import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Exercise the exact installed web implementation with a deterministic
// scheduled-work owner. DOM acceptance is covered separately.
test("reader cancellation invalidates delayed imperative work without queueing an old offset", async () => {
  const source = readFileSync(
    new URL(import.meta.resolve("@legendapp/list/react")),
    "utf8",
  );
  const start = source.indexOf("function createImperativeHandle(ctx,");
  const end = source.indexOf("\n// src/utils/getAlwaysRenderIndices", start);
  assert.ok(start > 0 && end > start);
  const cancellationStart = source.indexOf(
    "function cancelScrollCompletionChecks(",
  );
  const cancellationEnd = source.indexOf(
    "\n// src/core/deferredPublicOnScroll",
    cancellationStart,
  );
  assert.ok(cancellationStart > 0 && cancellationEnd > cancellationStart);
  const queue = new Map();
  const writes = [];
  let superseded = 0;
  const state = {
    didDataChange: true,
    props: { data: ["row"] },
    refScroller: { current: {} },
    scheduledWork: {
      frame(fn, name) {
        queue.set(name, fn);
      },
      cancel(name) {
        queue.delete(name);
      },
      has(name) {
        return queue.has(name);
      },
    },
  };
  const factory = new Function(
    "supersedeInitialScroll",
    "scrollTo",
    `${source.slice(cancellationStart, cancellationEnd)}\n${source.slice(start, end)}\nreturn createImperativeHandle;`,
  );
  const api = factory(
    () => {
      superseded++;
    },
    (_ctx, params) => {
      writes.push(params.offset);
    },
  )({ state });
  const oldRequest = api.scrollToOffset({ offset: 585, animated: false });
  const staleCallback = queue.get("imperativeScrollReady");
  assert.equal(
    typeof staleCallback,
    "function",
    "real runWhenReady path must be exercised",
  );
  state.scrollingTo = { offset: 585 };
  state.scrollTargetPinnedRange = [0, 1];
  api.cancelScroll();
  await oldRequest;
  assert.equal(state.scrollingTo, undefined);
  assert.equal(state.scrollTargetPinnedRange, undefined);
  assert.equal(queue.size, 0);
  state.didDataChange = false;
  staleCallback();
  assert.deepEqual(
    writes,
    [],
    "a delivered stale callback must not restore the wheel-before offset",
  );
  assert.equal(
    queue.size,
    0,
    "cancellation does not create replacement scroll work",
  );
  await api.scrollToOffset({ offset: 685, animated: false });
  assert.deepEqual(writes, [685], "a newer explicit request still works");
  assert.equal(superseded, 3);
});
