import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const [repoArg, rootArg] = process.argv.slice(2);
if (!repoArg || !rootArg)
  throw Error(
    "Usage: node --import tsx seed-agent-information.mts repository NEW-qa-root",
  );
const repository = await fs.realpath(repoArg);
await fs.mkdir(path.resolve(rootArg)); // Refuse existing roots, profiles and active apps.
const qaRoot = await fs.realpath(rootArg);
const load = (p: string) =>
  import(pathToFileURL(path.join(repository, p)).href);
const { createHostedAppServer } = await load("apps/cli/src/host.ts");
const { ToolEnvironment } = await load("src/tool.ts");
const { ZenXCapabilityService } = await load(
  "apps/zenx/src/main/capability-service.ts",
);
const { ZenXSubagentsCapabilityPackage } = await load(
  "apps/zenx/src/main/capabilities/subagents-package.ts",
);
const { ZenXSelfControlCapabilityPackage } = await load(
  "apps/zenx/src/main/capabilities/self-control-package.ts",
);
const { ZenXHostToolBundle } = await load(
  "apps/zenx/src/main/capability-tool-executor.ts",
);
const { ZenXProjectProjection } = await load(
  "apps/zenx/src/main/project-projection.ts",
);
const { createDelegatingFirstPartyProfileLoader } = await load(
  "apps/zenx/src/main/first-party-profile-loader.ts",
);
const { serveCodexWebSocket } = await load("src/protocol/codex/websocket.ts");
const { ZenXProtocolClient } = await load(
  "apps/zenx/src/protocol-client/index.ts",
);
const { validateHostProfile, hostConfigFromProfile } = await load(
  "apps/zenx/src/main/host-profile.ts",
);
const project = path.join(qaRoot, "project"),
  data = path.join(qaRoot, "data"),
  profileDirectory = path.join(qaRoot, "profile");
await fs.mkdir(project);
await fs.mkdir(profileDirectory);
await fs.writeFile(
  path.join(project, "README.md"),
  "# Native Agent Information QA\n\nSynthetic text and local FakeModel only. Real installed bundled Subagents plugin, native child threads, canonical tool calls and native messages. No remote model, credentials or external tool effects.\n",
);
const model = {
  id: "fake",
  contextWindow: 131072,
  inputModalities: ["text"],
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  isDefault: true,
};
const hostOptions = (toolEnvironment) => ({
  cwd: project,
  dataDirectory: data,
  approvalPolicy: "always",
  toolPresentation: "direct",
  toolEnvironment,
  providers: [
    {
      providerProfileId: "mock",
      provider: { type: "fake" },
      model: "fake",
      modelCatalog: [model],
    },
  ],
  defaultSelection: { providerProfileId: "mock", modelId: "fake" },
});
let environment = new ToolEnvironment({ runtimes: [] });
let host = createHostedAppServer(hostOptions(environment));
let transport, client, capabilities, bundle, generation;
const calls: any[] = [],
  sourceReceipts: any[] = [],
  assertions: Record<string, unknown> = {};
const names = {
  parent: "Agent Information · native plugin QA",
  child: "QA reviewer · native child",
  fork: "Archived reviewer · native fork",
};
const writeJson = (file: string, value: unknown) =>
  fs.writeFile(path.join(qaRoot, file), JSON.stringify(value, null, 2) + "\n");
