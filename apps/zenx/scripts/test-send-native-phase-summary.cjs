/** Pure bounded projection tests, no browser, trace acquisition or user data. */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  styleLayoutInitiators,
  nativeOtherPhases,
  nativeCommitEvents,
  styleInvalidationCauses,
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
test("native Commit exports whole CPU and temporally contained fixed phases without proration or private arguments", () => {
  const result = nativeCommitEvents(
    [
      {
        name: "Commit",
        cat: "disabled-by-default-devtools.timeline",
        ts: 1000,
        dur: 10000,
        tts: 20,
        tdur: 7000,
        args: { secret: "private-node-url" },
      },
      { name: "RunTask", ts: 0, dur: 15000 },
      { name: "Paint", ts: 2000, dur: 3000 },
      {
        name: "IntersectionObserverController::computeIntersections",
        cat: "blink,devtools.timeline",
        ts: 5000,
        dur: 4000,
      },
      {
        name: "IntersectionObserverController::computeIntersections",
        cat: "blink,devtools.timeline",
        ts: 6000,
        dur: 4000,
      },
      {
        name: "Commit",
        cat: "blink.user_timing",
        ts: 1000,
        dur: 10000,
        tts: 20,
        tdur: 10000,
      },
      {
        name: "private-native-event",
        ts: 2000,
        dur: 1000,
        args: { url: "private-node-url" },
      },
    ],
    3000,
    8000,
  );
  assert.equal(result.eventCount, 1);
  assert.equal(result.omittedEvents, 0);
  const entry = result.events[0];
  assert.equal(entry.startRelativeMs, -2);
  assert.equal(entry.endRelativeMs, 8);
  assert.equal(entry.wholeWallMs, 10);
  assert.equal(entry.wholeCpuMs, 7);
  assert.equal(entry.clippedWallMs, 5);
  assert.equal(entry.clipped, true);
  assert.equal(entry.containedRecordedSpans.exclusiveWallMs.Paint, 3);
  assert.equal(entry.containedRecordedSpans.exclusiveWallMs.Other, 5);
  assert.equal(entry.containedRecordedSpans.uncoveredByRecordedSpansMs, 2);
  assert.deepEqual(entry.containedNativePhases.phases, [
    { phase: "intersection-compute", eventCount: 2, clippedInclusiveWallMs: 5 },
  ]);
  for (const secret of [
    "private-node-url",
    "private-native-event",
    "secret",
    "tts",
    "tdur",
  ])
    assert.equal(JSON.stringify(result).includes(secret), false);
});
test("native Commit projection caps output and preserves unavailable CPU as null", () => {
  const result = nativeCommitEvents(
    Array.from({ length: 12 }, (_, index) => ({
      name: "Commit",
      cat: "devtools.timeline",
      ts: 1000 + index,
      dur: 5000,
      tts: 10,
      tdur: index === 0 ? undefined : 9000,
    })),
    0,
    10000,
  );
  assert.equal(result.eventCount, 12);
  assert.equal(result.events.length, 8);
  assert.equal(result.omittedEvents, 4);
  assert.ok(result.events.every((entry) => entry.wholeCpuMs === null));
  assert.deepEqual(
    nativeCommitEvents(
      [{ name: "Commit", cat: "private-unrelated", ts: 1, dur: 20 }],
      0,
      100,
    ).events,
    [],
  );
  assert.deepEqual(nativeCommitEvents([], 0, 100).events, []);
  assert.throws(
    () =>
      nativeCommitEvents(
        [{ name: "Commit", cat: "devtools.timeline", ts: NaN, dur: 20 }],
        0,
        100,
      ),
    /Invalid private timeline input/,
  );
});
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

const invalidationCategory =
  "disabled-by-default-devtools.timeline.invalidationTracking";
const invalidationEvent = (name, ts, data, extra = {}) => ({
  name,
  cat: invalidationCategory,
  ph: "I",
  ts,
  args: { data },
  ...extra,
});
const schedule = (ts, data, extra) =>
  invalidationEvent("ScheduleStyleInvalidationTracking", ts, data, extra);
const invalidate = (ts, data, extra) =>
  invalidationEvent("StyleInvalidatorInvalidationTracking", ts, data, extra);

