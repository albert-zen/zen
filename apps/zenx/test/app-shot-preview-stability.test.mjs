import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  appShotPreviewClickPosition,
  settleAppShotPreview,
} from "../scripts/app-shot-preview-stability.mjs";

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

test("click coordinates use settled layout after scroll and reacquire the node", async () => {
  const order = [];
  let phase = 0;
  const old = {
    scrollIntoView(options) {
      order.push("scroll");
      assert.equal(options.behavior, "instant");
    },
    getBoundingClientRect() {
      throw new Error("Stale layout must not be measured");
    },
  };
  const current = {
    getBoundingClientRect() {
      order.push("measure");
      return { x: 20, y: 300, width: 40, height: 20 };
    },
    contains: (element) => element === current,
  };
  const point = await runInNewContext(
    `(${appShotPreviewClickPosition.toString()})('.target', settle)`,
    {
      settle: async () => {
        order.push("settle");
        phase++;
      },
      document: {
        querySelector() {
          order.push("query");
          return phase === 1 ? old : current;
        },
        elementFromPoint(x, y) {
          assert.equal(x, 40);
          assert.equal(y, 310);
          return current;
        },
      },
    },
  );
  assert.equal(point.x, 40);
  assert.equal(point.y, 310);
  assert.deepEqual(order, [
    "settle",
    "query",
    "scroll",
    "settle",
    "query",
    "measure",
  ]);
});

test("click target preparation fails without input or retry if settling fails", async () => {
  let queries = 0;
  await assert.rejects(
    runInNewContext(
      `(${appShotPreviewClickPosition.toString()})('.target', settle)`,
      {
        settle: async () => {
          throw new Error("motion did not settle");
        },
        document: {
          querySelector() {
            queries++;
          },
        },
      },
    ),
    /motion did not settle/,
  );
  assert.equal(queries, 0);
});

test("click target preparation rejects a disabled, detached or obscured final node", async () => {
  for (const state of ["disabled", "detached", "obscured"]) {
    let queries = 0;
    const element = {
      scrollIntoView() {},
      getBoundingClientRect: () => ({ x: 1, y: 1, width: 10, height: 10 }),
      contains: () => false,
    };
    await assert.rejects(
      runInNewContext(
        `(${appShotPreviewClickPosition.toString()})('.target', settle)`,
        {
          settle: async () => {},
          document: {
            querySelector() {
              if (++queries === 1) return element;
              return state === "disabled"
                ? { disabled: true }
                : state === "detached"
                  ? null
                  : element;
            },
            elementFromPoint: () => ({}),
          },
        },
      ),
      /Missing or disabled|obscured/,
    );
    assert.equal(queries, 2);
  }
});
