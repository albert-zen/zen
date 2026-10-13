import assert from "node:assert/strict";
import test from "node:test";
import type { ShellPtyProcess } from "../../../src/shell-session.js";
import { createShellDiagnosticCleanup } from "./fixtures/shell-diagnostic-cleanup.js";

function fixture(killFailure?: Error) {
  let emitExit!: (event: { exitCode: number }) => void;
  let closes = 0;
  const disposed: string[] = [];
  const raw: ShellPtyProcess = {
    write() {},
    resize() {},
    onData: () => ({
      dispose: () => {
        disposed.push("data");
      },
    }),
    onExit(listener) {
      emitExit = listener;
      return {
        dispose: () => {
          disposed.push("exit");
        },
      };
    },
    kill() {
      closes++;
      if (killFailure) throw killFailure;
    },
  };
  const owner = createShellDiagnosticCleanup();
  const terminal = owner.wrap(raw, "win32");
  owner.register(terminal.onData(() => {}));
  let exited = false;
  owner.register(
    terminal.onExit(({ exitCode }) => {
      assert.equal(exitCode, 0);
      exited = true;
    }),
  );
  return {
    owner,
    disposed,
    exit: () => emitExit({ exitCode: 0 }),
    exited: () => exited,
    closes: () => closes,
  };
}

test("the actual Windows wrapper's warning cannot hide an owned native cleanup failure", async () => {
  const error = new Error("injected owned native close failure");
  const f = fixture(error);
  f.exit();
  assert.equal(f.exited(), true);
  const order: string[] = [];
  let report: unknown;
  await assert.rejects(
    f.owner.finish({
      exited: f.exited(),
      observe: async () => {
        order.push("observe");
        return { metadata: "partial facts" };
      },
      removeDirectory: async () => {
        order.push("remove");
      },
      report: (result) => {
        order.push("report");
        report = result;
      },
    }),
    (failure: unknown) =>
      failure instanceof AggregateError && failure.errors.includes(error),
  );
  assert.equal(f.closes(), 1);
  assert.deepEqual(f.disposed, ["data", "exit"]);
  assert.deepEqual(order, ["observe", "remove", "report"]);
  assert.deepEqual(report, {
    primaryFailure: null,
    cleanupFailures: [{ stage: "owned native close", error: String(error) }],
    observation: { metadata: "partial facts" },
  });
});

test("timeout keeps the primary error and final evidence even when kill and disposal throw", async () => {
  const primary = new Error("original 25s diagnostic timeout");
  const f = fixture(new Error("injected kill failure"));
  f.owner.register({
    dispose: () => {
      throw new Error("injected dispose failure");
    },
  });
  let removed = false;
  let report:
    | {
        primaryFailure: string | null;
        cleanupFailures: { stage: string; error: string }[];
        observation: unknown;
      }
    | undefined;
  await assert.rejects(
    f.owner.finish({
      exited: false,
      primaryFailure: { error: primary },
      observe: async () => ({
        stages: ["ENGINE_READY"],
        metadata: "retained before removal",
      }),
      removeDirectory: async () => {
        removed = true;
      },
      report: (result) => {
        report = result;
      },
    }),
    (error: unknown) => error === primary,
  );
  assert.equal(removed, true);
  assert.deepEqual(f.disposed, ["data", "exit"]);
  assert.equal(report?.primaryFailure, String(primary));
  assert.deepEqual(
    report?.cleanupFailures.map(({ stage }) => stage),
    ["owned native close", "subscription disposal"],
  );
  assert.deepEqual(report?.observation, {
    stages: ["ENGINE_READY"],
    metadata: "retained before removal",
  });
});

test("pre-spawn failure still observes and removes its temporary directory", async () => {
  const owner = createShellDiagnosticCleanup();
  const primary = new Error("dependency verification failed");
  let removed = false;
  let reported = false;
  await assert.rejects(
    owner.finish({
      exited: false,
      primaryFailure: { error: primary },
      observe: async () => ({ stages: [] }),
      removeDirectory: async () => {
        removed = true;
      },
      report: () => {
        reported = true;
      },
    }),
    (error: unknown) => error === primary,
  );
  assert(removed && reported);
});

test("a successful natural close reports clean evidence and disposes subscriptions", async () => {
  const f = fixture();
  f.exit();
  let removed = false;
  await f.owner.finish({
    exited: true,
    observe: async () => ({ complete: true }),
    removeDirectory: async () => {
      removed = true;
    },
    report: ({ primaryFailure, cleanupFailures, observation }) => {
      assert.equal(primaryFailure, null);
      assert.deepEqual(cleanupFailures, []);
      assert.deepEqual(observation, { complete: true });
    },
  });
  assert.equal(f.closes(), 1);
  assert.deepEqual(f.disposed, ["data", "exit"]);
  assert.equal(removed, true);
});
