import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXThreadTitleCoordinator } from "../src/main/thread-title-coordinator.js";
import { ZenXThreadTitleOwnershipTransaction } from "../src/main/thread-title-ownership-transaction.js";
import {
  canonicalTitleProjectionKey,
  ZenXThreadTitleStore,
  type ZenXThreadTitleStoreFileSystem,
} from "../src/main/thread-title-store.js";
import type { ThreadTitleInference } from "../src/main/thread-title-types.js";

test("root observes a throwing nested child hook before it can reject", async () => {
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  try {
    const root = new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 5 });
    const child = root.fork({ deadlineMs: 5 });
    const grandchild = child.fork({ deadlineMs: 5 });
    grandchild.onRetire(() => {
      throw new Error("nested retirement hook failed");
    });

    await assert.rejects(root.retire(), /nested retirement hook failed/u);
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("nested scheduler failure closes stop, successor claim, and fresh read", async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, "titles.json");
    const store = new ZenXThreadTitleStore(file);
    const root = new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 5 });
    root.fork({
      deadlineMs: 5,
      schedule: () => {
        throw new Error("nested scheduler failed");
      },
    });
    await store.claim(root);

    await assert.rejects(root.retire(), /nested scheduler failed/u);
    const successor = new ZenXThreadTitleOwnershipTransaction({
      deadlineMs: 5,
    });
    await assert.rejects(store.claim(successor), /nested scheduler failed/u);

    const freshAlias = new ZenXThreadTitleStore(
      path.relative(process.cwd(), file),
    );
    const fresh = new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 5 });
    await assert.rejects(freshAlias.claim(fresh), /retirement failed/u);
    await successor.retire();
    await fresh.retire();
  });
});

for (const failure of ["hook", "scheduler"] as const) {
  test(`coordinator stop and aliased successor read fail closed over nested ${failure}`, async () => {
    await withDirectory(async (directory) => {
      const file = path.join(directory, "titles.json");
      const first = coordinator(new ZenXThreadTitleStore(file));
      await first.initialize();
      const child = first.createOwnershipTransaction(
        failure === "scheduler"
          ? {
              deadlineMs: 5,
              schedule: () => {
                throw new Error("coordinator nested scheduler");
              },
            }
          : { deadlineMs: 5 },
      );
      if (failure === "hook")
        child.onRetire(() => {
          throw new Error("coordinator nested hook");
        });

      await assert.rejects(first.stop(), new RegExp(failure, "u"));
      assert.throws(() => first.snapshot(), /titles are unavailable/u);

      const successor = coordinator(
        new ZenXThreadTitleStore(path.relative(process.cwd(), file)),
      );
      await successor.initialize();
      assert.throws(() => successor.snapshot(), new RegExp(failure, "u"));

      const fresh = coordinator(new ZenXThreadTitleStore(file));
      await fresh.initialize();
      assert.throws(() => fresh.snapshot(), /retirement failed/u);
    });
  });
}

test("an independently failed child immediately fences its coordinator domain", async () => {
  await withDirectory(async (directory) => {
    const titles = coordinator(
      new ZenXThreadTitleStore(path.join(directory, "titles.json")),
    );
    await titles.initialize();
    const child = titles.createOwnershipTransaction({ deadlineMs: 5 });
    child.onRetire(() => {
      throw new Error("independent nested failure");
    });

    await assert.rejects(child.retire(), /independent nested failure/u);
    assert.throws(() => titles.snapshot(), /independent nested failure/u);
    await assert.rejects(
      titles.rename("thread-a", "must not publish"),
      /independent nested failure/u,
    );
    await assert.rejects(titles.stop(), /independent nested failure/u);
  });
});

