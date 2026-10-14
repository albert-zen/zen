import assert from "node:assert/strict";
import test from "node:test";
import { isHostCommand, isHostEvent } from "../src/main/host-messages.js";
import { validateModelRequestDebugCommand } from "../../cli/src/model-request-debug.js";

test("local debug IPC accepts only bounded known operations, not arbitrary paths or remote targets", () => {
  for (const input of [
    { action: "status" },
    { action: "setEnabled", enabled: true },
    { action: "list", threadId: "synthetic", query: "fixture" },
    { action: "read", id: "synthetic", offset: 0, view: "configuration" },
    { action: "clear" },
  ])
    assert.equal(
      isHostCommand({
        type: "model-debug/request",
        requestId: "synthetic",
        input,
      }),
      true,
    );
  for (const input of [
    { action: "setEnabled", enabled: "yes" },
    { action: "upload", path: "/tmp" },
    { action: "read", id: "synthetic", offset: -1 },
    { action: "read", id: "synthetic", view: "headers" },
    { action: "list", threadId: "synthetic", query: "x".repeat(1001) },
    null,
  ]) {
    assert.throws(() => validateModelRequestDebugCommand(input));
    assert.equal(
      isHostCommand({
        type: "model-debug/request",
        requestId: "synthetic",
        input,
      }),
      false,
    );
  }
  assert.equal(
    isHostEvent({
      type: "model-debug/result",
      requestId: "synthetic",
      error: "expired",
    }),
    true,
  );
});
