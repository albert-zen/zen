import assert from "node:assert/strict";
import test from "node:test";
import { observeElectronPage } from "../src/main/capabilities/browser-electron-observation.js";
import type { BrowserLiveObservationEvent } from "../src/main/capabilities/browser-provider.js";

test("Electron observer sends bounded live frames and stops without a late frame", async () => {
  const events: BrowserLiveObservationEvent[] = [];
  let resolve!: (value: any) => void;
  const stop = observeElectronPage(
    {
      capture: () =>
        new Promise((r) => {
          resolve = r;
        }),
      current: () => 1,
    },
    (e) => events.push(e),
  );
  assert.equal(events[0]?.type, "status");
  stop();
  resolve({
    isEmpty: () => false,
    getSize: () => ({ width: 100, height: 80 }),
    toJPEG: () => Buffer.from("frame"),
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(events.filter((e) => e.type === "frame").length, 0);
});

test("Electron observer discards capture spanning a navigation", async () => {
  const events: BrowserLiveObservationEvent[] = [];
  let version = 1;
  let resolve!: (value: any) => void;
  const stop = observeElectronPage(
    {
      capture: () =>
        new Promise((r) => {
          resolve = r;
        }),
      current: () => version,
    },
    (e) => events.push(e),
  );
  version++;
  resolve({
    isEmpty: () => false,
    getSize: () => ({ width: 100, height: 80 }),
    toJPEG: () => Buffer.from("frame"),
  });
  await new Promise((r) => setImmediate(r));
  stop();
  assert.equal(events.filter((e) => e.type === "frame").length, 0);
});

test("Electron observer marks a frame live and reports a closed target", async () => {
  const events: BrowserLiveObservationEvent[] = [];
  const stop = observeElectronPage(
    {
      capture: async () =>
        ({
          isEmpty: () => false,
          getSize: () => ({ width: 100, height: 80 }),
          toJPEG: () => Buffer.from("frame"),
        }) as any,
      current: () => 1,
    },
    (e) => events.push(e),
  );
  await new Promise((r) => setImmediate(r));
  stop();
  assert.deepEqual(
    events.filter((e) => e.type === "frame").map((e) => e.frame.width),
    [100],
  );
  const closed: BrowserLiveObservationEvent[] = [];
  observeElectronPage(
    {
      capture: async () => {
        throw new Error("must not capture");
      },
      current: () => undefined,
    },
    (e) => closed.push(e),
  );
  const last = closed.at(-1);
  assert.equal(last?.type === "status" && last.status, "unavailable");
});
