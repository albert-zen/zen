import { describe, expect, it } from "vitest";

import { InMemoryItemList, ItemObserverError, type Item } from "../src/index.js";

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

  it("notifies observers after an item is appended", () => {
    const observed: Item[] = [];
    const items = new InMemoryItemList({
      generateId: () => "item-1",
      clock: () => 1000
    });

    items.observe((item) => {
      observed.push(item);
    });

    const appended = items.append({
      type: "user.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "hello" }
    });

    expect(observed).toEqual([appended]);
  });

  it("notifies observers in item sequence order and observer registration order", () => {
    const observed: string[] = [];
    const items = new InMemoryItemList({
      generateId: (() => {
        let nextId = 0;
        return () => `item-${++nextId}`;
      })(),
      clock: () => 1000
    });

    items.observe((item) => {
      observed.push(`first:${item.seq}:${item.type}`);
    });
    items.observe((item) => {
      observed.push(`second:${item.seq}:${item.type}`);
    });

    items.append({
      type: "user.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "hello" }
    });
    items.append({
      type: "assistant.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "hi" }
    });

    expect(observed).toEqual([
      "first:1:user.message.completed",
      "second:1:user.message.completed",
      "first:2:assistant.message.completed",
      "second:2:assistant.message.completed"
    ]);
  });

  it("commits appended items and reports observer failures after notifying remaining observers", () => {
    const observed: string[] = [];
    const items = new InMemoryItemList({
      generateId: () => "item-1",
      clock: () => 1000
    });

    items.observe((item) => {
      observed.push(`failing:${item.seq}`);
      throw new Error("persist failed");
    });
    items.observe((item) => {
      observed.push(`second:${item.seq}`);
    });

    let observerError: unknown;

    try {
      items.append({
        type: "user.message.completed",
        runId: "run-1",
        turnId: "turn-1",
        payload: { content: "hello" }
      });
    } catch (cause) {
      observerError = cause;
    }

    expect(observerError).toBeInstanceOf(ItemObserverError);
    expect((observerError as ItemObserverError).failures).toEqual([
      expect.objectContaining({
        observerIndex: 0,
        item: expect.objectContaining({
          id: "item-1",
          seq: 1,
          type: "user.message.completed"
        }),
        cause: expect.objectContaining({
          message: "persist failed"
        })
      })
    ]);
    expect(observed).toEqual(["failing:1", "second:1"]);
    expect(items.getItems()).toHaveLength(1);
  });

  it("notifies observers with snapshots that cannot mutate committed item payloads", () => {
    const items = new InMemoryItemList({
      generateId: () => "item-1",
      clock: () => 1000
    });

    items.observe((item) => {
      const payload = item.payload as { content: string };
      payload.content = "mutated by observer";
    });

    items.append({
      type: "user.message.completed",
      runId: "run-1",
      turnId: "turn-1",
      payload: { content: "hello" }
    });

    expect(items.getItems()[0]?.payload).toEqual({ content: "hello" });
  });

  it("reports async observers as unsupported instead of ignoring rejected promises", () => {
    const observed: string[] = [];
    const items = new InMemoryItemList({
      generateId: () => "item-1",
      clock: () => 1000
    });

    items.observe(async () => {
      observed.push("async");
      throw new Error("async persist failed");
    });
    items.observe((item) => {
      observed.push(`sync:${item.seq}`);
    });

    let observerError: unknown;

    try {
      items.append({
        type: "user.message.completed",
        runId: "run-1",
        turnId: "turn-1",
        payload: { content: "hello" }
      });
    } catch (cause) {
      observerError = cause;
    }

    expect(observerError).toBeInstanceOf(ItemObserverError);
    expect((observerError as ItemObserverError).failures).toEqual([
      expect.objectContaining({
        observerIndex: 0,
        cause: expect.objectContaining({
          message: "Async item observers are not supported by synchronous append"
        })
      })
    ]);
    expect(observed).toEqual(["async", "sync:1"]);
    expect(items.getItems()).toHaveLength(1);
  });
});
