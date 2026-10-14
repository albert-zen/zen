import assert from "node:assert/strict";
import test from "node:test";
import { createCockpitHost } from "./fixtures/cockpit-host.js";
import {
  cockpitSend,
  cockpitInterrupt,
  readCockpitComponent,
} from "../src/renderer/src/cockpit-model.js";

test("real Runtime and process plugin publish canonical HTML; reads are passive and Host actions preserve settings", async () => {
  const host = await createCockpitHost();
  try {
    const before = (
      await host.client.request("zen/thread/read", { threadId: host.threadId })
    ).thread;
    const result = before.items.findLast(
      (item) =>
        item.type === "tool_result" &&
        item.contentType === "cockpit-component/card",
    );
    assert.ok(result?.type === "tool_result");
    assert.equal(result.executionStatus, "completed");
    const component = readCockpitComponent(before, result);
    assert.match(component.html, /sdk.handles.read/);
    assert.equal(component.sources[0]?.type, "agent_message");
    const again = (
      await host.client.request("zen/thread/read", { threadId: host.threadId })
    ).thread;
    assert.deepEqual(again.items, before.items);
    await cockpitSend(
      host.client.request.bind(host.client),
      again,
      "keep running",
      "cockpit-host-send",
    );
    const running = (
      await host.client.request("zen/thread/read", { threadId: host.threadId })
    ).thread;
    assert.equal(
      running.turns.filter((turn) => turn.status === "inProgress").length,
      1,
    );
    await cockpitSend(
      host.client.request.bind(host.client),
      running,
      "Focus on keyboard behavior",
      "cockpit-host-guide",
    );
    await cockpitInterrupt(host.client.request.bind(host.client), running);
    const after = (
      await host.client.request("zen/thread/read", { threadId: host.threadId })
    ).thread;
    assert.equal(after.turns.length, before.turns.length + 1);
    assert.equal(after.turns.at(-1)?.status, "interrupted");
    for (const key of [
      "providerProfileId",
      "modelId",
      "reasoningEffort",
      "sandbox",
      "approvalPolicy",
    ] as const)
      assert.equal(after[key], before[key]);
    assert.equal(
      after.items.filter(
        (item) =>
          item.type === "user_message" && item.clientId === "cockpit-host-send",
      ).length,
      1,
    );
    await assert.rejects(
      cockpitSend(
        host.client.request.bind(host.client),
        running,
        "stale guidance",
        "stale",
      ),
    );
  } finally {
    await host.close();
  }
});
