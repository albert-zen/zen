import assert from "node:assert/strict";
import test from "node:test";
import { localErrorDetail } from "../src/local-error-detail.js";
import {
  compactionIpcRejection,
  unwrapCompactionIpcReply,
} from "../src/preload/compaction-ipc.js";

test("stack, nested cause and aggregate errors survive the plain-data IPC envelope", () => {
  const reason = Object.assign(
    new Error("Compaction failed", {
      cause: new AggregateError(
        [new Error("socket disconnected")],
        "transport",
      ),
    }),
    { code: "compaction_generation_failed" },
  );
  const reply = structuredClone(compactionIpcRejection(reason));
  assert.match(reply.detail!, /socket disconnected/);
  assert.match(reply.detail!, /local-error-detail.test/);
  assert.throws(
    () => unwrapCompactionIpcReply(reply),
    (error) => {
      assert.equal(localErrorDetail(error), reply.detail);
      return true;
    },
  );
});
test("cycles, accessors and oversized details terminate with explicit evidence limits", () => {
  const reason: Record<string, unknown> = { message: "x" };
  reason.cause = reason;
  Object.defineProperty(reason, "stack", {
    get() {
      throw new Error("must not execute");
    },
  });
  const text = localErrorDetail(reason);
  assert.match(text, /circular/);
  assert.match(text, /accessor not evaluated/);
  assert.match(
    localErrorDetail({ message: "x".repeat(100_000) }),
    /limit reached/,
  );
});

test("lazy native Error stack must not invoke unsafe name/message accessors", () => {
  for (const field of ["name", "message"]) {
    let calls = 0;
    const reason = new Error("original message", {
      cause: new Error("nested cause"),
    });
    Object.defineProperty(reason, field, {
      get() {
        calls++;
        throw new Error("unsafe");
      },
    });
    const detail = localErrorDetail(reason);
    assert.equal(calls, 0);
    assert.match(detail, /lazy stack skipped/);
    assert.match(detail, /nested cause/);
    if (field === "name") assert.match(detail, /original message/);
  }
});
test("only authentication header fields are omitted, response/body text stays owner-readable", () => {
  const detail = localErrorDetail({
    headers: {
      Authorization: "Bearer synthetic-header-key",
      "x-api-key": "synthetic-api-key",
      "content-type": "text/plain",
    },
    body: "synthetic-body-key",
    cause: new Error("synthetic local cause"),
  });
  assert.doesNotMatch(detail, /synthetic-header-key|synthetic-api-key/);
  assert.match(detail, /authentication header omitted/);
  assert.match(detail, /synthetic-body-key/);
  assert.match(detail, /synthetic local cause/);
});
