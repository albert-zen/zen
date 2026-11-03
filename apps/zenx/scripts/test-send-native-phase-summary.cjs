/** Pure bounded projection tests, no browser, trace acquisition or user data. */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  styleLayoutInitiators,
  nativeOtherPhases,
} = require("./summarize-send-timeline.cjs");
const bundles = [
  { url: "file:///owned/index-synthetic.js", sha256: "a".repeat(64) },
];
const frame = {
  url: bundles[0].url,
  lineNumber: 12,
  columnNumber: 7,
  functionName: "private-function-never-export",
};
test("style initiators export exact owned numeric locations and counts, never strings from private frames", () => {
  const result = styleLayoutInitiators(
    [
      {
        name: "UpdateLayoutTree",
        ts: 1000,
        dur: 5000,
        args: {
          beginData: {
            stackTrace: [
              frame,
              {
                ...frame,
                url: "file:///private/path",
                functionName: "private-unowned",
              },
            ],
          },
        },
      },
      {
        name: "Layout",
        ts: 3000,
        dur: 2000,
        args: { data: { stackTrace: { callFrames: [frame] } } },
      },
      {
        name: "Layout",
        ts: 4000,
        dur: 1000,
        args: { stackTrace: [{ ...frame, url: "file:///private/path" }] },
      },
      { name: "RecalculateStyles", ts: 5000, dur: 1000 },
    ],
    2000,
    6000,
    bundles,
  );
  assert.equal(result.eligibleEvents, 4);
  assert.equal(result.eventsWithStack, 3);
  assert.equal(result.eventsWithOwnedStack, 2);
  assert.equal(result.events[0].clippedWallMs, 4);
  assert.equal(result.events[0].locations.length, 1);
  assert.deepEqual(result.events[0].locations[0], {
    bundleIndex: 0,
    bundleSha256: bundles[0].sha256,
    line: 12,
    column: 7,
  });
  const serialized = JSON.stringify(result);
  for (const secret of [
    "private-path",
    "private-function-never-export",
    "file:///",
    "functionName",
    "private-unowned",
  ])
    assert.equal(serialized.includes(secret), false);
});
test("style stack projection is bounded and rejects unowned or malformed positions", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    name: "Layout",
    ts: 1000 + i,
    dur: 100,
    args: {
      beginData: { stackTrace: Array.from({ length: 20 }, () => frame) },
    },
  }));
  const result = styleLayoutInitiators(many, 0, 5000, bundles);
  assert.equal(result.events.length, 8);
  assert.equal(result.events[0].locations.length, 8);
  const bad = styleLayoutInitiators(
    [
      {
        name: "Layout",
        ts: 1,
        dur: 5,
        args: {
          stackTrace: [
            { ...frame, lineNumber: NaN },
            { ...frame, columnNumber: -1 },
          ],
        },
      },
    ],
    0,
    9,
    bundles,
  );
  assert.equal(bad.eventsWithStack, 1);
  assert.equal(bad.eventsWithOwnedStack, 0);
  assert.deepEqual(bad.events, []);
});
test("Other projection uses only fixed codes and inclusive union, never arbitrary native or user timing names", () => {
  const result = nativeOtherPhases(
    [
      { name: "ThreadControllerImpl::RunTask", ts: 1000, dur: 10000 },
      { name: "Layerize", ts: 2000, dur: 4000 },
      { name: "Layerize", ts: 4000, dur: 4000 },
      { name: "private-user-supplied-event", ts: 2000, dur: 9000 },
      { name: "Layerize", cat: "blink.user_timing", ts: 1000, dur: 11000 },
      { name: "Paint", ts: 1000, dur: 10000 },
    ],
    1000,
    11000,
  );
  assert.deepEqual(
    result.phases.map((x) => [x.phase, x.clippedInclusiveWallMs]),
    [
      ["thread-run-task", 10],
      ["layerize", 6],
    ],
  );
  assert.equal(result.unmappedEventCount, 1);
  assert.equal(
    JSON.stringify(result).includes("private-user-supplied-event"),
    false,
  );
  assert.ok(result.meaning.includes("must not be added"));
});
test("native phase projection stays capped and treats unavailable stages as absent, not zero evidence", () => {
  const result = nativeOtherPhases(
    [
      { name: "Commit", ts: 0, dur: 5000 },
      { name: "UnknownNativeStage", ts: 0, dur: 5000 },
    ],
    1000,
    4000,
  );
  assert.deepEqual(result.phases, [
    { phase: "commit", eventCount: 1, clippedInclusiveWallMs: 3 },
  ]);
  assert.equal(result.unmappedEventCount, 1);
});

test("style count metadata preserves missing fields and excludes raw node IDs", () => {
  const result = styleLayoutInitiators(
    [
      {
        name: "UpdateLayoutTree",
        ts: 1000,
        dur: 4000,
        args: {
          elementCount: 10000,
          beginData: { nodeId: 99, frame: "private-frame" },
        },
      },
      {
        name: "Layout",
        ts: 2000,
        dur: 1000,
        args: {
          beginData: { dirtyObjects: 3, totalObjects: 25000, nodeId: 77 },
        },
      },
      { name: "Layout", ts: 3000, dur: 500, args: {} },
    ],
    1000,
    5000,
    bundles,
  );
  assert.deepEqual(
    result.largestEvents.map((e) => e.objectCounts),
    [{ elementCount: 10000 }, { dirtyObjects: 3, totalObjects: 25000 }, {}],
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("nodeId"), false);
  assert.equal(serialized.includes("private-frame"), false);
});
