import { describe, expect, it } from "vitest";

import { InMemoryItemList, type Item } from "../src/index.js";

describe("InMemoryItemList", () => {
  it("appends items in order with monotonic sequence numbers", () => {
    const items = new InMemoryItemList({
      generateId: (() => {
        let nextId = 0;
        return () => `item-${++nextId}`;
      })(),
      clock: () => 1000
    });

    const first = items.append({
      type: "user.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "hello" }
    });
    const second = items.append({
      type: "assistant.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "hi" }
    });

    expect(items.getItems()).toEqual([first, second]);
    expect(items.getItems().map((item) => item.seq)).toEqual([1, 2]);
  });

  it("generates required envelope fields from injected ID and clock functions", () => {
    const clockValues = [1100, 1200];
    const items = new InMemoryItemList({
      generateId: (() => {
        let nextId = 0;
        return () => `deterministic-${++nextId}`;
      })(),
      clock: () => clockValues.shift() ?? 0
    });

    const appended = items.append({
      type: "run.started",
      runId: "run-1",
      turnId: "turn-1",
      payload: { input: "start" }
    });

    expect(appended).toEqual({
      id: "deterministic-1",
      type: "run.started",
      createdAtMs: 1100,
      seq: 1,
      runId: "run-1",
      turnId: "turn-1",
      payload: { input: "start" }
    });
  });

  it("preserves optional envelope fields", () => {
    const items = new InMemoryItemList({
      generateId: () => "item-1",
      clock: () => 1000
    });

    const appended = items.append({
      type: "assistant.message.delta",
      runId: "run-1",
      turnId: "turn-1",
      parentId: "parent-1",
      causeId: "cause-1",
      targetId: "target-1",
      visibility: "trace",
      payload: { delta: "hel", index: 0 },
      meta: { provider: "fake" }
    });

    expect(appended).toMatchObject({
      parentId: "parent-1",
      causeId: "cause-1",
      targetId: "target-1",
      visibility: "trace",
      meta: { provider: "fake" }
    });
  });

  it("returns ordered snapshots without exposing internal order mutation", () => {
    const items = new InMemoryItemList({
      generateId: (() => {
        let nextId = 0;
        return () => `item-${++nextId}`;
      })(),
      clock: () => 1000
    });

    const first = items.append({
      type: "user.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "one" }
    });
    const second = items.append({
      type: "assistant.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "two" }
    });

    const snapshot = items.getItems() as Item[];

    snapshot.reverse();
    snapshot.push({
      id: "external",
      type: "user.message.completed",
      createdAtMs: 9999,
      seq: 999,
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "external" }
    });

    expect(items.getItems()).toEqual([first, second]);
  });

  it("returns item snapshots without exposing internal envelope mutation", () => {
    const items = new InMemoryItemList({
      generateId: () => "item-1",
      clock: () => 1000
    });

    items.append({
      type: "user.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "hello" },
      meta: { source: "test" }
    });

    const [snapshotItem] = items.getItems() as Array<
      Item & { id: string; meta: Record<string, unknown> }
    >;

    snapshotItem.id = "changed";
    snapshotItem.meta.source = "changed";

    expect(items.getItems()[0]).toMatchObject({
      id: "item-1",
      meta: { source: "test" }
    });
  });
});
