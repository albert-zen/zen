import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  meaningfulTitleSource,
  ZenXThreadTitleCoordinator,
} from "../src/main/thread-title-coordinator.js";
import { ZenXThreadTitleStore } from "../src/main/thread-title-store.js";
import type {
  ThreadTitleInference,
  ThreadTitleSnapshot,
} from "../src/main/thread-title-types.js";

test("stages the first meaningful input immediately, bounds it, then generates", async () => {
  await withCoordinator(async ({ coordinator, inference, events, names }) => {
    const input = `## ${"A very long request ".repeat(8)}`;
    const observed = await coordinator.observe("thread-a", input);
    assert.equal(events[0]?.["thread-a"]?.status, "provisional");
    assert.equal(observed?.status, "generating");
    assert.ok(Array.from(observed?.title ?? "").length <= 64);
    inference.resolve("Semantic release planning");
    await waitFor(events, "thread-a", "generated");
    assert.equal(
      coordinator.snapshot()["thread-a"]?.title,
      "Semantic release planning",
    );
    assert.deepEqual(names.slice(-1), ["Semantic release planning"]);
  });
});

test("failure preserves the provisional title and explicit retry can generate", async () => {
  await withCoordinator(async ({ coordinator, inference, events }) => {
    const observed = await coordinator.observe(
      "thread-a",
      "Investigate flaky CI",
    );
    inference.reject(new Error("title model unavailable"));
    await waitFor(events, "thread-a", "failed");
    assert.equal(coordinator.snapshot()["thread-a"]?.title, observed?.title);
    const retry = await coordinator.retry("thread-a");
    assert.equal(retry.status, "generating");
    inference.resolve("Flaky CI investigation");
    await waitFor(events, "thread-a", "generated");
  });
});

test("manual rename before a late completion is authoritative", async () => {
  await withCoordinator(async ({ coordinator, inference, events }) => {
    await coordinator.observe("thread-a", "Original request");
    const manual = await coordinator.rename(
      "thread-a",
      "My authoritative title",
    );
    inference.resolve("Late generated title");
    await tick();
    assert.equal(manual.status, "manual");
    assert.equal(
      coordinator.snapshot()["thread-a"]?.title,
      "My authoritative title",
    );
    assert.equal(events.at(-1)?.["thread-a"]?.status, "manual");
  });
});

test("manual rename after generation remains authoritative", async () => {
  await withCoordinator(async ({ coordinator, inference, events }) => {
    await coordinator.observe("thread-a", "Original request");
    inference.resolve("Generated title");
    await waitFor(events, "thread-a", "generated");
    await coordinator.rename("thread-a", "Manual after generation");
    assert.equal(coordinator.snapshot()["thread-a"]?.status, "manual");
    assert.equal(
      coordinator.snapshot()["thread-a"]?.title,
      "Manual after generation",
    );
  });
});

test("duplicate first messages launch only one generation", async () => {
  await withCoordinator(async ({ coordinator, inference, events }) => {
    const first = await coordinator.observe("thread-a", "First request");
    const duplicate = await coordinator.observe(
      "thread-a",
      "Different duplicate",
    );
    assert.deepEqual(duplicate, first);
    assert.equal(inference.calls, 1);
    inference.resolve("Done");
    await waitFor(events, "thread-a", "generated");
  });
});

test("trigger envelopes and IDs are excluded from fallback title input", () => {
  const source = meaningfulTitleSource(
    [
      "[ZenX trigger wakeup]",
      "Trigger ID: 3f71ee79-11b0-4fd7-a449-78987c409abc",
      "Thread ID: 82c5f170-156b-4a92-b087-4ccaaf2702bb",
      "Task: Summarize the release blockers from the labelled source context",
    ].join("\n"),
  );
  assert.equal(
    source,
    "Summarize the release blockers from the labelled source context",
  );
  assert.doesNotMatch(source ?? "", /3f71|82c5|wakeup|Trigger ID/iu);
});

test("restart marks in-flight generation failed without automatic retry", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-restart-"),
  );
  try {
    const store = new ZenXThreadTitleStore(path.join(directory, "titles.json"));
    const inference = new ControlledInference();
    const first = coordinator(store, inference);
    await first.initialize();
    await first.observe("thread-a", "Restart race");
    const restartedInference = new ControlledInference();
    const restarted = coordinator(store, restartedInference);
    await restarted.initialize();
    assert.equal(restarted.snapshot()["thread-a"]?.status, "failed");
    assert.match(
      restarted.snapshot()["thread-a"]?.error ?? "",
      /Retry explicitly/u,
    );
    assert.equal(restartedInference.calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt title metadata disables naming without starting inference", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-corrupt-"),
  );
  try {
    const file = path.join(directory, "titles.json");
    await writeFile(file, "{not-json", "utf8");
    const inference = new ControlledInference();
    const instance = coordinator(new ZenXThreadTitleStore(file), inference);
    await instance.initialize();
    await assert.rejects(
      instance.observe("thread-a", "Turn must still be allowed by the caller"),
      /titles are unavailable/u,
    );
    assert.equal(inference.calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function withCoordinator(
  run: (context: {
    coordinator: ZenXThreadTitleCoordinator;
    inference: ControlledInference;
    events: ThreadTitleSnapshot[];
    names: string[];
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-title-"));
  try {
    const store = new ZenXThreadTitleStore(path.join(directory, "titles.json"));
    const inference = new ControlledInference();
    const names: string[] = [];
    const instance = coordinator(store, inference, names);
    const events: ThreadTitleSnapshot[] = [];
    instance.onChange((snapshot) => events.push(snapshot));
    await instance.initialize();
    await run({ coordinator: instance, inference, events, names });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function coordinator(
  store: ZenXThreadTitleStore,
  inference: ThreadTitleInference,
  names: string[] = [],
): ZenXThreadTitleCoordinator {
  return new ZenXThreadTitleCoordinator({
    store,
    inference,
    titleModel: () => "gpt-5.6-luna",
    setNativeName: async (_threadId, title) => {
      names.push(title);
    },
  });
}

class ControlledInference implements ThreadTitleInference {
  calls = 0;
  #pending: Array<{
    resolve(value: string): void;
    reject(error: Error): void;
  }> = [];

  async generate(): Promise<string> {
    this.calls += 1;
    return await new Promise<string>((resolve, reject) =>
      this.#pending.push({ resolve, reject }),
    );
  }

  resolve(value: string): void {
    this.#pending.shift()?.resolve(value);
  }
  reject(error: Error): void {
    this.#pending.shift()?.reject(error);
  }
}

async function waitFor(
  events: ThreadTitleSnapshot[],
  threadId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    if (events.some((snapshot) => snapshot[threadId]?.status === status))
      return;
    await tick();
  }
  assert.fail(`Timed out waiting for title status ${status}`);
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
