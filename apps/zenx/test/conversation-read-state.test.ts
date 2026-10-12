import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveUnreadKeys,
  parseReadWatermarks,
  serializeReadWatermarks,
  withReadBaselines,
  withReadMark,
  type ReadWatermarks,
  type WatermarkEntry,
} from "../src/renderer/src/conversation-read-state.js";

const entries = (
  pairs: Array<[string, number | string | null]>,
): WatermarkEntry[] => pairs.map(([key, position]) => ({ key, position }));

test("watermarks round-trip through storage and reject malformed input", () => {
  const marks = { "t:a": 1_700, "r:b": 1_800 };
  assert.deepEqual(
    parseReadWatermarks(serializeReadWatermarks(marks)),
    marks,
    "round-trips",
  );
  assert.deepEqual(parseReadWatermarks(null), {});
  assert.deepEqual(parseReadWatermarks("not json"), {});
  assert.deepEqual(parseReadWatermarks("[1,2]"), {});
  assert.deepEqual(
    parseReadWatermarks('{"t:a": 12.9, "t:b": -5, "t:c": "x", "t:d": null}'),
    { "t:a": 12 },
    "keeps finite non-negative numbers floored",
  );
});

test("first-seen conversations are baselined as read without inventing unreads", () => {
  const initial = {};
  const next = withReadBaselines(
    initial,
    entries([
      ["t:a", 100],
      ["t:b", null],
    ]),
  );
  assert.deepEqual(next, { "t:a": 100, "t:b": 0 });
  assert.equal(
    withReadBaselines(next, entries([["t:a", 100]])),
    next,
    "unchanged input returns the same reference",
  );
  // A thread with no watermark is never unread, even with activity.
  assert.deepEqual(
    deriveUnreadKeys(entries([["t:z", 999]]), {}, []),
    new Set(),
  );
});

test("viewing a conversation marks up to the newest activity read", () => {
  let marks: ReadWatermarks = { "t:a": 500 };
  marks = withReadMark(marks, "t:a", 700);
  assert.equal(marks["t:a"], 700);
  assert.equal(
    withReadMark(marks, "t:a", 600),
    marks,
    "older activity never moves the watermark backwards",
  );
  assert.equal(withReadMark(marks, "t:a", null), marks);
  assert.deepEqual(
    deriveUnreadKeys(entries([["t:a", 600]]), marks, []),
    new Set(),
  );
  assert.deepEqual(
    [...deriveUnreadKeys(entries([["t:a", 800]]), marks, [])],
    ["t:a"],
  );
});

test("the conversation on screen is never reported unread", () => {
  const marks = { "t:a": 100, "t:b": 100 };
  const listed = entries([
    ["t:a", 500],
    ["t:b", 500],
    ["t:c", 500],
  ]);
  assert.deepEqual(
    [...deriveUnreadKeys(listed, marks, ["t:a"])].sort(),
    ["t:b"],
    "viewed t:a stays read even when advanced; t:c has no baseline yet",
  );
  assert.deepEqual([...deriveUnreadKeys(listed, marks, ["t:a", "t:b"])], []);
});

test("an empty known Room keeps a baseline across reload and its first message is unread", () => {
  const marks = parseReadWatermarks(
    serializeReadWatermarks(
      withReadBaselines({}, entries([["r:empty", null]])),
    ),
  );
  assert.equal(marks["r:empty"], 0);
  assert.deepEqual(
    [...deriveUnreadKeys(entries([["r:empty", 100]]), marks, [])],
    ["r:empty"],
  );
});

test("Room identities survive reload and distinguish equal timestamps and saturated histories", () => {
  let marks = withReadBaselines({}, entries([["r:room", "first-id"]]));
  marks = parseReadWatermarks(serializeReadWatermarks(marks));
  assert.deepEqual(
    [...deriveUnreadKeys(entries([["r:room", "second-id"]]), marks, [])],
    ["r:room"],
  );
  marks = withReadMark(marks, "r:room", "second-id");
  assert.deepEqual(
    [...deriveUnreadKeys(entries([["r:room", "a-later-id"]]), marks, [])],
    ["r:room"],
    "random ID lexical order never defines chronology",
  );
});
