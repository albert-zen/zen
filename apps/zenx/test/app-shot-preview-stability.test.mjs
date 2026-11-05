import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { settleAppShotPreview } from "../scripts/app-shot-preview-stability.mjs";

function run(animations, timeout = 2000) {
  return runInNewContext(`(${settleAppShotPreview.toString()})(${timeout})`, {
    document: {
      fonts: { ready: Promise.resolve() },
      getAnimations: () => animations,
    },
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    performance,
    setTimeout,
    clearTimeout,
  });
}
function transition() {
  let resolve, reject;
  const animation = {
    playState: "running",
    pending: false,
    effect: { getComputedTiming: () => ({ endTime: 200 }) },
    finished: new Promise((a, b) => {
      resolve = a;
      reject = b;
    }),
  };
  return {
    animation,
    finish() {
      animation.playState = "finished";
      resolve();
    },
    cancel() {
      animation.playState = "idle";
      reject(new Error("cancelled"));
    },
  };
}

test("waits for actual disclosure transition, not only two frames", async () => {
  const t = transition();
  let complete = false;
  const pending = run([t.animation]).then(() => {
    complete = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(complete, false);
  t.finish();
  await pending;
  assert.equal(complete, true);
});
test("cancelled transitions settle without treating cancellation as an image failure", async () => {
  const t = transition(),
    pending = run([t.animation]);
  setTimeout(() => t.cancel(), 15);
  assert.equal(await pending, true);
});
test("continuous decorative animations do not block capture forever", async () => {
  const t = transition();
  t.animation.effect.getComputedTiming = () => ({ endTime: Infinity });
  assert.equal(await run([t.animation]), true);
});
test("a hung finite animation fails within the preview budget", async () => {
  const t = transition();
  await assert.rejects(run([t.animation], 25), /motion did not settle/);
});
