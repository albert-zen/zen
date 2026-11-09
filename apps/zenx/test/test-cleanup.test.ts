import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { finishTestCleanup } from "./test-cleanup.js";
import { roomWorkspaceQuestionFixture } from "./room-workspace-question-fixture.js";

test("cleanup preserves the primary failure when teardown succeeds", async () => {
  const primary = Error("assertion failed");
  let cleaned = false;
  await assert.rejects(
    finishTestCleanup(
      [
        () => {
          cleaned = true;
        },
      ],
      [primary],
    ),
    (error) => error === primary,
  );
  assert.equal(cleaned, true);
});

test("cleanup preserves the primary and every teardown failure in order", async () => {
  const primary = Error("assertion failed");
  const unmount = Error("unmount failed");
  const close = Error("close failed");
  const attempted: string[] = [];
  await assert.rejects(
    finishTestCleanup(
      [
        () => {
          attempted.push("unmount");
          throw unmount;
        },
        () => {
          attempted.push("dispose");
        },
        async () => {
          attempted.push("close");
          throw close;
        },
      ],
      [primary],
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, unmount, close]);
      return true;
    },
  );
  assert.deepEqual(attempted, ["unmount", "dispose", "close"]);
});

test("cleanup failures still fail a successful test", async () => {
  const cleanup = Error("cleanup failed");
  await assert.rejects(
    finishTestCleanup([
      () => {
        throw cleanup;
      },
    ]),
    (error) => error === cleanup,
  );
});

test("Room fixture waits for the issued response receipt before closing without replay", async () => {
  const f = await roomWorkspaceQuestionFixture();
  const question = await f.publish();
  let enterReceipt!: () => void;
  const receiptEntered = new Promise<void>((resolve) => {
    enterReceipt = resolve;
  });
  let releaseReceipt!: () => void;
  const receiptReleased = new Promise<void>((resolve) => {
    releaseReceipt = resolve;
  });
  const readReceipt = f.service.readRoomQuestionResponse.bind(f.service);
  let receiptReads = 0;
  f.service.readRoomQuestionResponse = async (...args) => {
    receiptReads++;
    enterReceipt();
    await receiptReleased;
    return readReceipt(...args);
  };
  const response = f.api.request({
    method: "respond",
    params: {
      roomId: f.room.id,
      questionId: question.id,
      expectedRevision: question.revision,
      clientId: "deferred-receipt",
      outcome: "cancel",
    },
  });
  await receiptEntered;
  const closeService = f.service.close.bind(f.service);
  let serviceClosed = false;
  f.service.close = async () => {
    serviceClosed = true;
    await closeService();
  };
  const closing = f.close();
  try {
    // Cross a task boundary while the receipt is deliberately unresolved.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(serviceClosed, false);
    await access(f.directory);
  } finally {
    releaseReceipt();
    await finishTestCleanup([
      async () => {
        await response;
      },
      () => closing,
    ]);
  }
  assert.equal(receiptReads, 1, "cleanup only settles the original response");
  assert.equal(serviceClosed, true);
  await assert.rejects(access(f.directory), { code: "ENOENT" });
});

test("Room fixture attempts service, journal and directory cleanup after sidebar failure", async () => {
  const f = await roomWorkspaceQuestionFixture();
  const sidebarFailure = Error("sidebar cleanup failed");
  const journalFailure = Error("journal cleanup failed");
  const closeSidebar = f.sidebar.close.bind(f.sidebar);
  const closeService = f.service.close.bind(f.service);
  const closeJournal = f.journal.close.bind(f.journal);
  const attempted: string[] = [];
  f.sidebar.close = async () => {
    attempted.push("sidebar");
    await closeSidebar();
    throw sidebarFailure;
  };
  f.service.close = async () => {
    attempted.push("service");
    await closeService();
  };
  f.journal.close = async () => {
    attempted.push("journal");
    await closeJournal();
    throw journalFailure;
  };
  await assert.rejects(f.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [sidebarFailure, journalFailure]);
    return true;
  });
  assert.deepEqual(attempted, ["sidebar", "service", "journal"]);
  await assert.rejects(access(f.directory), { code: "ENOENT" });
});

test("Room fixture reports failed response receipts and still removes its resources", async () => {
  const f = await roomWorkspaceQuestionFixture();
  const question = await f.publish();
  const failure = Error("receipt failed after commit");
  f.service.readRoomQuestionResponse = async () => {
    throw failure;
  };
  await assert.rejects(
    f.api.request({
      method: "respond",
      params: {
        roomId: f.room.id,
        questionId: question.id,
        expectedRevision: question.revision,
        clientId: "failed-receipt",
        outcome: "cancel",
      },
    }),
    (error) => error === failure,
  );
  await assert.rejects(f.close(), (error) => error === failure);
  await assert.rejects(access(f.directory), { code: "ENOENT" });
});
