import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXThreadTitleCoordinator } from "../src/main/thread-title-coordinator.js";
import { ZenXThreadTitleStore } from "../src/main/thread-title-store.js";
import type { ThreadTitleInference } from "../src/main/thread-title-types.js";

test("same-title and distinct native notifications always advance authority", async () => {
  await withDirectory(async (file) => {
    const instance = coordinator(
      file,
      new ControlledInference(),
      async () => undefined,
    );
    await instance.initialize();
    const renamed = await instance.rename("thread-a", "Same title");
    const same = await instance.synchronizeNativeName("thread-a", "Same title");
    assert.equal(same.status, "manual");
    assert.equal(same.version, renamed.version + 1);
    const distinct = await instance.synchronizeNativeName(
      "thread-a",
      "Distinct native title",
    );
    assert.equal(distinct.status, "manual");
    assert.equal(distinct.version, same.version + 1);
    await instance.close();
  });
});

test("newer same-title authority cancels an older queued conflict repair", async () => {
  await withDirectory(async (file) => {
    const active = deferred<void>();
    const dispatches: string[] = [];
    const instance = coordinator(
      file,
      new ControlledInference(),
      async (_threadId, title) => {
        dispatches.push(title);
        if (dispatches.length === 1) await active.promise;
      },
    );
    await instance.initialize();
    await instance.rename("thread-a", "A");
    await until(() => dispatches.length === 1);

    const conflict = await instance.synchronizeNativeName("thread-a", "C");
    const newer = await instance.synchronizeNativeName("thread-a", "A");
    assert.equal(conflict.version + 1, newer.version);
    assert.equal(newer.title, "A");

    active.resolve();
    await tick();
    await tick();
    assert.deepEqual(dispatches, ["A"]);
    assert.deepEqual(instance.snapshot()["thread-a"], newer);
    await instance.close();
  });
});

test("retired same-title evidence cannot consume a successor mirror or native authority", async () => {
  await withDirectory(async (file) => {
    const firstInference = new ControlledInference();
    const firstMirror = deferred<void>();
    const secondMirror = deferred<void>();
    const mirrorCalls: string[] = [];
    const first = coordinator(
      file,
      firstInference,
      async (_threadId, title) => {
        mirrorCalls.push(`A:${title}`);
        await firstMirror.promise;
      },
    );
    await first.initialize();
    await first.observe("thread-a", "Same title");
    firstInference.resolve("Same title");
    await until(() => mirrorCalls.length === 1);

    const observedBeforeRetire = await first.synchronizeNativeName(
      "thread-a",
      "Same title",
    );
    assert.equal(observedBeforeRetire.status, "manual");
    await settlesWithin(first.stop(), 100);

    const successor = coordinator(
      file,
      new ControlledInference(),
      async (_threadId, title) => {
        mirrorCalls.push(`B:${title}`);
        await secondMirror.promise;
      },
    );
    await successor.initialize();
    const successorRename = await successor.rename("thread-a", "Same title");
    await until(() => mirrorCalls.length === 2);

    const lateA = await successor.synchronizeNativeName(
      "thread-a",
      "Same title",
    );
    assert.equal(lateA.version, successorRename.version + 1);
    const liveB = await successor.synchronizeNativeName(
      "thread-a",
      "Same title",
    );
    assert.equal(liveB.version, lateA.version + 1);

    firstMirror.resolve();
    await tick();
    const laterA = await successor.synchronizeNativeName(
      "thread-a",
      "Same title",
    );
    assert.equal(laterA.version, liveB.version + 1);
    secondMirror.resolve();
    await successor.close();
  });
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`late ${outcome} from a retired owner repairs the current successor title`, async () => {
    await withDirectory(async (file) => {
      const late = deferred<void>();
      const calls: string[] = [];
      let nativeName: string | undefined;
      const first = coordinator(
        file,
        new ControlledInference(),
        async (_threadId, title) => {
          calls.push(`A:${title}`);
          await late.promise;
          nativeName = title;
          if (outcome === "reject") throw new Error("late retired rejection");
        },
      );
      await first.initialize();
      await first.rename("thread-a", "A");
      await until(() => calls.length === 1);

      const successor = coordinator(
        file,
        new ControlledInference(),
        async (_threadId, title) => {
          calls.push(`B:${title}`);
          nativeName = title;
        },
      );
      await successor.initialize();
      const renamed = await successor.rename("thread-a", "B");
      await until(() => nativeName === "B");

      late.resolve();
      await until(() => calls.length === 3, 200);
      assert.deepEqual(calls, ["A:A", "B:B", "B:B"]);
      assert.equal(nativeName, "B");
      assert.deepEqual(successor.snapshot()["thread-a"], renamed);

      await first.close();
      await successor.close();
    });
  });
}

