import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { JsonlThreadJournal } from "../../../src/journal.js";
import { isHostCommand } from "../src/main/host-messages.js";
import { ipcChannels } from "../src/preload/ipc.js";
import type { HostProviderProfile } from "../../../apps/cli/src/host.js";

test("private main to Host auxiliary IPC commits draft probe/title inputs, exposes read-only history, and cancels without a public run endpoint", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-canonical-operation-ipc-"),
  );
  const journal = new JsonlThreadJournal(
    path.join(directory, "data", "threads"),
  );
  let calls = 0;
  let block = false;
  let entered!: () => void;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on(
      "end",
      () =>
        void (async () => {
          calls++;
          const parsed = JSON.parse(body);
          const items = (
            await Promise.all(
              (await journal.listThreadIds()).map((id) => journal.read(id)),
            )
          ).flat();
          const messages = parsed.messages as {
            content: string | { text?: string }[];
          }[];
          for (const message of messages)
            for (const text of typeof message.content === "string"
              ? [message.content]
              : message.content.flatMap((p) => (p.text ? [p.text] : [])))
              assert(
                items.some(
                  (item) =>
                    item.type === "context_message" &&
                    item.content.some(
                      (part) => part.type === "text" && part.text === text,
                    ),
                ),
              );
          if (block) {
            entered();
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            'data: {"choices":[{"delta":{"content":"Synthetic title"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
        })().catch((error) => {
          response.writeHead(500);
          response.end(String(error));
        }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const profile: HostProviderProfile = {
    providerProfileId: "draft-unapplied",
    model: "draft",
    provider: {
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "private-ipc-probe-secret",
    },
    modelCatalog: [
      {
        id: "draft",
        isDefault: true,
        contextWindow: null,
        supportedReasoningEfforts: null,
        defaultReasoningEffort: null,
      },
    ],
  };
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "token"),
    hostConfig: {
      cwd: "/tmp",
      dataDirectory: path.join(directory, "data"),
      provider: { type: "fake" },
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10000,
  });
  try {
    await manager.start();
    const input = {
      kind: "image-capability-probe" as const,
      selection: { providerProfileId: "draft-unapplied", modelId: "draft" },
    };
    const result = await manager.runModelOperation({ input, profile });
    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
    assert.equal((await manager.listThreadSummaries()).length, 0);
    const listed = await manager.modelOperationHistory();
    assert("summaries" in listed);
    assert.equal(listed.summaries.length, 1);
    const history = await manager.modelOperationHistory(result.threadId);
    assert("items" in history);
    assert(
      history.items.some((item) => item.type === "model_operation_completed"),
    );
    assert.doesNotMatch(
      JSON.stringify(history),
      /private-ipc-probe-secret|127\.0\.0\.1/,
    );
    assert.equal(
      Object.values(ipcChannels).some((channel) =>
        channel.includes("model-operation/run"),
      ),
      false,
    );
    for (const request of [
      { input, profile, execution: {} },
      { input: { ...input, adapter: {} }, profile },
      { input, profile: { ...profile, execution: {} } },
      {
        input: {
          ...input,
          selection: { ...input.selection, reasoningEffort: "high" },
        },
        profile,
      },
    ])
      assert.equal(
        isHostCommand({
          type: "model-operation/run",
          requestId: "invalid",
          request,
        }),
        false,
      );
    assert.equal(
      isHostCommand({
        type: "model-operation/run",
        requestId: "x",
        request: {
          input,
          profile: { ...profile, adapter: { stream: "spoof" } },
        },
      }),
      false,
    );
    await assert.rejects(
      manager.request("zen/model-operation/run" as never, {} as never),
    );
    assert.equal(calls, 1);
    const { thread } = await manager.request("thread/start", {});
    await manager.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "canonical title source" }],
    });
    let source: string | undefined;
    for (let i = 0; i < 50 && !source; i++) {
      const snapshot = await manager.modelOperationHistory(thread.id);
      assert("items" in snapshot);
      source = snapshot.items.find((item) => item.type === "user_message")?.id;
      if (!source) await new Promise((r) => setTimeout(r, 10));
    }
    assert(source);
    const title = await manager.runModelOperation({
      input: {
        kind: "title",
        threadId: thread.id,
        sourceItemId: source,
        selection: input.selection,
        titleTemplate: "Name: {{request}}",
      },
      profile: {
        ...profile,
        modelCatalog: [
          {
            id: "draft",
            isDefault: true,
            contextWindow: 32768,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
          },
        ],
      },
    });
    assert.equal(title.status, "completed");
    assert.equal(calls, 2);
    block = true;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const controller = new AbortController();
    const pending = manager.runModelOperation(
      { input, profile },
      controller.signal,
    );
    await reached;
    controller.abort(new Error("cancel synthetic probe"));
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled");
    const cancelledHistory = await manager.modelOperationHistory(
      cancelled.threadId,
    );
    assert("items" in cancelledHistory);
    assert.equal(
      cancelledHistory.items.filter(
        (item) => item.type === "model_operation_completed",
      ).length,
      1,
    );
    const reachedShutdown = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const shutdownPending = manager.runModelOperation({ input, profile }).then(
      (value) => value,
      () => undefined,
    );
    await reachedShutdown;
    await manager.stop();
    await shutdownPending;
    const all = (
      await Promise.all(
        (await journal.listThreadIds()).map((id) => journal.read(id)),
      )
    ).flat();
    const admissions = all.filter((item) => item.type === "model_operation");
    for (const operation of admissions)
      assert.equal(
        all.filter(
          (item) =>
            item.type === "model_operation_completed" &&
            item.operationItemId === operation.id,
        ).length,
        1,
        "shutdown must settle the admitted operation before exiting",
      );
    assert.equal(
      all.filter(
        (item) =>
          item.type === "model_operation_completed" &&
          item.status === "cancelled",
      ).length,
      2,
    );
  } finally {
    await manager.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
