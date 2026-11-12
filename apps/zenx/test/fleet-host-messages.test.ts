import assert from "node:assert/strict";
import test from "node:test";
import { isHostCommand, isHostEvent } from "../src/main/host-messages.js";
test("Fleet IPC admits status responses and Room bridge requests while rejecting malformed routing", () => {
  assert.equal(
    isHostCommand({ type: "fleet/control", requestId: "r", action: "status" }),
    true,
  );
  assert.equal(
    isHostEvent({
      type: "fleet/result",
      requestId: "r",
      result: { enabled: false, clients: [] },
    }),
    true,
  );
  assert.equal(
    isHostEvent({ type: "fleet/result", requestId: "r", error: "offline" }),
    true,
  );
  assert.equal(isHostEvent({ type: "fleet/result", requestId: 7 }), false);
  const event = {
    type: "fleet/room-request",
    requestId: "r",
    operation: "list",
    params: { workspaceId: "w", workspaceCwd: "/test", deviceId: "d" },
  };
  assert.equal(isHostEvent(event), true);
  assert.equal(isHostEvent({ ...event, operation: "delete" }), false);
  assert.equal(isHostEvent({ ...event, params: { workspaceId: "w" } }), false);
  assert.equal(
    isHostEvent({ ...event, params: { ...event.params, text: {} } }),
    false,
  );
});