const pause = () => new Promise((r) => setTimeout(r, 10));
const until = async (predicate: () => Promise<boolean>, label: string) => {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return;
    await pause();
  }
  throw Error(`Timed out: ${label}`);
};
const readSettled = async (id: string) => {
  await until(
    async () =>
      (await host.readThread(id)).turns.every((t) =>
        ["completed", "interrupted", "failed"].includes(t.status),
      ),
    "terminal thread " + id,
  );
  return host.readThread(id);
};
const turn = async (id: string, text: string) => {
  await (
    await host.startTurn(id, text, { requestApproval: async () => "accept" })
  ).done;
};
const port = {
  projectProjection: new ZenXProjectProjection(),
  request: async (method: string, params: unknown) => {
    calls.push({ method, params });
    return await client.request(method, params);
  },
};
const makeCapabilities = () => {
  const threads = new ZenXSelfControlCapabilityPackage({ appServer: port });
  const service = new ZenXSubagentsCapabilityPackage({
    appServer: port,
    threads,
    listSummaries: async () => [
      ...(await host.listThreadSummaries()),
      ...(await host.listThreadSummaries({ archived: true })),
    ],
  });
  return new ZenXCapabilityService({
    userDataDirectory: profileDirectory,
    bundledProvidersOnly: true,
    resourcesDirectory: path.join(repository, "apps/zenx/resources"),
    pnpmCliPath: path.join(repository, "node_modules/pnpm/bin/pnpm.cjs"),
    pnpmEnvironment: {
      ...process.env,
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      npm_config_cache: path.join(qaRoot, "npm-cache"),
    },
    trustedProfileLoaders: {
      "zenx-subagents": createDelegatingFirstPartyProfileLoader(() => service),
    },
  });
};
const connect = async () => {
  transport = await serveCodexWebSocket({
    appServer: host,
    zenHome: data,
    listen: "ws://127.0.0.1:0",
  });
  client = await ZenXProtocolClient.connect({
    url: transport.url,
    clientInfo: { name: "isolated-native-agent-information-qa", version: "1" },
    reconnect: { maxAttempts: 1, minDelayMs: 10, maxDelayMs: 10 },
  });
};
try {
  await connect();
  capabilities = makeCapabilities();
  await capabilities.initialize();
  const tarball = path.join(
    repository,
    "apps/zenx/resources/plugins/zenx-subagents-plugin-1.0.0.tgz",
  );
  await capabilities.installBundledPluginPackage(tarball, {
    pluginId: "zenx-subagents",
    packageName: "@zenx/subagents-plugin",
  });
  assert(
    capabilities
      .pluginSnapshot()
      .plugins.some(
        (p) => p.id === "zenx-subagents" && p.enabled && p.available,
      ),
  );
  assert(
    capabilities
      .pluginSnapshot()
      .panels.some(
        (p) =>
          p.pluginId === "zenx-subagents" && p.surfaceId === "subagents-panel",
      ),
  );
  generation = capabilities.captureHostSnapshot();
  assert(
    generation.definitions.every((d) => d.name.startsWith("zenx_subagents_")),
  );
  bundle = new ZenXHostToolBundle({
    capabilities: generation,
    send: (event) => {
      if (event.type !== "capability/invoke") return;
      sourceReceipts.push({
        type: event.type,
        invocationId: event.invocationId,
        invocation: event.invocation,
      });
      void capabilities
        .execute(
          { ...event.invocation, signal: new AbortController().signal },
          event.generationToken,
        )
        .then(
          (result) => {
            sourceReceipts.push({
              type: "capability/result",
              invocationId: event.invocationId,
              ...result,
            });
            bundle.handleResult({
              type: "capability/result",
              invocationId: event.invocationId,
              generationToken: event.generationToken,
              ...result,
            });
          },
          (error) =>
            bundle.handleResult({
              type: "capability/result",
              invocationId: event.invocationId,
              generationToken: event.generationToken,
              error: String(error),
            }),
        );
    },
  });
  environment.registerBundle(bundle);
  const parent = await host.startThread({
    cwd: project,
    sandbox: "read-only",
    approvalPolicy: "always",
  });
  await host.setThreadName(parent.id, names.parent);
  await turn(
    parent.id,
    "This is a synthetic local QA coordinator. Child creation and communication below run through the installed production Subagents plugin with a deterministic local FakeModel. No real autonomous research is claimed.",
  );
  await turn(
    parent.id,
    "!tool zenx_subagents_create " +
      JSON.stringify({ mode: "fresh", title: names.child }),
  );
  let children = (
    await capabilities.executePluginCommand("zenx-subagents", "list", {
      parentThreadId: parent.id,
    })
  ).threads;
  assert.equal(children.length, 1);
  const child = children[0];
  assert.equal(child.name, names.child);
  assert.equal(child.parentThreadId, parent.id);
  await turn(
    child.threadId,
    "!tool zenx_subagents_send " +
      JSON.stringify({
        target: names.parent,
        text: "Synthetic reviewer report: the real plugin created this child and delivered this message. Inspect Information, toggle Show in sidebar, open the child, and follow this source link.",
        messageType: "follow_up",
      }),
  );
  await readSettled(parent.id);
  await turn(
    parent.id,
    "!tool zenx_subagents_create " +
      JSON.stringify({ mode: "fork", title: names.fork }),
  );
  children = (
    await capabilities.executePluginCommand("zenx-subagents", "list", {
      parentThreadId: parent.id,
    })
  ).threads;
  assert.equal(children.length, 2);
  const fork = children.find((c) => c.name === names.fork);
  assert(fork);
  await host.setThreadArchived(fork.threadId, true);
  const parentSnapshot = await readSettled(parent.id),
    childSnapshot = await readSettled(child.threadId),
    forkSnapshot = await readSettled(fork.threadId);
  const createCalls = parentSnapshot.items.filter(
    (i) => i.type === "tool_call" && i.name === "zenx_subagents_create",
  );
  assert.equal(createCalls.length, 2);
  const sendCall = childSnapshot.items.find(
    (i) => i.type === "tool_call" && i.name === "zenx_subagents_send",
  );
  assert(sendCall);
  const inbound = parentSnapshot.items.find(
    (i) => i.type === "thread_message" && i.sender.threadId === child.threadId,
  );
  assert(inbound);
  assert.equal(inbound.sender.toolCallId, sendCall.id);
  assert.equal(inbound.sender.callId, sendCall.callId);
  const sourceRead = await client.request("zen/thread/read", {
    threadId: inbound.sender.threadId,
  });
  assert(
    sourceRead.thread.items.some(
      (i) => i.id === inbound.sender.toolCallId && i.type === "tool_call",
    ),
  );
  assert(forkSnapshot.items.some((i) => i.type === "user_message"));
  assertions.realPluginInstalled = true;
  assertions.productionModelFacade = true;
  assertions.nativeLoopbackRpc = true;
  assertions.canonicalCreateCalls = 2;
  assertions.canonicalSendCall = true;
  assertions.exactSourceToolCallResolved = true;
  const profile = validateHostProfile({
    version: 3,
    revision: 0,
    onboardingComplete: true,
    computerForegroundControlEnabled: false,
    browserMode: "isolated",
    providerProfiles: [
      {
        providerProfileId: "mock",
        type: "fake",
        displayName: "Local FakeModel · Agent QA",
        models: [
          {
            ...model,
            isDefault: undefined,
            displayName: "Local deterministic QA",
            description: "Synthetic local FakeModel. No remote provider.",
            source: "manual",
            hidden: false,
          },
        ],
      },
    ],
    defaultModel: { providerProfileId: "mock", modelId: "fake" },
    titleModel: { providerProfileId: "mock", modelId: "fake" },
    workspace: project,
    workspaces: [project],
    projectNames: { [project]: "Agent Information QA" },
    lastUsedWorkspace: project,
    approvalPolicy: "always",
    toolPresentation: "direct",
    experimentalRtkEnabled: false,
    pinnedThreadIds: [parent.id],
    visibleSubagentThreadIds: [],
    sidebarOrder: {
      projectKeys: [project],
      threadIdsByProject: {
        [project]: [parent.id, child.threadId, fork.threadId],
      },
    },
  });
  const config = hostConfigFromProfile(profile, {
    dataDirectory: data,
    subscriptionProfilePath: path.join(qaRoot, "unused-subscription-profile"),
    fallbackWorkspace: project,
  });
  assert(config.providers.every((p) => p.provider.type === "fake"));
  assertions.validatedFakeOnlyHostProfile = true;
  await fs.writeFile(
    path.join(profileDirectory, "host-profile.json"),
    JSON.stringify(profile, null, 2) + "\n",
    { mode: 0o600 },
  );
  await writeJson("native-port-calls.json", calls);
  await writeJson("capability-receipts.json", sourceReceipts);
  await writeJson("plugin-snapshot.json", capabilities.pluginSnapshot());
  await writeJson("thread-snapshots.json", {
    parent: parentSnapshot,
    child: childSnapshot,
    fork: forkSnapshot,
  });
  const threads = {
    parent: { threadId: parent.id, name: names.parent },
    child: { threadId: child.threadId, name: names.child },
    fork: { threadId: fork.threadId, name: names.fork, archived: true },
  };
  const source = {
    messageId: inbound.id,
    threadId: parent.id,
    senderThreadId: inbound.sender.threadId,
    sourceToolCallId: inbound.sender.toolCallId,
    sourceCallId: inbound.sender.callId,
  };
  // Verify persistence through fresh production host and plugin generation loading.
  bundle.close();
  capabilities.releaseHostGeneration(generation.generationToken);
  generation = undefined;
  bundle = undefined;
  await capabilities.close();
  capabilities = undefined;
  client.close();
  await transport.close();
  client = transport = undefined;
  await host.closeHostResources();
  environment = new ToolEnvironment({ runtimes: [] });
  host = createHostedAppServer(hostOptions(environment));
  await connect();
  capabilities = makeCapabilities();
  await capabilities.initialize();
  const restored = (
    await capabilities.executePluginCommand("zenx-subagents", "list", {
      parentThreadId: parent.id,
    })
  ).threads;
  assert.equal(restored.length, 2);
  assert(restored.some((c) => c.threadId === fork.threadId && c.archived));
  assert(
    (await host.readThread(parent.id)).items.some((i) => i.id === inbound.id),
  );
  assertions.reopenedNativeAndInstalledPlugin = true;
  await writeJson("restored-plugin-query.json", restored);
  const manifest = {
    kind: "zenx-native-agent-information-qa-v1",
    synthetic: true,
    repository,
    qaRoot,
    createdAt: new Date().toISOString(),
    repositoryCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    sourceWorktreeDirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: repository,
        encoding: "utf8",
      }).trim().length > 0,
    productionFilesEdited: false,
    provider: "unmodified production FakeModel",
    runtimePath:
      "AgentRuntime -> ZenXHostToolBundle/model facade -> real installed ZenXCapabilityService -> bundled ZenXSubagentsCapabilityPackage -> loopback ZenXProtocolClient -> native Core",
    threads,
    source,
    assertions,
    pluginTarball: {
      path: tarball,
      sha256: createHash("sha256")
        .update(await fs.readFile(tarball))
        .digest("hex"),
    },
    limitations: [
      "Synthetic command/text inputs and deterministic FakeModel, not live autonomous research",
      "No Electron launch, native screenshot or CUA was performed by this seed",
      "In-process forwarding uses production HostToolBundle messages; the Electron IPC bridge itself is not exercised by seeding",
      "Only the real Subagents plugin was installed during seeding; native startup may install other bundled plugins in this isolated root",
      "Source and navigation visual behavior must still be verified in the normal native renderer",
    ],
  };
  await writeJson("seed-result.json", manifest);
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  bundle?.close();
  if (generation)
    capabilities?.releaseHostGeneration(generation.generationToken);
  await capabilities?.close();
  client?.close();
  await transport?.close();
  await host.closeHostResources();
}
