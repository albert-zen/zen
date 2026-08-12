import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXThreadTitleCoordinator } from "../src/main/thread-title-coordinator.js";
import { ZenXThreadTitleOwnershipTransaction } from "../src/main/thread-title-ownership-transaction.js";
import {
  ZenXThreadTitleStore,
  type ZenXThreadTitleStoreFileSystem,
} from "../src/main/thread-title-store.js";
import type { ThreadTitleInference } from "../src/main/thread-title-types.js";

for (const phase of [
  "mkdir",
  "staged-write",
  "commit-before-replace",
  "atomic-replace",
] as const) {
  test(`successor claim hides a retired owner during ${phase}`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), `zenx-title-${phase}-`),
    );
    const file = path.join(directory, "titles.json");
    try {
      const controlled = new ControlledTitleFileSystem();
      const first = coordinator(
        new ZenXThreadTitleStore(file, {
          fileSystem: controlled,
          backendIdentity: controlled,
        }),
      );
      await first.initialize();
      controlled.block(phase);
      const stale = first.observe("thread-a", "Retired owner title");
      await controlled.entered;

      const successor = coordinator(
        new ZenXThreadTitleStore(file, {
          fileSystem: controlled,
          backendIdentity: controlled,
        }),
      );
      let initialized = false;
      const initialization = successor.initialize().then(() => {
        initialized = true;
      });
      await tick();
      assert.equal(initialized, false);
      assert.throws(() => successor.snapshot(), /not initialized/u);

      controlled.release();
      assert.equal(await stale, undefined);
      await initialization;
      assert.deepEqual(successor.snapshot(), {});
      assert.deepEqual(await readJsonOrEmpty(file), {});
      assert.deepEqual(await stagedFiles(directory), []);
      await successor.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("compensation failure poisons serialized reads instead of exposing stale data", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-compensation-"),
  );
  const file = path.join(directory, "titles.json");
  try {
    await writeFile(file, "{}\n", "utf8");
    const controlled = new ControlledTitleFileSystem();
    controlled.failCompensation = true;
    const first = coordinator(
      new ZenXThreadTitleStore(file, {
        fileSystem: controlled,
        backendIdentity: controlled,
      }),
    );
    await first.initialize();
    controlled.block("atomic-replace");
    const stale = first.observe("thread-a", "Never authoritative");
    await controlled.entered;

    const successor = coordinator(
      new ZenXThreadTitleStore(file, {
        fileSystem: controlled,
        backendIdentity: controlled,
      }),
    );
    const initialization = successor.initialize();
    controlled.release();
    await assert.rejects(stale, /compensation failed/u);
    await initialization;
    assert.throws(() => successor.snapshot(), /compensation failed/u);

    const fresh = coordinator(
      new ZenXThreadTitleStore(file, {
        fileSystem: controlled,
        backendIdentity: controlled,
      }),
    );
    await fresh.initialize();
    assert.throws(() => fresh.snapshot(), /compensation failed/u);
    assert.deepEqual(await stagedFiles(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const failure of ["scheduler", "retirement hook"] as const) {
  test(`successor claim handles and propagates ${failure} rejection`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-title-retirement-failure-"),
    );
    const file = path.join(directory, "titles.json");
    try {
      const store = new ZenXThreadTitleStore(file);
      const predecessor = new ZenXThreadTitleOwnershipTransaction(
        failure === "scheduler"
          ? {
              deadlineMs: 10,
              schedule: () => {
                throw new Error("scheduler failed");
              },
            }
          : { deadlineMs: 10 },
      );
      if (failure === "retirement hook")
        predecessor.onRetire(() => {
          throw new Error("retirement hook failed");
        });
      await store.claim(predecessor);

      const successor = new ZenXThreadTitleOwnershipTransaction({
        deadlineMs: 10,
      });
      await assert.rejects(store.claim(successor), new RegExp(failure, "u"));
      await tick();

      const fresh = new ZenXThreadTitleOwnershipTransaction({ deadlineMs: 10 });
      await assert.rejects(store.claim(fresh), /retirement failed/u);
      await successor.retire();
      await fresh.retire();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const failure of ["write", "rename"] as const) {
  test(`${failure} failure removes every staged title file`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), `zenx-title-${failure}-failure-`),
    );
    const file = path.join(directory, "titles.json");
    try {
      const controlled = new ControlledTitleFileSystem();
      controlled.failure = failure;
      const instance = coordinator(
        new ZenXThreadTitleStore(file, {
          fileSystem: controlled,
          backendIdentity: controlled,
        }),
      );
      await instance.initialize();
      await assert.rejects(
        instance.observe("thread-a", "Failed staged title"),
        new RegExp(`${failure} failed`, "u"),
      );
      assert.deepEqual(instance.snapshot(), {});
      assert.deepEqual(await stagedFiles(directory), []);
      await instance.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

type BlockPhase =
  "mkdir" | "staged-write" | "commit-before-replace" | "atomic-replace";

class ControlledTitleFileSystem implements ZenXThreadTitleStoreFileSystem {
  failure: "write" | "rename" | undefined;
  failCompensation = false;
  #phase: BlockPhase | undefined;
  #entered = deferred<void>();
  #release = deferred<void>();

  get entered(): Promise<void> {
    return this.#entered.promise;
  }

  block(phase: BlockPhase): void {
    this.#phase = phase;
    this.#entered = deferred<void>();
    this.#release = deferred<void>();
  }

  release(): void {
    this.#release.resolve();
  }

  async mkdir(
    directory: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown> {
    if (this.#phase === "mkdir") await this.#hold();
    return await mkdir(directory, options);
  }

  async readFile(file: string, encoding: "utf8"): Promise<string> {
    return await readFile(file, encoding);
  }

  async writeFile(
    file: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ): Promise<void> {
    await writeFile(file, data, options);
    if (this.failure === "write") {
      this.failure = undefined;
      throw new Error("write failed");
    }
    if (this.#phase === "staged-write") await this.#hold();
  }

  async rename(source: string, destination: string): Promise<void> {
    if (this.failCompensation && source.includes(".compensate.tmp"))
      throw new Error("compensation rename failed");
    if (this.failure === "rename") {
      this.failure = undefined;
      throw new Error("rename failed");
    }
    if (this.#phase === "commit-before-replace") await this.#hold();
    await rename(source, destination);
    if (this.#phase === "atomic-replace") await this.#hold();
  }

  async rm(file: string, options: { force: true }): Promise<void> {
    await rm(file, options);
  }

  async #hold(): Promise<void> {
    const entered = this.#entered;
    const release = this.#release;
    this.#phase = undefined;
    entered.resolve();
    await release.promise;
  }
}

function coordinator(store: ZenXThreadTitleStore): ZenXThreadTitleCoordinator {
  return new ZenXThreadTitleCoordinator({
    store,
    inference: new NeverInference(),
    titleModel: () => "gpt-5.6-luna",
    setNativeName: async () => undefined,
    ownership: { deadlineMs: 10 },
  });
}

class NeverInference implements ThreadTitleInference {
  async generate(): Promise<string> {
    return await new Promise<string>(() => undefined);
  }
}

async function readJsonOrEmpty(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function stagedFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((file) => file.endsWith(".tmp"));
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

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
