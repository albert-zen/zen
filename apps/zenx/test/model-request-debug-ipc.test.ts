import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isHostCommand, isHostEvent } from "../src/main/host-messages.js";
import { validateModelRequestDebugCommand } from "../../cli/src/model-request-debug.js";

test("local debug IPC accepts only bounded known operations, not arbitrary paths or remote targets", () => {
  for (const input of [
    { action: "status" },
    { action: "list", threadId: "synthetic", query: "fixture" },
    {
      action: "read",
      threadId: "synthetic",
      id: "synthetic",
      offset: 0,
      view: "configuration",
    },
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
    { action: "clear" },
    { action: "setEnabled", enabled: true },
    { action: "setEnabled", enabled: "yes" },
    { action: "upload", path: "/tmp" },
    { action: "read", threadId: "synthetic", id: "synthetic", offset: -1 },
    { action: "read", threadId: "synthetic", id: "synthetic", view: "headers" },
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

import { createModelRequestDebugHandler } from "../src/main/model-request-debug-ipc.js";
test("only owned app main frames read durable local and auxiliary evidence", async () => {
  let calls = 0;
  const rendererUrl = pathToFileURL(
    path.resolve("synthetic/RUNNER~1/renderer/index.html"),
  ).href;
  const handler = createModelRequestDebugHandler({
    rendererUrl,
    sender: (event: {
      ownedWindow: boolean;
      mainFrame: boolean;
      url: string;
    }) => event,
    async read() {
      calls++;
      return {
        durability: "healthy",
        completeness: "complete",
        artifactVerification: "on-read",
        issues: [],
        limits: { pageCharacters: 100, pageRecords: 100 },
      };
    },
  });
  const trusted = {
    ownedWindow: true,
    mainFrame: true,
    url: `${rendererUrl.replace("%7E", "~")}#auxiliary`,
  };
  await handler(trusted, { action: "list", threadId: "" });
  assert.equal(calls, 1);
  for (const event of [
    { ...trusted, ownedWindow: false },
    { ...trusted, mainFrame: false },
    { ...trusted, url: "https://evil.example/index.html" },
    { ...trusted, url: `${rendererUrl}?foreign=1` },
    { ...trusted, url: new URL("webview.html", rendererUrl).href },
    { ...trusted, url: "" },
  ])
    await assert.rejects(
      handler(event, { action: "list", threadId: "" }),
      /trusted/u,
    );
  await assert.rejects(
    handler(trusted, { action: "read", threadId: "../other", id: "record" }),
  );
  assert.equal(calls, 1);
});
