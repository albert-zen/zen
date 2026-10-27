import assert from "node:assert/strict";
import os from "node:os";
import { ZenAppServer } from "../src/app-server.js";
import { textFromUserInput } from "../src/item.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment, ShellToolRuntime } from "../src/tool.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { type ModelAdapter, type ModelEvent } from "../src/model.js";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export function fixture(
  model: ModelAdapter,
  journal = new InMemoryThreadJournal(),
  metadata = new InMemoryThreadMetadataStore(),
) {
  const server = new ZenAppServer({
    journal,
    threadMetadata: metadata,
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        runtimes: [new ShellToolRuntime()],
      }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: {
          provider: model.provider,
          async *stream(request): AsyncIterable<ModelEvent> {
            if (
              request.messages.some(
                (m) =>
                  m.role === "user" &&
                  ("content" in m
                    ? m.content.some(
                        (part) =>
                          part.type === "text" && part.text === "source",
                      )
                    : m.text === "source"),
              )
            ) {
              if (!request.messages.some((m) => m.role === "tool"))
                yield {
                  type: "tool_call",
                  callId: "source-call",
                  name: "shell",
                  arguments: { command: "true" },
                };
              else yield { type: "text_delta", delta: "source-ready" };
            } else yield* model.stream(request);
          },
        },
        modelCatalog: new StaticModelCatalog([
          { id: "fake", isDefault: true, contextWindow: 32_768 },
        ]),
      },
    ]),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  return { server, journal, metadata };
}
export async function sender(f: ReturnType<typeof fixture>, label: string) {
  const source = await f.server.startThread();
  const turn = await f.server.startTurn(source.id, "source");
  await turn.done;
  const item = (await f.server.readThread(source.id)).items.find(
    (item) => item.type === "tool_call",
  )!;
  assert.equal(item.type, "tool_call", label);
  return { threadId: source.id, toolCallId: item.id, callId: item.callId };
}
