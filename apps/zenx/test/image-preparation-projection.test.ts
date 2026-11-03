import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextItem } from "../../../src/item-list.js";
import { projectImagePreparation } from "../src/renderer/src/image-preparation-projection.js";

function notice(
  sampleId: string,
  itemId: string,
  options: {
    requestedDetail?: "high" | "original";
    supports?: boolean | null;
    original?: boolean;
  } = {},
): ContextItem {
  const original = {
    type: "attachment",
    sha256: "original",
    mediaType: "image/png",
    byteLength: 100,
    width: 4000,
    height: 3000,
  };
  const prepared = {
    ...original,
    sha256: "prepared",
    width: 1600,
    height: 1200,
  };
  return {
    id: `notice-${sampleId}-${itemId}`,
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-11-03T00:00:00Z",
    kind: "message",
    role: "user",
    source: {
      kind: "image_preparation",
      sequence: 1,
      metadata: {
        onlySampleId: sampleId,
        selection: { providerProfileId: "provider", modelId: "model" },
        imagePreparation: {
          profile: "codex-high-v1",
          requestedDetail: options.requestedDetail ?? "high",
          supportsImageDetailOriginal: options.supports ?? null,
          occurrence: {
            itemId,
            field: "parts",
            partIndex: 0,
            sha256: "original",
          },
          ...(options.original === false
            ? {}
            : { originalAttachment: original }),
        },
      },
    },
    content: {
      text: "model notice",
      parts: [
        { type: "text", text: "model notice" },
        { type: "image", attachment: prepared },
      ],
    },
  } as ContextItem;
}

function input(id: string, sequence = 0): ContextItem {
  return {
    id,
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-11-03T00:00:00Z",
    kind: "message",
    role: "user",
    source: { kind: "user_message", sequence },
    content: { text: "image", parts: [] },
  } as ContextItem;
}

function selection(): ContextItem {
  return {
    id: "selection",
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-11-03T00:00:01Z",
    kind: "selection",
    role: "user",
    source: { kind: "context_compaction", sequence: 3 },
    content: {
      text: "summary",
      coveredThroughItemId: "notice-s-first",
      coveredSequence: 2,
      retainedItemIds: [],
    },
  } as ContextItem;
}

function unavailable(sampleId: string): ContextItem {
  return {
    id: `unavailable-${sampleId}`,
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-11-03T00:00:02Z",
    kind: "message",
    role: "user",
    source: {
      kind: "media_unavailable",
      sequence: 4,
      metadata: { onlySampleId: sampleId, omittedMedia: [] },
    },
    content: {
      text: "unavailable",
      parts: [{ type: "text", text: "unavailable" }],
    },
  } as ContextItem;
}

test("cold and live projection show only latest sample, without duplicate occurrences", () => {
  const older = notice("old", "first");
  const latest = notice("new", "second");
  assert.equal(
    projectImagePreparation([input("first"), older])?.images.length,
    1,
  );
  assert.deepEqual(
    projectImagePreparation([
      input("first"),
      older,
      input("second"),
      latest,
      latest,
    ])?.images.map((x) => x.original.width),
    [4000],
  );
  assert.equal(
    projectImagePreparation([input("first"), older, input("second"), latest])
      ?.sampleId,
    "new",
  );
});

test("projection resets on thread switch or empty snapshot", () => {
  assert.equal(projectImagePreparation([]), null);
  assert.equal(
    projectImagePreparation([input("first"), notice("old", "first")])?.sampleId,
    "old",
  );
  assert.equal(projectImagePreparation([]), null);
});

test("original-detail fallback is explicit when capability is unknown", () => {
  assert.equal(
    projectImagePreparation([
      input("first"),
      notice("s", "first", { requestedDetail: "original", supports: null }),
    ])?.images[0]?.originalDetailFallback,
    "unknown",
  );
  assert.equal(
    projectImagePreparation([
      input("first"),
      notice("s", "first", { requestedDetail: "original", supports: false }),
    ])?.images[0]?.originalDetailFallback,
    "unsupported",
  );
  assert.equal(
    projectImagePreparation([
      input("first"),
      notice("s", "first", { requestedDetail: "high", supports: null }),
    ])?.images[0]?.originalDetailFallback,
    null,
  );
});

test("legacy notice without original metadata is ignored safely", () => {
  assert.equal(
    projectImagePreparation([
      input("first"),
      notice("s", "first", { original: false }),
    ]),
    null,
  );
});

test("compaction removes historical prepared view even while notice remains", () => {
  assert.equal(
    projectImagePreparation([
      input("first"),
      notice("s", "first"),
      selection(),
    ]),
    null,
  );
});

test("later sample-scoped media-unavailable marker retires prior preparation", () => {
  assert.equal(
    projectImagePreparation([
      input("first"),
      notice("s", "first"),
      unavailable("later"),
    ]),
    null,
  );
});

test("compaction retained IDs and exclusions control occurrence eligibility", () => {
  const kept = {
    ...selection(),
    content: {
      ...selection().content,
      retainedItemIds: ["first", "notice-s-first"],
    },
  } as ContextItem;
  assert.equal(
    projectImagePreparation([input("first"), notice("s", "first"), kept])
      ?.images.length,
    1,
  );
  const excluded = {
    ...kept,
    content: { ...kept.content, excludedItemIds: ["first"] },
  } as ContextItem;
  assert.equal(
    projectImagePreparation([input("first"), notice("s", "first"), excluded]),
    null,
  );
});
