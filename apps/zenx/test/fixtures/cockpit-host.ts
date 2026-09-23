import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZenAppServer } from "../../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../../src/journal.js";
import { StaticModelCatalog } from "../../../../src/model-catalog.js";
import {
  type ModelAdapter,
  type ModelRequest,
  type ModelEvent,
} from "../../../../src/model.js";
import { ProviderRegistry } from "../../../../src/provider-registry.js";
import { AgentRuntime } from "../../../../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../../../../src/thread-metadata.js";
import { ToolEnvironment } from "../../../../src/tool.js";
import { serveCodexWebSocket } from "../../../../src/protocol/codex/websocket.js";
import {
  PluginRuntimeSupervisor,
  ProcessPluginRuntime,
} from "../../src/main/plugin-runtime.js";
import { ZenXProtocolClient } from "../../src/protocol-client/index.js";

// A deterministic author for reproducible integration, not online LLM evidence.
class FixtureAuthor implements ModelAdapter {
  readonly provider = "cockpit-fixture";
  completeWaitingTurn?: () => void;
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const user = request.messages.findLastIndex(
      (message) => message.role === "user",
    );
    const last = request.messages[user];
    const text =
      last && "text" in last
        ? (last.text ?? "")
        : last && "content" in last
          ? last.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
          : "";
    const sources = /source=([\w-]+)/u.exec(text);
    if (
      sources &&
      !request.messages
        .slice(user + 1)
        .some((message) => message.role === "tool")
    ) {
      yield {
        type: "tool_call",
        callId: crypto.randomUUID(),
        name: "cockpit_component_publish",
        arguments: {
          title: "Release evidence · source review",
          sourceItemIds: [sources[1]],
          html: `<style>body{background:#172934;color:#edf3f4;font:15px/1.6 system-ui}button{padding:10px;background:#284653;color:#edf3f4;border:1px solid #91d5e3;border-radius:6px}pre{white-space:pre-wrap}small{color:#a9bec8}</style><h2>Review before release</h2><p>Inspect the source behind this interpretation.</p><button id="read">Expand source excerpt</button><pre id="evidence" hidden></pre><button id="denied">Check read-only boundary</button><p id="boundary"></p><script>addEventListener('zenx-plugin-ui:init',({detail:{sdk}})=>{document.getElementById('read').onclick=async()=>{const item=await sdk.handles.read(sdk.context.sourceItemIds[0]);const view=document.getElementById('evidence');view.hidden=false;view.textContent=item.text||JSON.stringify(item)};document.getElementById('denied').onclick=async()=>{try{await sdk.commands.execute('turn/start')}catch(error){document.getElementById('boundary').textContent=error.message}}})</script>`,
        },
      };
    } else {
      if (text.includes("keep running"))
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 120_000);
          this.completeWaitingTurn = () => {
            clearTimeout(timer);
            resolve();
          };
          request.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(request.signal.reason);
            },
            { once: true },
          );
        });
      yield {
        type: "text_delta",
        delta: sources
          ? "Published the component with canonical source lineage. Review its interpretation before acting."
          : `Evidence recorded: ${text}`,
      };
    }
  }
}

export async function createCockpitHost() {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const pluginDirectory = path.join(root, "examples/cockpit-component");
  const manifest = JSON.parse(
    await readFile(path.join(pluginDirectory, "zenx.plugin.json"), "utf8"),
  );
  const environment = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(environment);
  const identity = { pluginId: "cockpit-component", packageVersion: "0.1.0" };
  await supervisor.start({
    identity,
    source: "local",
    definitions: manifest.tools,
    start: async () =>
      ProcessPluginRuntime.start(identity, {
        command: process.execPath,
        args: [path.join(pluginDirectory, "runtime.mjs")],
        cwd: pluginDirectory,
      }),
  });
  const model = new FixtureAuthor();
  const appServer = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({ toolEnvironment: environment }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "fixture-author", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: root,
      providerProfileId: model.provider,
      modelId: "fixture-author",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const socket = await serveCodexWebSocket({
    appServer,
    zenHome: root,
    listen: "ws://127.0.0.1:0",
  });
  const client = await ZenXProtocolClient.connect({
    url: socket.url,
    clientInfo: {
      name: "cockpit-fixture",
      title: "Cockpit integration fixture",
      version: "0.1.0",
    },
  });
  const thread = await appServer.startThread({ cwd: root });
  await client.request("thread/name/set", {
    threadId: thread.id,
    name: "Verify the release evidence",
  });
  await (
    await appServer.startTurn(
      thread.id,
      "Release checks passed; keyboard and narrow-screen inspection remain.",
    )
  ).done;
  const evidence = (await appServer.readThread(thread.id)).items.findLast(
    (item) => item.type === "agent_message",
  )!;
  await (
    await appServer.startTurn(
      thread.id,
      `Author an interactive evidence component, source=${evidence.id}`,
    )
  ).done;
  for (const [cwd, name] of [
    [
      path.join(root, "packages/zenx-plugin-sdk"),
      "Review the plugin SDK contract",
    ],
    [path.join(root, "apps/zenx"), "Prepare desktop release notes"],
  ]) {
    const other = await appServer.startThread({ cwd });
    await client.request("thread/name/set", {
      threadId: other.id,
      name: name!,
    });
  }
  return {
    appServer,
    completeWaitingTurn: () => model.completeWaitingTurn?.(),
    client,
    threadId: thread.id,
    async close() {
      await client.close();
      await socket.close();
      await supervisor.close();
    },
  };
}
