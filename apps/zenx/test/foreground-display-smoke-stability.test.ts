import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Display, Screen } from "electron";
import {
  waitForForegroundDisplayStability,
  type ForegroundSmokeClock,
} from "../src/main/foreground-display-smoke-stability.js";

class Clock implements ForegroundSmokeClock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; callback(): void }>();
  now = () => this.time;
  schedule = (callback: () => void, delayMs: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => {
      this.timers.delete(id);
    };
  };
  async advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await Promise.resolve();
    }
    // Synchronous observations may themselves consume monotonic time.
    this.time = Math.max(this.time, target);
    await Promise.resolve();
  }
}

function fixture(deadline = 7_000) {
  const clock = new Clock();
  const displays = [
    {
      id: 1,
      bounds: { x: 0, y: 0, width: 1024, height: 768 },
      workArea: { x: 0, y: 31, width: 1024, height: 674 },
      scaleFactor: 1,
      rotation: 0,
    } as Display,
  ];
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => displays,
  });
  let admitted = 0;
  let failure: unknown;
  const start = () =>
    waitForForegroundDisplayStability(screen as unknown as Screen, {
      deadline,
      clock,
    }).then(
      () => {
        admitted++;
      },
      (error: unknown) => {
        failure = error;
      },
    );
  return {
    clock,
    screen,
    displays,
    start,
    admitted: () => admitted,
    failure: () => failure,
  };
}

const events = [
  "display-added",
  "display-removed",
  "display-metrics-changed",
] as const;

test("stable setup requires a full 500ms quiet window and removes only its listeners", async () => {
  const f = fixture();
  const original = () => {};
  f.screen.on("display-added", original);
  const pending = f.start();
  await f.clock.advance(499);
  assert.equal(f.admitted(), 0);
  await f.clock.advance(1);
  await pending;
  assert.equal(f.admitted(), 1);
  assert.equal(f.failure(), undefined);
  assert.deepEqual(f.screen.listeners("display-added"), [original]);
  for (const event of events.slice(1))
    assert.equal(f.screen.listenerCount(event), 0);
  assert.equal(f.clock.timers.size, 0);
  f.screen.emit("display-metrics-changed");
  await f.clock.advance(1000);
  assert.equal(f.admitted(), 1);
});

for (const event of events)
  test(`${event} resets setup quiet time even when numeric geometry is unchanged`, async () => {
    const f = fixture();
    const pending = f.start();
    await f.clock.advance(400);
    f.screen.emit(event, {}, f.displays[0], ["workArea"]);
    await f.clock.advance(499);
    assert.equal(f.admitted(), 0);
    await f.clock.advance(1);
    await pending;
    assert.equal(f.admitted(), 1);
    assert.equal(f.clock.time, 900);
  });

for (const change of [
  (d: Display) => {
    d.id++;
  },
  (d: Display) => {
    d.bounds.x++;
  },
  (d: Display) => {
    d.bounds.y++;
  },
  (d: Display) => {
    d.bounds.width++;
  },
  (d: Display) => {
    d.bounds.height++;
  },
  (d: Display) => {
    d.workArea.x++;
  },
  (d: Display) => {
    d.workArea.y++;
  },
  (d: Display) => {
    d.workArea.width++;
  },
  (d: Display) => {
    d.workArea.height += 3;
  },
  (d: Display) => {
    d.scaleFactor++;
  },
  (d: Display) => {
    d.rotation = 90;
  },
])
  test(`silent numeric snapshot change resets quiet time: ${change.toString()}`, async () => {
    const f = fixture();
    const pending = f.start();
    await f.clock.advance(400);
    change(f.displays[0]!);
    await f.clock.advance(25);
    await f.clock.advance(499);
    assert.equal(f.admitted(), 0);
    await f.clock.advance(1);
    await pending;
    assert.equal(f.admitted(), 1);
  });

test("continuous changes exhaust one deadline without activity admission or timer/listener leaks", async () => {
  const f = fixture(1_000);
  const pending = f.start();
  for (let i = 0; i < 9; i++) {
    await f.clock.advance(100);
    f.screen.emit(events[i % events.length]!);
  }
  await f.clock.advance(100);
  await pending;
  assert.match(
    String(f.failure()),
    /Timed out waiting for stable owned fixture displays/u,
  );
  assert.equal(f.admitted(), 0);
  assert.equal(f.clock.time, 1_000);
  assert.equal(f.clock.timers.size, 0);
  for (const event of events) assert.equal(f.screen.listenerCount(event), 0);
});

test("focus time already spent cannot receive a fresh setup deadline", async () => {
  const f = fixture(7_000);
  f.clock.time = 6_750;
  const pending = f.start();
  await f.clock.advance(250);
  await pending;
  assert.equal(f.admitted(), 0);
  assert.match(String(f.failure()), /Timed out/u);
  assert.equal(f.clock.timers.size, 0);
});