test("multiple nested retirement failures aggregate in stable bounded order", async () => {
  const root = new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 5 });
  const first = root.fork({ deadlineMs: 5 });
  const second = root.fork({
    deadlineMs: 5,
    schedule: () => {
      throw new Error("second scheduler");
    },
  });
  const third = second.fork({ deadlineMs: 5 });
  root.fork({
    deadlineMs: 5,
    schedule: () => ({}),
    cancelScheduled: () => {
      throw new Error("fourth cleanup");
    },
  });
  first.onRetire(() => {
    throw new Error("first hook");
  });
  third.onRetire(() => {
    throw new Error("third hook");
  });

  const started = Date.now();
  await assert.rejects(root.retire(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((entry: unknown) =>
        entry instanceof Error ? entry.message : String(entry),
      ),
      ["first hook", "second scheduler", "third hook", "fourth cleanup"],
    );
    return true;
  });
  assert.ok(Date.now() - started < 200);
});

test("a nested quiescence timeout observes late rejection", async () => {
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  try {
    const root = new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 0 });
    const child = root.fork({ deadlineMs: 0 });
    const late = deferred<void>();
    child.track(late.promise);
    await root.retire();
    late.reject(new Error("late after quiescence"));
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("late child failure after cached root retirement poisons stop and successor reads", async () => {
  await withDirectory(async (directory) => {
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    try {
      const file = path.join(directory, "titles.json");
      const store = new ZenXThreadTitleStore(file);
      const titles = coordinator(store, undefined, 0);
      await titles.initialize();
      const root = titles.createOwnershipTransaction({ deadlineMs: 0 }).root;
      root.onRetire(() => {
        setTimeout(() => {
          const lateChild = new ZenXThreadTitleOwnershipTransaction(
            {
              deadlineMs: 0,
              schedule: () => {
                throw new Error("late child scheduler");
              },
            },
            root,
          );
          void lateChild.retire();
        }, 20);
      });

      await titles.stop();
      await delay(60);
      assert.match(
        root.retirementFailure()?.message ?? "",
        /late child scheduler/u,
      );
      await assert.rejects(titles.stop(), /late child scheduler/u);
      assert.throws(() => titles.snapshot(), /late child scheduler/u);

      await assert.rejects(
        store.claim(new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 0 })),
        /late child scheduler/u,
      );

      const successor = coordinator(
        new ZenXThreadTitleStore(path.relative(process.cwd(), file)),
      );
      await successor.initialize();
      assert.throws(() => successor.snapshot(), /late child scheduler/u);

      const fresh = coordinator(new ZenXThreadTitleStore(file));
      await fresh.initialize();
      assert.throws(() => fresh.snapshot(), /retirement failed/u);
      await tick();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

test("late predecessor poison closes a successor read already in flight", async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, "titles.json");
    await writeFile(file, "{}\n", "utf8");
    const readEntered = deferred<void>();
    const releaseRead = deferred<void>();
    let blockRead = false;
    const fileSystem: ZenXThreadTitleStoreFileSystem = {
      ...injectedFileSystem(),
      readFile: async (candidate, encoding) => {
        if (blockRead) {
          readEntered.resolve();
          await releaseRead.promise;
        }
        return await readFile(candidate, encoding);
      },
    };
    const backendIdentity = {};
    const store = new ZenXThreadTitleStore(file, {
      fileSystem,
      backendIdentity,
    });
    const root = new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 0 });
    await store.claim(root);
    await root.retire();

    blockRead = true;
    const successor = new ZenXThreadTitleOwnershipTransaction({
      deadlineMs: 0,
    });
    const claim = store.claim(successor);
    await readEntered.promise;
    const lateChild = new ZenXThreadTitleOwnershipTransaction(
      {
        deadlineMs: 0,
        schedule: () => {
          throw new Error("late failure during read");
        },
      },
      root,
    );
    void lateChild.retire();
    await tick();
    releaseRead.resolve();

    await assert.rejects(claim, /late failure during read/u);
    await assert.rejects(
      store.claim(new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 0 })),
      /retirement failed/u,
    );
  });
});

