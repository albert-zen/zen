import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Execute the capture's actual helper and DOM inspection, without starting Chrome.
const source = await readFile(
  new URL("../scripts/capture-trigger-message-preview.mjs", import.meta.url),
  "utf8",
);
const start = source.indexOf("  const clickSelector = async (");
const end = source.indexOf("  for (const options of [", start);
assert.ok(start >= 0 && end > start, "the shipped input helper is present");
const createClick = new Function(
  "assert",
  "evaluate",
  "send",
  "delay",
  "Date",
  `${source.slice(start, end)}\nreturn clickSelector;`,
);

function harness({
  scrollTop = 0,
  targetTop = 80,
  obscured = false,
  moved,
} = {}) {
  const events = [];
  const observations = [];
  const state = { time: 0, scrollTop, targetTop, moved: 0 };
  const box = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  const target = {
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () =>
      box(24, state.targetTop - state.scrollTop, 160, 24),
    closest: (selector) => {
      assert.equal(selector, ".messages");
      return viewport;
    },
    contains: (node) => node === target,
    scrollIntoView: () =>
      assert.fail("Only native wheel may expose this target"),
  };
  const viewport = {
    get scrollTop() {
      return state.scrollTop;
    },
    getBoundingClientRect: () => box(0, 0, 620, 480),
    closest: (selector) => {
      assert.equal(selector, ".thread-view");
      return {
        querySelector: (selector) => {
          assert.equal(selector, ".bottom-zone");
          return { getBoundingClientRect: () => box(0, 360, 620, 120) };
        },
      };
    },
    contains: (node) => node === viewport || node === target,
  };
  const inside = (x, y, r) =>
    x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const document = {
    querySelectorAll: (selector) => {
      assert.equal(selector, ".message-source-link");
      return [target];
    },
    elementFromPoint: (x, y) => {
      if (x < 0 || x > 620 || y < 0 || y >= 360) return null;
      if (inside(x, y, target.getBoundingClientRect()))
        return obscured ? {} : target;
      return viewport;
    },
  };
  const evaluate = async (expression) =>
    await vm.runInNewContext(expression, {
      document,
      innerWidth: 620,
      innerHeight: 480,
      requestAnimationFrame: (callback) => {
        state.time += 16;
        queueMicrotask(() => callback(state.time));
      },
    });
  const send = async (method, parameters) => {
    assert.equal(method, "Input.dispatchMouseEvent");
    events.push(parameters);
    if (parameters.type === "mouseWheel") {
      assert.ok(parameters.y < 360, "wheel stays above the Composer overlay");
      assert.equal(
        viewport.contains(
          document.elementFromPoint(parameters.x, parameters.y),
        ),
        true,
        "native wheel targets this transcript",
      );
      state.scrollTop = Math.max(
        0,
        Math.min(500, state.scrollTop + parameters.deltaY),
      );
    } else if (parameters.type === "mouseMoved") {
      state.moved++;
      moved?.(state);
    } else {
      assert.equal(
        target.contains(document.elementFromPoint(parameters.x, parameters.y)),
        true,
        "press/release must use current unobscured source coordinates",
      );
    }
  };
  const click = createClick(assert, evaluate, send, async () => {}, {
    now: () => state.time,
  });
  return {
    events,
    state,
    observations,
    run: () => click(".message-source-link", 0, observations),
  };
}

test("offscreen transcript source is exposed by native upward wheel before clicking", async () => {
  const h = harness({ scrollTop: 400, targetTop: 80 });
  await h.run();
  assert.equal(h.events[0].type, "mouseWheel");
  assert.ok(h.events[0].deltaY < 0);
  assert.ok(h.state.scrollTop < 400);
  assert.equal(
    h.events.filter((event) => event.type === "mousePressed").length,
    1,
  );
  assert.equal(h.events.at(-1).type, "mouseReleased");
  assert.ok(h.observations.some((entry) => entry.action === "wheel"));
  assert.equal(h.observations.at(-1).action, "before-press");
});

test("already visible source does not scroll and receives one real pointer click", async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(
    h.events.map((event) => event.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
  assert.equal(h.state.scrollTop, 0);
  assert.ok(
    h.observations.filter((entry) => entry.action === "inspect").length >= 2,
  );
});

test("a source behind Composer is exposed with downward wheel, not clicked through overlay", async () => {
  const h = harness({ targetTop: 400 });
  await h.run();
  assert.equal(h.events[0].type, "mouseWheel");
  assert.ok(h.events[0].deltaY > 0);
  assert.equal(
    h.events.filter((event) => event.type === "mousePressed").length,
    1,
  );
});

test("geometry moving after mouseMoved is reread before press, never clicked at stale coordinates", async () => {
  const h = harness({
    moved: (state) => {
      if (state.moved === 1) state.targetTop += 60;
    },
  });
  await h.run();
  const moves = h.events.filter((event) => event.type === "mouseMoved");
  const press = h.events.find((event) => event.type === "mousePressed");
  assert.equal(moves.length, 2);
  assert.equal(press.y, moves[0].y + 60);
  assert.equal(press.y, moves[1].y);
  assert.equal(
    h.events.filter((event) => event.type === "mousePressed").length,
    1,
  );
});

test("an obscured source fails within the deadline without a blind click", async () => {
  const h = harness({ obscured: true });
  await assert.rejects(h.run(), /never became stable and clickable/);
  assert.deepEqual(h.events, []);
  assert.ok(h.state.time >= 5_000 && h.state.time < 5_100);
});

test("a source which cannot be reached by scrolling fails instead of fabricating exposure", async () => {
  const h = harness({ targetTop: -100 });
  await assert.rejects(h.run(), /never became stable and clickable/);
  assert.ok(h.events.length > 0);
  assert.equal(
    h.events.every((event) => event.type === "mouseWheel"),
    true,
  );
  assert.equal(h.state.scrollTop, 0);
});