for (const readMs of [5, 10, 20])
  test(`final display read consumes ${readMs}ms near the shared deadline`, async () => {
    const f = fixture(7_000);
    f.clock.time = 6_490;
    f.screen.getAllDisplays = () => {
      if (f.clock.time === 6_990) f.clock.time += readMs;
      return f.displays;
    };
    const pending = f.start();
    await f.clock.advance(500);
    await pending;
    assert.equal(f.clock.time, 6_990 + readMs);
    if (readMs < 10) {
      assert.equal(f.admitted(), 1);
      assert.equal(f.failure(), undefined);
    } else {
      assert.equal(f.admitted(), 0);
      assert.match(
        String(f.failure()),
        /Timed out waiting for stable owned fixture displays/u,
      );
    }
    assert.equal(f.clock.timers.size, 0);
    for (const event of events) assert.equal(f.screen.listenerCount(event), 0);
  });

test("every display participates in the snapshot even beyond the diagnostic logging cap", async () => {
  const f = fixture();
  for (let id = 2; id <= 5; id++) f.displays.push({ ...f.displays[0]!, id });
  const pending = f.start();
  await f.clock.advance(400);
  f.displays[4] = { ...f.displays[4]!, rotation: 90 };
  await f.clock.advance(524);
  assert.equal(f.admitted(), 0);
  await f.clock.advance(1);
  await pending;
  assert.equal(f.admitted(), 1);
});

test("late snapshot errors reject rather than leaving observation alive", async () => {
  const f = fixture();
  const pending = f.start();
  await f.clock.advance(400);
  const error = new Error("display observation lost");
  f.screen.getAllDisplays = () => {
    throw error;
  };
  await f.clock.advance(25);
  await pending;
  assert.equal(f.failure(), error);
  assert.equal(f.admitted(), 0);
  assert.equal(f.clock.timers.size, 0);
  for (const event of events) assert.equal(f.screen.listenerCount(event), 0);
});

for (const deadline of [0, Number.NaN, Number.POSITIVE_INFINITY])
  test(`unusable setup deadline fails without admission: ${deadline}`, async () => {
    const f = fixture(deadline);
    await f.start();
    assert.equal(f.admitted(), 0);
    assert(f.failure() instanceof Error);
    assert.equal(f.clock.timers.size, 0);
    for (const event of events) assert.equal(f.screen.listenerCount(event), 0);
  });

for (const invalid of [
  "empty",
  "nonfinite",
  "throw",
  "throw-undefined",
  "duplicate",
] as const)
  test(`unverifiable display snapshot fails closed: ${invalid}`, async () => {
    const f = fixture();
    if (invalid === "empty") f.displays.length = 0;
    if (invalid === "nonfinite") f.displays[0]!.scaleFactor = Number.NaN;
    if (invalid === "throw")
      f.screen.getAllDisplays = () => {
        throw new Error("snapshot failed");
      };
    if (invalid === "throw-undefined")
      f.screen.getAllDisplays = () => {
        throw undefined;
      };
    if (invalid === "duplicate") f.displays.push(f.displays[0]!);
    await f.start();
    assert.equal(f.admitted(), 0);
    assert(f.failure() instanceof Error);
    assert.equal(f.clock.timers.size, 0);
    for (const event of events) assert.equal(f.screen.listenerCount(event), 0);
  });

test("fixture shares its focus budget with Darwin-only preflight before exactly one activity invocation", async () => {
  const smoke = await readFile(
    new URL("../src/main/foreground-activity-smoke.ts", import.meta.url),
    "utf8",
  );
  const cdp = smoke
    .split("async function verifyForegroundActivityCdpOverlay")[1]!
    .split("async function waitFor(")[0]!;
  assert.match(
    cdp,
    /const setupDeadline = performance\.now\(\) \+ 7_000;\s+fixture\.show\(\)/u,
  );
  assert.match(cdp, /"owned fixture focus",\s+setupDeadline,/u);
  assert.match(
    cdp,
    /if \(process\.platform === "darwin"\) \{\s+mark\("display-stability-start"\);\s+await waitForForegroundDisplayStability\(screen, \{\s+deadline: setupDeadline,\s+\}\);\s+mark\("display-stability-confirmed"\);\s+assert\.equal\(fixture\.isFocused\(\), true, "owned fixture lost setup focus"\);\s+\}/u,
  );
  assert(
    cdp.indexOf('mark("display-stability-confirmed")') <
      cdp.indexOf("activity.run("),
  );
  assert.equal(cdp.match(/activity\.run\(/gu)?.length, 1);
});