test("retirement registration and failure evidence stay hard-bounded", async () => {
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  try {
    const root = new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 0 });
    for (let index = 0; index < 128; index += 1) {
      const child = root.fork({ deadlineMs: 0 });
      child.onRetire(() => {
        throw new Error(`failure-${String(index)}`);
      });
    }
    assert.throws(
      () => root.fork({ deadlineMs: 0 }),
      /bounded capacity of 128 nested transactions/u,
    );
    for (let index = 0; index < 1_000; index += 1) {
      assert.throws(
        () => root.fork({ deadlineMs: 0 }),
        /retired title ownership/u,
      );
    }

    await assert.rejects(root.retire(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 64);
      assert.equal(
        (error.errors[0] as Error | undefined)?.message,
        "failure-0",
      );
      assert.match(
        (error.errors.at(-1) as Error | undefined)?.message ?? "",
        /bounded capacity of 128 nested transactions/u,
      );
      assert.ok(error.message.length <= 12_000);
      return true;
    });
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("a failed ownership domain does not poison another projection", async () => {
  await withDirectory(async (directory) => {
    const failed = new ZenXThreadTitleStore(path.join(directory, "a.json"));
    const healthy = new ZenXThreadTitleStore(path.join(directory, "b.json"));
    const failedRoot = new ZenXThreadTitleOwnershipTransaction({
      deadlineMs: 5,
      schedule: () => {
        throw new Error("domain A scheduler");
      },
    });
    await failed.claim(failedRoot);
    await assert.rejects(failedRoot.retire(), /domain A scheduler/u);
    await assert.rejects(
      failed.claim(new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 5 })),
      /domain A scheduler/u,
    );

    const healthyOwner = new ZenXThreadTitleOwnershipTransaction({
      deadlineMs: 5,
    });
    assert.deepEqual(await healthy.claim(healthyOwner), {});
    await healthyOwner.retire();
  });
});

test("Windows case aliases have one canonical projection key before creation", () => {
  const options = {
    platform: "win32" as const,
    cwd: "C:\\Users\\Zen\\Project",
    realpath: (candidate: string) => {
      if (candidate.toLowerCase() === "c:\\users\\zen") return "C:\\Users\\Zen";
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    },
  };
  assert.equal(
    canonicalTitleProjectionKey("C:\\Users\\Zen\\Future\\Titles.JSON", options),
    canonicalTitleProjectionKey("c:\\users\\zen\\future\\titles.json", options),
  );
});

test("relative, absolute, and canonical aliases share one default domain", async () => {
  await withDirectory(async (directory) => {
    const physical = path.join(directory, "physical");
    const alias = path.join(directory, "alias");
    await mkdir(physical);
    await symlink(
      physical,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const absolute = path.join(physical, "titles.json");
    const relative = path.relative(process.cwd(), absolute);
    const canonicalAlias = path.join(alias, "titles.json");

    const first = new ZenXThreadTitleStore(relative);
    const second = new ZenXThreadTitleStore(absolute);
    const third = new ZenXThreadTitleStore(canonicalAlias);
    assert.equal(first.ownershipDomain, second.ownershipDomain);
    assert.equal(second.ownershipDomain, third.ownershipDomain);
    assert.notEqual(
      first.ownershipDomain,
      new ZenXThreadTitleStore(path.join(physical, "other.json"))
        .ownershipDomain,
    );
  });
});

test(
  "Windows case aliases share a store domain",
  { skip: process.platform !== "win32" },
  async () => {
    await withDirectory(async (directory) => {
      const file = path.join(directory, "Future", "Titles.json");
      const caseAlias = file.toUpperCase();
      assert.equal(
        new ZenXThreadTitleStore(file).ownershipDomain,
        new ZenXThreadTitleStore(caseAlias).ownershipDomain,
      );
    });
  },
);

test("aliased coordinators share one native mirror queue", async () => {
  await withDirectory(async (directory) => {
    const physical = path.join(directory, "physical");
    const alias = path.join(directory, "alias");
    await mkdir(physical);
    await symlink(
      physical,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const late = deferred<void>();
    const calls: string[] = [];
    let nativeName: string | undefined;
    const first = coordinator(
      new ZenXThreadTitleStore(path.join(alias, "titles.json")),
      async (_threadId, title) => {
        calls.push(`A:${title}`);
        await late.promise;
        nativeName = title;
      },
      0,
    );
    await first.initialize();
    await first.rename("thread-a", "A");
    await until(() => calls.length === 1);

    const successor = coordinator(
      new ZenXThreadTitleStore(path.join(physical, "titles.json")),
      async (_threadId, title) => {
        calls.push(`B:${title}`);
        nativeName = title;
      },
      0,
    );
    await successor.initialize();
    await successor.rename("thread-a", "B");
    await until(() => nativeName === "B");

    late.resolve();
    await until(() => calls.length === 3 && nativeName === "B");
    assert.deepEqual(calls, ["A:A", "B:B", "B:B"]);
    await first.close();
    await successor.close();
  });
});

test("backend identity participates in ownership-domain identity", async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, "titles.json");
    const backendA = {};
    const backendB = {};
    const fileSystem = injectedFileSystem();
    const first = new ZenXThreadTitleStore(file, {
      fileSystem,
      backendIdentity: backendA,
    });
    const sameBackend = new ZenXThreadTitleStore(
      path.relative(process.cwd(), file),
      { fileSystem, backendIdentity: backendA },
    );
    const differentBackend = new ZenXThreadTitleStore(file, {
      fileSystem,
      backendIdentity: backendB,
    });

    assert.equal(first.ownershipDomain, sameBackend.ownershipDomain);
    assert.notEqual(first.ownershipDomain, differentBackend.ownershipDomain);
    assert.throws(
      () => new ZenXThreadTitleStore(file, { fileSystem }),
      /backendIdentity/u,
    );
  });
});

