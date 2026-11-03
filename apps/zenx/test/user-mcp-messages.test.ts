import assert from "node:assert/strict";
import test from "node:test";
import {
  isUserMcpHostCommand,
  isUserMcpHostEvent,
} from "../src/main/user-mcp-messages.js";

test("MCP IPC predicates reject throwing object access without escaping into Host dispatch", () => {
  const hostile = new Proxy(
    {},
    {
      get: () => {
        throw new Error("hostile getter");
      },
      has: () => {
        throw new Error("hostile has trap");
      },
    },
  );
  assert.doesNotThrow(() => isUserMcpHostCommand(hostile));
  assert.doesNotThrow(() => isUserMcpHostEvent(hostile));
  assert.equal(isUserMcpHostCommand(hostile), false);
  assert.equal(isUserMcpHostEvent(hostile), false);
  assert.equal(
    isUserMcpHostEvent({
      type: "user-mcp/open",
      connectionId: "binding",
      requestId: "request",
      owner: { kind: "thread", threadId: "thread" },
    }),
    true,
  );
  assert.equal(
    isUserMcpHostCommand({
      type: "user-mcp/result",
      requestId: "request",
      decision: "accept",
    }),
    true,
  );
  assert.equal(
    isUserMcpHostCommand({
      type: "user-mcp/result",
      requestId: "request",
      decision: "invalid",
    }),
    false,
  );
});