test("more than 64 late retired completions stay bounded and preserve successor capacity", async () => {
  await withDirectory(async (file) => {
    const calls: string[] = [];
    const coordinators: ZenXThreadTitleCoordinator[] = [];
    const late: Array<ReturnType<typeof deferred<void>>> = [];
    let nativeName: string | undefined;

    for (let index = 0; index < 65; index += 1) {
      const completion = deferred<void>();
      late.push(completion);
      const instance = coordinator(
        file,
        new ControlledInference(),
        async (_threadId, title) => {
          calls.push(title);
          await completion.promise;
          nativeName = title;
        },
        0,
      );
      coordinators.push(instance);
      await instance.initialize();
      await instance.rename("thread-a", `Retired ${String(index)}`);
      await until(() => calls.length === index + 1);
    }

    const successor = coordinator(
      file,
      new ControlledInference(),
      async (_threadId, title) => {
        calls.push(title);
        nativeName = title;
      },
      0,
    );
    coordinators.push(successor);
    await successor.initialize();
    await successor.rename("thread-a", "Final successor");
    await until(() => nativeName === "Final successor");
    assert.equal(calls.length, 66);

    for (let index = 0; index < late.length; index += 1) {
      late[index]!.resolve();
      await until(
        () => calls.length === 67 + index && nativeName === "Final successor",
      );
    }
    assert.equal(calls.length, 131);
    assert.equal(nativeName, "Final successor");

    for (const instance of coordinators) await instance.close();
  });
});

