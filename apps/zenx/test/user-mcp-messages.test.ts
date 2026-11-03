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

test("MCP IPC tags and decisions are literal strings, never coerced JSON values", () => {
  for (const decision of ["accept", "acceptForSession", "decline", "cancel"])
    assert.equal(
      isUserMcpHostCommand({
        type: "user-mcp/result",
        requestId: "request",
        decision,
      }),
      true,
    );
  for (const decision of [["accept"], { toString: () => "accept" }, true, 1])
    assert.equal(
      isUserMcpHostCommand({
        type: "user-mcp/result",
        requestId: "request",
        decision,
      }),
      false,
    );
  for (const type of [
    ["user-mcp/check-owner"],
    { toString: () => "user-mcp/cancel" },
  ])
    assert.equal(
      isUserMcpHostEvent({
        type,
        connectionId: "binding",
        requestId: "request",
      }),
      false,
    );
});

test("MCP approval projection validates optional scope and trusted target shape", () => {
  const request = {
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    callId: "call",
    command: "zenx_board_put",
    cwd: "/private-test",
    toolName: "zenx_board_put",
    toolArguments: {},
  };
  const event = (patch: Record<string, unknown>) => ({
    type: "user-mcp/approval",
    connectionId: "binding",
    requestId: "request",
    request: { ...request, ...patch },
  });
  assert.equal(isUserMcpHostEvent(event({})), true);
  assert.equal(
    isUserMcpHostEvent(
      event({
        scope: "once",
        approvalTarget: { key: "target", label: "Board" },
      }),
    ),
    true,
  );
  for (const scope of [null, "session", ["once"], {}])
    assert.equal(isUserMcpHostEvent(event({ scope })), false);
  for (const approvalTarget of [
    null,
    [],
    {},
    { key: "target" },
    { key: 1, label: "Board" },
    { key: "target", label: ["Board"] },
  ])
    assert.equal(isUserMcpHostEvent(event({ approvalTarget })), false);
});
