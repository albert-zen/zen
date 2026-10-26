import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiResponsesModel } from "../src/model/openai-responses.js";
import { ZenAppServer } from "../src/app-server.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { CanonicalItem } from "../src/item.js";

for (const rejectAppend of [false, true]) {
  test(`public Responses dispatch uses committed semantic text, reject append: ${rejectAppend}`, async () => {
    class Journal extends InMemoryThreadJournal {
      override async append(item: CanonicalItem) {
        if (rejectAppend && item.type === "context_message")
          throw new Error("synthetic context append rejected");
        await super.append(item);
      }
    }
    const journal = new Journal();
    let threadId = "";
    let calls = 0;
    const adapter: OpenAiResponsesModel = new OpenAiResponsesModel({
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic-not-a-secret",
      defaultParams: {
        instructions: "  explicit synthetic system instruction\n",
      },
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        const history = await journal.read(threadId);
        const committed = history.flatMap((item) =>
          item.type === "user_message" || item.type === "context_message"
            ? (item.content ?? []).flatMap((part) =>
                part.type === "text" ? [part.text] : [],
              )
            : [],
        );
        const texts = body.input.flatMap((message: any) =>
          (message.content ?? []).flatMap((part: any) =>
            typeof part.text === "string" ? [part.text] : [],
          ),
        );
        texts.push(body.instructions);
        assert.equal(body.instructions, adapter.contextInstructions);
        assert(texts.some((text: string) => text.includes("received_at=")));
        for (const text of texts)
          assert(
            committed.includes(text),
            `uncommitted semantic text: ${text}`,
          );
        return new Response(
          'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
        );
      },
    });
    const server = new ZenAppServer({
      runtime: new AgentRuntime({
        toolEnvironment: new ToolEnvironment({ bundles: [] }),
      }),
      journal,
      threadMetadata: new InMemoryThreadMetadataStore(),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: adapter.provider,
          adapter,
          modelCatalog: new StaticModelCatalog([
            { id: "synthetic", isDefault: true, contextWindow: 32768 },
          ]),
        },
      ]),
      defaults: {
        cwd: "/tmp",
        providerProfileId: adapter.provider,
        modelId: "synthetic",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
    const thread = await server.startThread();
    threadId = thread.id;
    const turn = await server.startTurn(thread.id, "synthetic user content");
    if (rejectAppend)
      await assert.rejects(turn.done, /synthetic context append rejected/);
    else await turn.done;
    assert.equal(calls, rejectAppend ? 0 : 1);
  });
}
