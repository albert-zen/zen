import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import {
  cockpitGroup,
  cockpitSend,
  cockpitInterrupt,
  readCockpitComponent,
} from "../src/renderer/src/cockpit-model.js";
import type { ThreadSnapshot } from "../../../src/app-server.js";
import type { ToolResultItem } from "../../../src/item.js";

test("unavailable summaries stay unknown; idle never claims completion", () => {
  assert.equal(
    cockpitGroup({ status: "systemError", threadId: "t" }, new Set()),
    "Unknown",
  );
  assert.equal(
    cockpitGroup({ status: "idle", threadId: "t" }, new Set()),
    "Idle",
  );
  assert.equal(
    cockpitGroup({ status: "active", threadId: "t" }, new Set(["t"])),
    "Needs attention",
  );
});

test("explicit sends preserve configuration and active Turn fence; interrupt never targets another Turn", async () => {
  const calls: unknown[] = [];
  const request = async (method: string, params: unknown) => {
    calls.push({ method, params });
    return {};
  };
  const idle = {
    id: "t",
    turns: [],
    archived: false,
  } as unknown as ThreadSnapshot;
  await cockpitSend(request, idle, "Inspect the regression", "message-1");
  const active = {
    ...idle,
    turns: [{ id: "turn-1", status: "inProgress" }],
  } as ThreadSnapshot;
  await cockpitSend(request, active, "Focus the parser", "message-2");
  await cockpitInterrupt(request, active);
  assert.deepEqual(calls, [
    {
      method: "turn/start",
      params: {
        threadId: "t",
        input: [{ type: "text", text: "Inspect the regression" }],
        clientUserMessageId: "message-1",
      },
    },
    {
      method: "turn/steer",
      params: {
        threadId: "t",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Focus the parser" }],
        clientUserMessageId: "message-2",
      },
    },
    { method: "turn/interrupt", params: { threadId: "t", turnId: "turn-1" } },
  ]);
  await assert.rejects(cockpitSend(request, idle, "  ", "empty"), /message/i);
  await assert.rejects(cockpitInterrupt(request, idle), /active/i);
});

test("component admission requires successful producing call and preceding same-thread sources", () => {
  const source = {
    id: "source",
    type: "agent_message",
    threadId: "t",
    turnId: "turn",
    createdAt: "2026-09-21",
    text: "Verified output",
  };
  const call = {
    id: "call-item",
    type: "tool_call",
    threadId: "t",
    turnId: "turn",
    createdAt: "2026-09-21",
    callId: "call",
    name: "cockpit_component_publish",
    arguments: {},
  };
  const result = {
    id: "result",
    type: "tool_result",
    threadId: "t",
    turnId: "turn",
    createdAt: "2026-09-21",
    callId: "call",
    exitCode: 0,
    output: "Published",
    contentType: "cockpit-component/card",
    structuredContent: {
      version: 1,
      title: "Review",
      html: "<h2>Review</h2>",
      sourceItemIds: ["source"],
    },
  } as ToolResultItem;
  const snapshot = {
    id: "t",
    items: [source, call, result],
  } as unknown as ThreadSnapshot;
  assert.equal(readCockpitComponent(snapshot, result).title, "Review");
  assert.throws(
    () =>
      readCockpitComponent(
        {
          ...snapshot,
          items: [call, result, source] as ThreadSnapshot["items"],
        },
        result,
      ),
    /source/i,
  );
  assert.throws(
    () => readCockpitComponent(snapshot, { ...result, exitCode: 1 }),
    /successful/i,
  );
  assert.throws(
    () =>
      readCockpitComponent(
        { ...snapshot, items: [source, result] as ThreadSnapshot["items"] },
        result,
      ),
    /call/i,
  );
});

test("integration fixture retains the exact production parent CSP", async () => {
  const production = await readFile(
    new URL("../src/renderer/index.html", import.meta.url),
    "utf8",
  );
  const fixture = await readFile(
    new URL("./fixtures/cockpit.html", import.meta.url),
    "utf8",
  );
  const csp = (html: string) =>
    html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  assert.ok(csp(production));
  assert.equal(csp(fixture), csp(production));
  assert.doesNotMatch(fixture, /<base/);
});