test("invalidation set links join two exact IDs to fixed scheduled features and target tags", () => {
  const firstId = "private-opaque-set-a",
    secondId = "private-opaque-set-b";
  const result = styleInvalidationCauses(
    [
      invalidate(110, {
        invalidationList: [{ id: firstId }, { id: firstId }],
        reason: "Invalidation set matched tagName",
        nodeName: "SPAN class='agent-copy private-text' id='private-node'",
        selectorPart: "span",
        extraData: "https://private.example/secret",
      }),
      schedule(100, {
        invalidationSet: firstId,
        changedAttribute: "aria-label",
        nodeName: "BUTTON class='action-orb'",
      }),
      schedule(101, {
        invalidationSet: secondId,
        changedPseudo: ":enabled",
        nodeName: "INPUT",
      }),
      invalidate(111, {
        invalidationList: [{ id: secondId }],
        reason: "Invalidation set matched tagName",
        nodeName: "P",
        selectorPart: "p",
      }),
    ],
    100,
    120,
    bundles,
  );
  const links = result.scheduleLinks;
  assert.equal(links.scheduleEventsWithSetId, 2);
  assert.equal(links.uniqueScheduledSets, 2);
  assert.equal(links.invalidationEventsWithSetIds, 2);
  assert.equal(links.invalidationSetReferences, 2);
  assert.equal(links.linkedSetReferences, 2);
  assert.equal(links.linkedInvalidationEvents, 2);
  assert.equal(links.unlinkedInvalidationEvents, 0);
  assert.equal(links.ambiguousInvalidationEvents, 0);
  assert.deepEqual(links.groups, [
    {
      changeKind: "changedAttribute",
      changeCode: "aria-label",
      scheduleTarget: "action-orb",
      scheduleNodeTag: "button",
      reason: "matched-tag",
      target: "agent-copy",
      nodeTag: "span",
      selectorTag: "span",
      invalidationEvents: 1,
      candidateLinks: 1,
      ambiguousInvalidationEvents: 0,
    },
    {
      changeKind: "changedPseudo",
      changeCode: "enabled",
      scheduleTarget: "other",
      scheduleNodeTag: "input",
      reason: "matched-tag",
      target: "other",
      nodeTag: "p",
      selectorTag: "p",
      invalidationEvents: 1,
      candidateLinks: 1,
      ambiguousInvalidationEvents: 0,
    },
  ]);
  const serialized = JSON.stringify(result);
  for (const raw of [
    firstId,
    secondId,
    "private-",
    "https://",
    "invalidationList",
  ])
    assert.equal(serialized.includes(raw), false);
});

test("invalidation links reject nonmatching, user timing, out-of-window, future and alternate-schema IDs", () => {
  const result = styleInvalidationCauses(
    [
      schedule(99, { invalidationSet: "private-before" }),
      schedule(140, { invalidationSet: "private-end" }),
      schedule(
        100,
        { invalidationSet: "private-user" },
        {
          cat: `${invalidationCategory},blink.user_timing`,
        },
      ),
      schedule(
        100,
        { invalidationSet: "private-console" },
        {
          cat: `${invalidationCategory},blink.console`,
        },
      ),
      schedule(
        100,
        { invalidationSet: "private-category" },
        {
          cat: `${invalidationCategory}.lookalike`,
        },
      ),
      schedule(100, { invalidationSet: "private-phase" }, { ph: "X" }),
      schedule(130, { invalidationSet: "private-future" }),
      schedule(100, { invalidationSet: 42 }),
      schedule(100, { invalidationSet: { id: "private-object" } }),
      ...[
        "private-before",
        "private-end",
        "private-user",
        "private-console",
        "private-category",
        "private-phase",
        "private-future",
        "42",
        "private-missing",
      ].map((id) => invalidate(110, { invalidationList: [{ id }] })),
      invalidate(110, { invalidationSet: 42 }),
      invalidate(110, { invalidationList: [{ id: 42 }] }),
      invalidate(110, { invalidationList: [42, { id: {} }, { id: null }] }),
      invalidate(
        110,
        { invalidationList: [{ id: 42 }] },
        { cat: "blink.user_timing" },
      ),
    ],
    100,
    140,
    bundles,
  );
  const links = result.scheduleLinks;
  assert.equal(links.scheduleEvents, 3);
  assert.equal(links.scheduleEventsWithSetId, 1);
  assert.equal(links.invalidationEvents, 12);
  assert.equal(links.invalidationEventsWithSetIds, 9);
  assert.equal(links.linkedInvalidationEvents, 0);
  assert.equal(links.unlinkedInvalidationEvents, 12);
  assert.equal(links.linkedSetReferences, 0);
  assert.deepEqual(links.groups, []);
  assert.equal(JSON.stringify(result).includes("private-"), false);
});

