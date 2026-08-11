import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  meaningfulTitleSource,
  ZenXThreadTitleCoordinator,
} from "../src/main/thread-title-coordinator.js";
import { ZenXTriggerGenerationQuiescence } from "../src/main/trigger-generation-quiescence.js";
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

test("a retired observation queued behind a title mutation cannot commit or mirror", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-title-fence-"));
  try {
    const store = new BlockingTitleStore(path.join(directory, "titles.json"));
    const inference = new ControlledInference();
    const names: string[] = [];
    const instance = coordinator(store, inference, names);
    await instance.initialize();

    store.blockNextWrite();
    const first = instance.observe("thread-a", "Current generation title");
    await store.writeEntered;
    const controller = new AbortController();
    let current = true;
    const retired = instance.observe("thread-b", "Retired generation title", {
      signal: controller.signal,
      isCurrent: () => current,
      track: () => undefined,
    });
    current = false;
    controller.abort();
    store.releaseWrite();

    await first;
    assert.equal(await retired, undefined);
    assert.equal(instance.snapshot()["thread-b"], undefined);
    assert.equal(names.includes("Retired generation title"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retirement during an entered title-store write leaves no durable projection", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-durable-fence-"),
  );
  try {
    const store = new BlockingTitleStore(path.join(directory, "titles.json"));
    const owner = new ZenXTriggerGenerationQuiescence({ deadlineMs: 20 });
    const instance = coordinator(store, new ControlledInference());
    await instance.initialize();

    store.blockNextWrite();
    const staleObservation = instance.observe("thread-a", "Stale title", owner);
    await store.writeEntered;
    const retirement = owner.retire();
    store.releaseWrite();
    assert.equal(await staleObservation, undefined);
    await retirement;

    assert.equal(instance.snapshot()["thread-a"], undefined);
    assert.deepEqual(await store.read(), {});

    const successorOwner = new ZenXTriggerGenerationQuiescence({
      deadlineMs: 20,
    });
    const successor = coordinator(store, new ControlledInference());
    await successor.initialize();
    assert.equal(successor.snapshot()["thread-a"], undefined);
    const observed = await successor.observe(
      "thread-a",
      "Successor title",
      successorOwner,
    );
    assert.equal(observed?.source, "Successor title");
    await successorOwner.retire();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retirement aborts background title generation before commit and mirror", async () => {
  await withCoordinator(async ({ coordinator, inference, events, names }) => {
    const controller = new AbortController();
    let current = true;
    const background: Promise<void>[] = [];
    const observed = await coordinator.observe(
      "thread-a",
      "Generation-owned title",
      {
        signal: controller.signal,
        isCurrent: () => current,
        track: (operation) => background.push(operation),
      },
    );
    assert.equal(observed?.status, "generating");
    current = false;
    controller.abort();
    inference.resolve("Retired generated title");
    await Promise.all(background);

    assert.equal(coordinator.snapshot()["thread-a"]?.status, "generating");
    assert.equal(
      events.some(
        (snapshot) => snapshot["thread-a"]?.title === "Retired generated title",
      ),
      false,
    );
    assert.equal(names.includes("Retired generated title"), false);
    assert.equal(inference.signals[0]?.aborted, true);

    const restartedController = new AbortController();
    const restartedBackground: Promise<void>[] = [];
    const restarted = await coordinator.observe(
      "thread-a",
      "Generation-owned title",
      {
        signal: restartedController.signal,
        isCurrent: () => true,
        track: (operation) => restartedBackground.push(operation),
      },
    );
    assert.equal(restarted?.status, "generating");
    assert.equal(inference.calls, 2);
    inference.resolve("Restarted generated title");
    await Promise.all(restartedBackground);
    assert.equal(
      coordinator.snapshot()["thread-a"]?.title,
      "Restarted generated title",
    );
    assert.equal(names.includes("Restarted generated title"), true);
  });
});

test("quarantined stale title cannot swallow a newer authoritative native rename", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-mirror-owner-"),
  );
  try {
    const inference = new ControlledInference();
    const firstMirror = deferred<void>();
    const secondMirror = deferred<void>();
    const mirrorEntered = deferred<void>();
    const successorMirrorEntered = deferred<void>();
    const firstMirrorDone = deferred<void>();
    const mirrored: string[] = [];
    let instance!: ZenXThreadTitleCoordinator;
    let mirrorCalls = 0;
    instance = new ZenXThreadTitleCoordinator({
      store: new ZenXThreadTitleStore(path.join(directory, "titles.json")),
      inference,
      titleModel: () => "gpt-5.6-luna",
      setNativeName: async (threadId, title) => {
        mirrorCalls += 1;
        const call = mirrorCalls;
        mirrored.push(title);
        if (call === 1) {
          mirrorEntered.resolve();
          await firstMirror.promise;
        }
        if (call === 2) {
          successorMirrorEntered.resolve();
          await secondMirror.promise;
        }
        await instance.synchronizeNativeName(threadId, title);
        if (call === 1) firstMirrorDone.resolve();
      },
    });
    await instance.initialize();
    const firstOwner = new ZenXTriggerGenerationQuiescence({
      deadlineMs: 20,
    });
    const firstObservation = instance.observe(
      "thread-a",
      "Old source",
      firstOwner,
    );
    await mirrorEntered.promise;
    await firstOwner.retire();

    const secondOwner = new ZenXTriggerGenerationQuiescence({
      deadlineMs: 20,
    });
    const second = await instance.observe(
      "thread-a",
      "Old source",
      secondOwner,
    );
    assert.equal(second?.status, "generating");
    inference.resolve("New title");
    await until(() => instance.snapshot()["thread-a"]?.status === "generated");
    await successorMirrorEntered.promise;
    const generatedVersion = instance.snapshot()["thread-a"]?.version ?? 0;

    const authoritativeRename = instance.synchronizeNativeName(
      "thread-a",
      "Old source",
    );
    await until(() => instance.snapshot()["thread-a"]?.status === "manual");
    assert.equal(instance.snapshot()["thread-a"]?.title, "Old source");
    assert.equal(instance.snapshot()["thread-a"]?.status, "manual");
    assert.equal(
      instance.snapshot()["thread-a"]?.version,
      generatedVersion + 1,
    );

    secondMirror.resolve();
    await authoritativeRename;
    assert.equal(instance.snapshot()["thread-a"]?.title, "Old source");
    assert.equal(instance.snapshot()["thread-a"]?.status, "manual");
    firstMirror.resolve();
    await Promise.all([firstObservation, firstMirrorDone.promise]);
    assert.deepEqual(mirrored.slice(0, 2), ["Old source", "New title"]);
    await secondOwner.retire();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-title native notification is authoritative after successor mirror completion", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-same-native-authority-"),
  );
  try {
    const inference = new ControlledInference();
    const firstMirror = deferred<void>();
    const secondMirror = deferred<void>();
    const firstMirrorEntered = deferred<void>();
    const secondMirrorEntered = deferred<void>();
    const firstMirrorDone = deferred<void>();
    const secondMirrorDone = deferred<void>();
    let mirrorCalls = 0;
    let instance!: ZenXThreadTitleCoordinator;
    instance = new ZenXThreadTitleCoordinator({
      store: new ZenXThreadTitleStore(path.join(directory, "titles.json")),
      inference,
      titleModel: () => "gpt-5.6-luna",
      setNativeName: async (threadId, title) => {
        mirrorCalls += 1;
        const call = mirrorCalls;
        if (call === 1) {
          firstMirrorEntered.resolve();
          await firstMirror.promise;
        } else if (call === 2) {
          secondMirrorEntered.resolve();
          await secondMirror.promise;
        }
        await instance.synchronizeNativeName(threadId, title);
        if (call === 1) firstMirrorDone.resolve();
        if (call === 2) secondMirrorDone.resolve();
      },
    });
    await instance.initialize();

    const firstOwner = new ZenXTriggerGenerationQuiescence({ deadlineMs: 20 });
    const firstObservation = instance.observe(
      "thread-a",
      "Old source",
      firstOwner,
    );
    await firstMirrorEntered.promise;
    await firstOwner.retire();

    const secondOwner = new ZenXTriggerGenerationQuiescence({
      deadlineMs: 20,
    });
    await instance.observe("thread-a", "Old source", secondOwner);
    inference.resolve("Old source");
    await until(() => instance.snapshot()["thread-a"]?.status === "generated");
    await secondMirrorEntered.promise;
    secondMirror.resolve();
    await secondMirrorDone.promise;
    const generated = instance.snapshot()["thread-a"]!;

    const authoritative = await instance.synchronizeNativeName(
      "thread-a",
      "Old source",
    );
    assert.equal(authoritative.status, "manual");
    assert.equal(authoritative.version, generated.version + 1);

    firstMirror.resolve();
    await Promise.all([firstObservation, firstMirrorDone.promise]);
    assert.equal(instance.snapshot()["thread-a"]?.title, "Old source");
    assert.equal(instance.snapshot()["thread-a"]?.status, "manual");
    await secondOwner.retire();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("throwing native mirrors do not block generation or later authoritative rename", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-mirror-throw-"),
  );
  try {
    const inference = new ControlledInference();
    let mirrorCalls = 0;
    const instance = new ZenXThreadTitleCoordinator({
      store: new ZenXThreadTitleStore(path.join(directory, "titles.json")),
      inference,
      titleModel: () => "gpt-5.6-luna",
      setNativeName: async () => {
        mirrorCalls += 1;
        throw new Error("native mirror failed");
      },
    });
    await instance.initialize();
    await instance.observe("thread-a", "Mirror failure title");
    inference.resolve("Generated despite mirror failure");
    await until(() => instance.snapshot()["thread-a"]?.status === "generated");
    await instance.synchronizeNativeName("thread-a", "Native authority");
    assert.equal(instance.snapshot()["thread-a"]?.title, "Native authority");
    assert(mirrorCalls >= 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native mirror quarantine fails closed at 64 without evicting stale evidence", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-mirror-bound-"),
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...arguments_: unknown[]) => {
    warnings.push(arguments_.map(String).join(" "));
  };
  try {
    let mirrorCalls = 0;
    const instance = new ZenXThreadTitleCoordinator({
      store: new ZenXThreadTitleStore(path.join(directory, "titles.json")),
      inference: { generate: async () => await new Promise<string>(() => {}) },
      titleModel: () => "gpt-5.6-luna",
      setNativeName: async () => {
        mirrorCalls += 1;
        await new Promise<void>(() => {});
      },
    });
    await instance.initialize();
    for (let index = 0; index < 96; index += 1) {
      const owner = new ZenXTriggerGenerationQuiescence({ deadlineMs: 0 });
      await instance.observe(
        `thread-${String(index)}`,
        `Bounded mirror ${String(index)}`,
        owner,
      );
      await tick();
      await owner.retire();
    }
    assert.equal(mirrorCalls, 64);
    const overflow = Array.from({ length: 96 }, (_, index) =>
      instance.synchronizeNativeName(
        "thread-0",
        `Authoritative after capacity ${String(index)}`,
      ),
    );
    const overflowOutcome = await Promise.race([
      Promise.all(overflow).then(() => "settled" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 500),
      ),
    ]);
    assert.equal(overflowOutcome, "settled");
    assert.equal(
      instance.snapshot()["thread-0"]?.title,
      "Authoritative after capacity 95",
    );
    assert.equal(instance.snapshot()["thread-0"]?.status, "manual");
    assert.equal(mirrorCalls, 64);
    assert.equal(
      warnings.filter((warning) =>
        warning.includes("unresolved native mirror outcomes"),
      ).length,
      1,
    );
  } finally {
    console.warn = originalWarn;
    await rm(directory, { recursive: true, force: true });
  }
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
  readonly signals: AbortSignal[] = [];
  #pending: Array<{
    resolve(value: string): void;
    reject(error: Error): void;
  }> = [];

  async generate(
    _source: string,
    _model: string,
    signal: AbortSignal,
  ): Promise<string> {
    this.calls += 1;
    this.signals.push(signal);
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

class BlockingTitleStore extends ZenXThreadTitleStore {
  #block = false;
  #releaseWrite: (() => void) | undefined;
  #writeEntered: Promise<void> = Promise.resolve();
  #markWriteEntered: (() => void) | undefined;

  get writeEntered(): Promise<void> {
    return this.#writeEntered;
  }

  blockNextWrite(): void {
    this.#block = true;
    this.#writeEntered = new Promise<void>((resolve) => {
      this.#markWriteEntered = resolve;
    });
  }

  releaseWrite(): void {
    this.#releaseWrite?.();
  }

  override async write(snapshot: ThreadTitleSnapshot): Promise<void> {
    if (this.#block) {
      this.#block = false;
      this.#markWriteEntered?.();
      await new Promise<void>((resolve) => {
        this.#releaseWrite = resolve;
      });
    }
    await super.write(snapshot);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await tick();
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