test("retirement releases mirror reservations exactly once and restores capacity", async () => {
  await withDirectory(async (file) => {
    const calls: Array<ReturnType<typeof deferred<void>>> = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...arguments_: unknown[]) => {
      warnings.push(arguments_.map(String).join(" "));
    };
    try {
      const instance = coordinator(
        file,
        new ControlledInference(),
        async () => {
          const call = deferred<void>();
          calls.push(call);
          await call.promise;
        },
      );
      await instance.initialize();
      const owners = Array.from({ length: 70 }, () =>
        instance.createOwnershipTransaction({ deadlineMs: 0 }),
      );
      for (let index = 0; index < 64; index += 1) {
        await instance.rename(
          `thread-${String(index)}`,
          `Title ${String(index)}`,
          owners[index],
        );
      }
      await until(() => calls.length === 64);

      for (let index = 64; index < 67; index += 1) {
        await instance.rename(
          `overflow-${String(index)}`,
          `Overflow ${String(index)}`,
          owners[index],
        );
      }
      await tick();
      assert.equal(calls.length, 64);
      assert.equal(capacityWarnings(warnings), 1);

      await owners[0]!.retire();
      await instance.rename("successor-a", "Successor A", owners[67]);
      await until(() => calls.length === 65);

      calls[0]!.resolve();
      await tick();
      await instance.rename("still-full", "Still full", owners[68]);
      await tick();
      assert.equal(calls.length, 65);

      await owners[1]!.retire();
      await instance.rename("successor-b", "Successor B", owners[69]);
      await until(() => calls.length === 66);
      assert.equal(capacityWarnings(warnings), 2);

      for (const call of calls) call.resolve();
      await instance.close();
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("retired queued work detaches from a never-settling predecessor for its successor", async () => {
  await withDirectory(async (file) => {
    const calls: Array<{
      title: string;
      completion: ReturnType<typeof deferred<void>>;
    }> = [];
    const instance = coordinator(
      file,
      new ControlledInference(),
      async (_threadId, title) => {
        const completion = deferred<void>();
        calls.push({ title, completion });
        await completion.promise;
      },
    );
    await instance.initialize();
    const predecessor = instance.createOwnershipTransaction({ deadlineMs: 0 });
    const staleQueued = instance.createOwnershipTransaction({ deadlineMs: 0 });
    const successor = instance.createOwnershipTransaction({ deadlineMs: 0 });

    await instance.rename("thread-a", "Never settles", predecessor);
    await until(() => calls.length === 1);
    await instance.rename("thread-a", "Retired while queued", staleQueued);
    await staleQueued.retire();
    await instance.rename("thread-a", "Successor dispatch", successor);
    await predecessor.retire();

    await until(() => calls.length === 2);
    assert.deepEqual(
      calls.map((call) => call.title),
      ["Never settles", "Successor dispatch"],
    );
    calls[0]!.completion.resolve();
    calls[1]!.completion.resolve();
    await instance.close();
  });
});

test("throwing and rejected mirrors release their reservations", async () => {
  await withDirectory(async (file) => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...arguments_: unknown[]) => {
      warnings.push(arguments_.map(String).join(" "));
    };
    try {
      let calls = 0;
      const instance = coordinator(
        file,
        new ControlledInference(),
        (_threadId, _title) => {
          calls += 1;
          if (calls === 1) throw new Error("synchronous mirror throw");
          return Promise.reject(new Error("asynchronous mirror rejection"));
        },
      );
      await instance.initialize();
      await instance.rename("thread-a", "Throwing mirror");
      await until(() => calls === 1);
      await instance.rename("thread-b", "Rejected mirror");
      await until(() => calls === 2);
      await until(
        () =>
          warnings.filter((warning) => warning.includes("mirror")).length === 2,
      );
      assert.equal(
        warnings.filter((warning) => warning.includes("mirror")).length,
        2,
      );
      await instance.close();
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("stop, restart, and close detach never-settling title work within the deadline", async () => {
  await withDirectory(async (file) => {
    const inference = new ControlledInference();
    const mirrors: Array<ReturnType<typeof deferred<void>>> = [];
    const instance = coordinator(
      file,
      inference,
      async () => {
        const mirror = deferred<void>();
        mirrors.push(mirror);
        await mirror.promise;
      },
      10,
    );
    await instance.initialize();
    await instance.observe("thread-generation", "Never settling generation");
    await instance.rename("thread-mirror", "Never settling mirror");
    await until(() => mirrors.length === 1);

    await settlesWithin(instance.stop(), 100);
    inference.resolve("Late generated title");
    mirrors[0]!.resolve();
    await tick();
    assert.equal(
      instance.snapshot()["thread-generation"]?.status,
      "generating",
    );

    await settlesWithin(instance.restart(), 100);
    assert.equal(instance.snapshot()["thread-generation"]?.status, "failed");
    await instance.rename("thread-successor", "Successor mirror");
    await until(() => mirrors.length === 2);
    await settlesWithin(instance.close(), 100);
    mirrors[1]!.resolve();
  });
});

function coordinator(
  file: string,
  inference: ThreadTitleInference,
  setNativeName: (threadId: string, title: string) => Promise<void>,
  deadlineMs = 10,
): ZenXThreadTitleCoordinator {
  return new ZenXThreadTitleCoordinator({
    store: new ZenXThreadTitleStore(file),
    inference,
    titleModel: () => "gpt-5.6-luna",
    setNativeName,
    ownership: { deadlineMs },
  });
}

class ControlledInference implements ThreadTitleInference {
  readonly #pending: Array<ReturnType<typeof deferred<string>>> = [];

  async generate(): Promise<string> {
    const pending = deferred<string>();
    this.#pending.push(pending);
    return await pending.promise;
  }

  resolve(title: string): void {
    this.#pending.shift()?.resolve(title);
  }
}

async function withDirectory(
  run: (file: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-native-mirror-"),
  );
  try {
    await run(path.join(directory, "titles.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
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

function capacityWarnings(warnings: string[]): number {
  return warnings.filter((warning) => warning.includes("bounded transaction"))
    .length;
}

async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await tick();
  }
}

async function settlesWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return await Promise.race([
    operation,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`Operation exceeded ${String(timeoutMs)}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