test("ownership-domain identity registry fails closed at its bound", async () => {
  await withDirectory(async (directory) => {
    const backendIdentity = {};
    const fileSystem = injectedFileSystem();
    const stores = Array.from(
      { length: 64 },
      (_, index) =>
        new ZenXThreadTitleStore(
          path.join(directory, `titles-${String(index)}.json`),
          { fileSystem, backendIdentity },
        ),
    );
    assert.equal(stores.length, 64);
    assert.throws(
      () =>
        new ZenXThreadTitleStore(path.join(directory, "overflow.json"), {
          fileSystem,
          backendIdentity,
        }),
      /bounded capacity of 64/u,
    );
  });
});

test("poisoned predecessor cannot be bypassed through a canonical alias", async () => {
  await withDirectory(async (directory) => {
    const physical = path.join(directory, "physical");
    const alias = path.join(directory, "alias");
    await mkdir(physical);
    await symlink(
      physical,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const firstStore = new ZenXThreadTitleStore(
      path.join(alias, "titles.json"),
    );
    const root = new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 5 });
    root.fork({
      deadlineMs: 5,
      schedule: () => {
        throw new Error("aliased predecessor failed");
      },
    });
    await firstStore.claim(root);
    await assert.rejects(root.retire(), /aliased predecessor failed/u);

    const canonicalStore = new ZenXThreadTitleStore(
      path.join(await realpath(physical), "titles.json"),
    );
    await assert.rejects(
      canonicalStore.claim(
        new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 5 }),
      ),
      /aliased predecessor failed/u,
    );
  });
});

function injectedFileSystem(): ZenXThreadTitleStoreFileSystem {
  return {
    mkdir,
    readFile,
    writeFile: async (file, data, options) => {
      await writeFile(file, data, options);
    },
    rename,
    rm: async (file, options) => {
      await rm(file, options);
    },
  };
}

function coordinator(
  store: ZenXThreadTitleStore,
  setNativeName: (
    threadId: string,
    title: string,
  ) => Promise<void> = async () => undefined,
  deadlineMs = 5,
): ZenXThreadTitleCoordinator {
  return new ZenXThreadTitleCoordinator({
    store,
    inference: new NeverInference(),
    titleModel: () => "gpt-5.6-luna",
    setNativeName,
    ownership: { deadlineMs },
  });
}

class NeverInference implements ThreadTitleInference {
  async generate(): Promise<string> {
    return await new Promise<string>(() => undefined);
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
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await tick();
  }
}

async function withDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-ownership-root-"),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