test("shared sets preserve ambiguity even when fixed cause labels deduplicate", () => {
  const result = styleInvalidationCauses(
    [
      ...["aria-describedby", "tabindex", "aria-describedby"].map((change, i) =>
        schedule(100 + i, {
          invalidationSet: "private-shared-id",
          changedAttribute: change,
          nodeId: 881001 + i,
          nodeName: "BUTTON class='action-orb' id='private-origin'",
        }),
      ),
      invalidate(110, {
        invalidationList: [
          { id: "private-shared-id" },
          { id: "private-unmatched-id" },
        ],
        nodeName: "SPAN",
        selectorPart: "span",
      }),
    ],
    100,
    120,
    bundles,
  );
  const links = result.scheduleLinks;
  assert.equal(links.uniqueScheduledSets, 1);
  assert.equal(links.linkedInvalidationEvents, 1);
  assert.equal(links.partiallyLinkedInvalidationEvents, 1);
  assert.equal(links.ambiguousInvalidationEvents, 1);
  assert.equal(links.groups.length, 2);
  assert.deepEqual(
    links.groups.map((group) => [
      group.changeCode,
      group.invalidationEvents,
      group.candidateLinks,
      group.ambiguousInvalidationEvents,
    ]),
    [
      ["aria-describedby", 1, 2, 1],
      ["tabindex", 1, 1, 1],
    ],
  );
  for (const raw of ["private-", "881001", "nodeId"])
    assert.equal(JSON.stringify(result).includes(raw), false);
});

test("invalidation set link output stays capped and unknown feature strings never escape", () => {
  const tags =
    "button input textarea select form fieldset div span p a summary details section article svg path g".split(
      " ",
    );
  const events = tags.flatMap((tag, i) => [
    schedule(100, {
      invalidationSet: `https://private.example/set/${i}`,
      changedClass: "private-feature",
      nodeName: "CUSTOM-ELEMENT class='private-class'",
    }),
    invalidate(110, {
      invalidationList: [{ id: `https://private.example/set/${i}` }],
      nodeName: tag.toUpperCase(),
      selectorPart: tag,
    }),
  ]);
  const result = styleInvalidationCauses(events, 100, 120, bundles);
  assert.equal(result.scheduleLinks.linkedInvalidationEvents, 17);
  assert.equal(result.scheduleLinks.groups.length, 16);
  assert.equal(result.scheduleLinks.omittedGroups, 1);
  assert.ok(
    result.scheduleLinks.groups.every(
      (group) =>
        group.changeKind === "changedClass" &&
        group.changeCode === "other" &&
        group.scheduleNodeTag === "other",
    ),
  );
  assert.ok(result.groups.length <= 16);
  assert.ok(result.ownedLocations.length <= 8);
  for (const raw of ["private-", "https://", "CUSTOM-ELEMENT"])
    assert.equal(JSON.stringify(result).includes(raw), false);
});

test("Blink pseudo enum spellings normalize only to fixed codes", () => {
  for (const [raw, expected] of [
    ["PseudoFocusWithin", "focus-within"],
    ["PseudoFocusVisible", "focus-visible"],
    ["PseudoHas", "has"],
    ["PseudoEnabled", "enabled"],
    ["PseudoDisabled", "disabled"],
    [":focus-within", "focus-within"],
    ["PseudoPrivateSecret", "other"],
  ]) {
    const result = styleInvalidationCauses(
      [
        schedule(100, {
          changedPseudo: raw,
          nodeName: "MAIN class='private-node'",
        }),
      ],
      100,
      120,
      bundles,
    );
    assert.deepEqual(result.scheduledChanges, [
      { code: `changedPseudo:${expected}`, events: 1 },
    ]);
    assert.equal(result.groups[0].nodeTag, "main");
    assert.equal(JSON.stringify(result).includes("PrivateSecret"), false);
  }
  const doc = styleInvalidationCauses(
    [schedule(100, { nodeName: "#document" })],
    100,
    120,
    bundles,
  );
  assert.equal(doc.groups[0].nodeTag, "document");
});
