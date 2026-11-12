import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZenAppServer } from "../src/app-server.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { compileItemList } from "../src/item-list.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { OpenAiResponsesModel } from "../src/model/openai-responses.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";
import { FileTraceStore } from "../src/trace.js";

test("real Responses adapter sends only the exact already-committed compiler tool presentation", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "native-tools-acceptance-"),
  );
  const metadata = new InMemoryThreadMetadataStore();
  const journal = new DomainThreadJournal({
    directory: path.join(directory, "threads"),
    trace: new FileTraceStore(path.join(directory, "trace")),
    metadata,
  });
  const definition = {
    name: "lookup",
    description: "Look up a synthetic record.",
    fullDescription:
      "Look up a synthetic record. Detailed usage stays deferred.",
    pluginId: "fixture",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
  const tools = new ToolEnvironment({
    runtimes: [
      {
        name: definition.name,
        specification: definition,
        async execute() {
          throw new Error("no local tool should execute");
        },
      },
    ],
  });
  t.after(async () => {
    await tools.close();
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  let threadId = "";
  const sent: string[] = [];
  const adapter = new OpenAiResponsesModel({
    baseUrl: "https://api.openai.com/v1/responses",
    apiKey: "synthetic-key",
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "gpt-5.4");
      const itemList = await journal.readItemList(threadId);
      const committed = itemList.findLast((item) => item.kind === "tools");
      assert(committed?.kind === "tools");
      assert.equal(
        committed.content.providerToolPresentation?.protocol,
        "openai-responses",
      );
      assert(committed.content.providerToolPresentation);
      assert.deepEqual(
        body.tools,
        committed.content.providerToolPresentation.tools,
      );
      assert.deepEqual(
        body.tools,
        compileItemList(itemList).providerToolPresentation?.tools,
      );
      assert(
        body.tools.some(
          (tool: { type: string }) => tool.type === "tool_search",
        ),
      );
      sent.push(JSON.stringify(body.tools));
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`,
      );
    },
  });
  const server = new ZenAppServer({
    runtime: new AgentRuntime({ toolEnvironment: tools }),
    journal,
    threadMetadata: metadata,
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: adapter.provider,
        adapter,
        modelCatalog: new StaticModelCatalog([
          { id: "gpt-5.4", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd: directory,
      providerProfileId: adapter.provider,
      modelId: "gpt-5.4",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const thread = await server.startThread();
  threadId = thread.id;
  await (
    await server.startTurn(threadId, "Synthetic first sample")
  ).done;
  await (
    await server.startTurn(threadId, "Synthetic second sample")
  ).done;
  assert.equal(sent.length, 2);
  assert.equal(
    sent[0],
    sent[1],
    "unchanged catalog must preserve the exact provider prefix across turns",
  );
});
