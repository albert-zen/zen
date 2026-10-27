import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createHostedAppServer,
  type ZenHostOptions,
} from "../apps/cli/src/host.js";
import { FileTraceStore } from "../src/trace.js";
import { compileItemList, decodeContextItem } from "../src/item-list.js";
import { ToolEnvironment } from "../src/tool.js";
import { testToolRuntime } from "./tool-fixtures.js";

const response = (delta: object) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
test("actual Host logs source facts before semantic compile/dispatch and restarts without replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-host-domains-"));
  const originalFetch = globalThis.fetch;
  let fetchFailure: unknown;
  let calls = 0;
  let effects = 0;
  let threadId = "";
  const actual: Array<Record<string, unknown>> = [];
  const options: ZenHostOptions = {
    cwd: root,
    dataDirectory: root,
    model: "synthetic",
    provider: {
      type: "openai-compatible" as const,
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic-header-only",
    },
    modelCatalog: [
      {
        id: "synthetic",
        isDefault: true,
        contextWindow: 32768,
        inputModalities: ["text"],
        defaultReasoningEffort: "medium",
      },
    ],
    toolPresentation: "direct" as const,
    approvalPolicy: "never" as const,
  };
  globalThis.fetch = async (_url, init) => {
    try {
      calls++;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      actual.push(body);
      const items = (
        await readFile(
          path.join(root, "threads", "items", `${threadId}.jsonl`),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeContextItem(JSON.parse(line)));
      const trace = new FileTraceStore(path.join(root, "trace"));
      const records = (await trace.read(threadId)).records;
      const sample = records.findLast(
        (r) => r.type === "model_sample_started",
      )!;
      const compiled = compileItemList(items, {
        sampleId: sample.sampleId!,
        selection: {
          providerProfileId: "openai-compatible",
          modelId: "synthetic",
        },
        inputModalities: ["text"],
      });
      assert.deepEqual(
        (sample.data as { selectedItemIds: string[] }).selectedItemIds,
        compiled.selectedItemIds,
      );
      const wire = body.messages as Array<{ role: string; content: unknown }>;
      for (const message of compiled.messages)
        if (message.role === "tool")
          assert.equal(
            wire.findLast((entry) => entry.role === "tool")?.content,
            message.text,
            "adapter must encode exactly stored semantic tool text",
          );
      assert.ok(
        records.some(
          (r) =>
            r.type === "runtime_item" &&
            (r.data as { item: { type: string } }).item.type === "user_message",
        ),
      );
      if (calls === 1)
        return response({
          tool_calls: [
            {
              index: 0,
              id: "call_synthetic",
              type: "function",
              function: { name: "write_once", arguments: "{}" },
            },
          ],
        });
      return response({ content: "accepted" });
    } catch (error) {
      fetchFailure = error;
      throw error;
    }
  };
  const environment = new ToolEnvironment({
    runtimes: [
      testToolRuntime({
        name: "write_once",
        execute: async () => {
          effects++;
          return { output: "full output password=literal", exitCode: 0 };
        },
      }),
    ],
  });
  const host = createHostedAppServer({
    ...options,
    toolEnvironment: environment,
  });
  try {
    const thread = await host.startThread();
    threadId = thread.id;
    await (
      await host.startTurn(thread.id, "user password=literal")
    ).done;
    assert.ifError(fetchFailure);
    assert.equal(calls, 2);
    assert.equal(
      effects,
      1,
      JSON.stringify(
        (
          await new FileTraceStore(path.join(root, "trace")).read(thread.id)
        ).records.filter(
          (r) => r.type.includes("finished") || r.type.includes("error"),
        ),
      ),
    );
    const live = await host.readThread(thread.id);
    assert.equal(live.turns.at(-1)?.status, "completed");
    const raw = await readFile(
      path.join(root, "threads", "items", `${thread.id}.jsonl`),
      "utf8",
    );
    assert.equal(raw.includes('"type":"turn_started"'), false);
    assert.equal(raw.includes('"type":"model_usage"'), false);
    const trace = new FileTraceStore(path.join(root, "trace"));
    const records = (await trace.read(thread.id)).records;
    assert.ok(records.some((r) => r.type === "tool_result_accepted"));
    const request = records.find((r) => r.type === "model_request")!;
    const bytes = await trace.readArtifact(
      request.artifacts.find((a) => a.name === "request_body")!.ref,
    );
    assert.ok(
      Buffer.from(bytes).toString("utf8").includes("user password=literal"),
    );
    assert.equal(
      JSON.stringify(request).includes("synthetic-header-only"),
      false,
    );
    await host.closeHostResources();
    const cold = createHostedAppServer(options);
    try {
      assert.deepEqual(
        (await cold.readThread(thread.id)).itemList,
        live.itemList,
      );
      assert.equal(calls, 2);
      assert.equal(effects, 1);
    } finally {
      await cold.closeHostResources();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await host.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});
