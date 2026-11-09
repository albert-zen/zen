import assert from "node:assert/strict";
import test from "node:test";
import { roomWorkspaceQuestionFixture } from "./room-workspace-question-fixture.js";

for (const stopBeforeReceipt of [true, false]) {
  test(`synthetic Room close ordering: stop before receipt=${stopBeforeReceipt}`, async () => {
    const f = await roomWorkspaceQuestionFixture();
    const q = await f.publish();
    const original = f.journal.append.bind(f.journal);
    let entered!: () => void;
    let release!: () => void;
    const committed = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    const events: string[] = [];
    let once = true;
    f.journal.append = async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (once) {
        once = false;
        events.push("journal-committed");
        entered();
        await gate;
        events.push("write-receipt-released");
      }
      return result;
    };
    const response = f.service
      .respondRoomQuestion(
        {
          roomId: f.room.id,
          questionId: q.id,
          expectedRevision: q.revision,
          clientId: "synthetic-receipt",
          outcome: "answer",
          answers: [
            { questionId: "scope", optionIds: [], text: "Synthetic answer" },
          ],
        },
        async () => {},
      )
      .then(
        () => null,
        (e: Error) => e,
      );
    try {
      await committed;
      const persistedCount = f.journal
        .metadata()
        .rooms.find((r) => r.id === f.room.id)!.messageCount;
      const projectedCount = f.service
        .snapshot()
        .rooms.find((r) => r.id === f.room.id)!.messageCount;
      assert.equal(persistedCount, (projectedCount ?? 0) + 1);
      let stopping: Promise<Error | null> | undefined;
      if (stopBeforeReceipt) {
        events.push("stop-requested");
        stopping = f.service.stop().then(
          () => null,
          (e: Error) => e,
        );
      }
      release();
      const responseError = await response;
      if (!stopping) {
        events.push("stop-requested");
        stopping = f.service.stop().then(
          () => null,
          (e: Error) => e,
        );
      }
      const stopError = await stopping;
      if (stopBeforeReceipt) {
        assert.match(responseError?.message ?? "", /service lifecycle changed/);
        assert.equal(stopError, null);
        assert.equal(
          f.service.snapshot().rooms.find((r) => r.id === f.room.id)!
            .messageCount,
          1,
        );
      } else {
        assert.equal(responseError, null);
        assert.equal(stopError, null);
      }
      assert.equal(
        f.journal.metadata().rooms.find((r) => r.id === f.room.id)!
          .messageCount,
        1,
      );
      await f.service.start();
      assert.equal(
        f.service.snapshot().rooms.find((r) => r.id === f.room.id)!
          .messageCount,
        1,
      );
      assert.equal(
        (await f.service.readRoomQuestion(f.room.id, q.id))!.state,
        "answered",
      );
      assert.deepEqual(
        events,
        stopBeforeReceipt
          ? ["journal-committed", "stop-requested", "write-receipt-released"]
          : ["journal-committed", "write-receipt-released", "stop-requested"],
      );
    } finally {
      release();
      await response;
      await f.close();
    }
  });
}
