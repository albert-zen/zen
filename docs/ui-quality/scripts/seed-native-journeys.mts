import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const repository = process.argv[2];
const qaRoot = process.argv[3];
if (!repository || !qaRoot)
  throw new Error("Usage: seed-native-journeys.mts repository fresh-qa-root");
const load = (p: string) =>
  import(pathToFileURL(path.join(repository, p)).href);
const { ZenAppServer } = await load("src/app-server.ts");
const { JsonlThreadJournal } = await load("src/journal.ts");
const { StaticModelCatalog } = await load("src/model-catalog.ts");
const { FakeModel } = await load("src/model.ts");
const { ProviderRegistry } = await load("src/provider-registry.ts");
const { AgentRuntime } = await load("src/runtime.ts");
const { ToolEnvironment } = await load("src/tool.ts");
const { JsonlThreadMetadataStore } = await load("src/thread-metadata.ts");
const { JsonThreadSummaryProjection } = await load("src/thread-summary.ts");
// Use only a fresh offline QA root; never point at an open app profile.
try {
  await fs.access(qaRoot);
  throw new Error("Refusing existing QA root");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const data = path.join(qaRoot, "data");
const project = path.join(qaRoot, "project");
const notes = path.join(qaRoot, "release-notes");
const marker = path.join(qaRoot, "seed-result.json");
try {
  await fs.access(marker);
  console.log("Already seeded:", marker);
  process.exit(0);
} catch {}
await fs.mkdir(project, { recursive: true });
await fs.mkdir(notes, { recursive: true });
await fs.writeFile(
  path.join(project, "README.md"),
  "# ZenX design QA\n\nLocal deterministic fixture project. No account, credentials, online provider, or paid model.\n\nUse it to test sidebar, search, composer, Markdown, files, settings, and plugins.\n",
);
await fs.writeFile(
  path.join(project, "notes.md"),
  "# Review checklist\n\n- Readable thread titles\n- Clear composer controls\n- Stable navigation\n- Accessible settings\n",
);
await fs.writeFile(
  path.join(notes, "release-notes.md"),
  "# Release planning\n\nThese are synthetic QA notes.\n",
);
const server = new ZenAppServer({
  journal: new JsonlThreadJournal(path.join(data, "threads")),
  runtime: new AgentRuntime({
    toolEnvironment: new ToolEnvironment({
      runtimes: [
        {
          name: "qa_local_receipt",
          specification: {
            name: "qa_local_receipt",
            description:
              "Synthetic local QA receipt; no filesystem, network or subprocess effects.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          async execute() {
            return { output: "Synthetic local receipt ready.", exitCode: 0 };
          },
        },
      ],
    }),
  }),
  providerRegistry: new ProviderRegistry(
    ["mock", "mock-alt"].map((providerProfileId) => ({
      providerProfileId,
      adapter: new FakeModel(),
      modelCatalog: new StaticModelCatalog([
        {
          id: "fake",
          contextWindow: 32768,
          isDefault: true,
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
        },
      ]),
    })),
  ),
  threadMetadata: new JsonlThreadMetadataStore(
    path.join(data, "thread-metadata.jsonl"),
  ),
  threadSummaryProjection: new JsonThreadSummaryProjection(
    path.join(data, "thread-summaries.json"),
  ),
  defaults: {
    cwd: project,
    providerProfileId: "mock",
    modelId: "fake",
    reasoningEffort: null,
    sandbox: "read-only",
    approvalPolicy: "always",
  },
});
const examples = [
  {
    name: "欢迎与快速开始",
    cwd: project,
    text: "你好！这是一个本地界面体验检查。请帮助我查看线程导航、消息编辑器和设置入口。",
  },
  {
    name: "Design review · first impressions",
    cwd: project,
    text: '## Product review\n\nThis local fixture is for checking readability and spacing.\n\n- The sidebar should make project and thread navigation clear\n- The composer should feel easy to use\n- Settings should open and close predictably\n\n**Decision:** keep the next action easy to find.\n\n> All content here is synthetic QA data.\n\n```ts\nconst version = "design-qa";\nconsole.log(version);\n```',
  },
  {
    name: "Long thread title: navigation, truncation, keyboard focus and readable hierarchy",
    cwd: project,
    text: "Check how a long, human-readable thread title behaves in the sidebar and header. This thread deliberately has a long name.",
  },
  {
    name: "File browser and Markdown notes",
    cwd: project,
    text: "There are two local files in this test project: README.md and notes.md. Open the project file browser and inspect the Markdown preview.",
  },
  {
    name: "Release checklist · October",
    cwd: notes,
    text: "## Release checklist\n\n1. Review interface changes\n2. Verify keyboard and narrow-window behavior\n3. Record baseline comparisons\n\nThe provider is deterministic and entirely local.",
  },
];
const created = [];
for (const example of examples) {
  const thread = await server.startThread({ cwd: example.cwd });
  const turn = await server.startTurn(thread.id, example.text);
  await turn.done;
  await server.setThreadName(thread.id, example.name);
  created.push({ threadId: thread.id, name: example.name, cwd: example.cwd });
}
// All histories below come from public production App Server APIs.
const turn = async (id, text) => {
  await (
    await server.startTurn(id, text, { requestApproval: async () => "accept" })
  ).done;
};
const named = async (thread, name) => {
  await server.setThreadName(thread.id, name);
  created.push({ threadId: thread.id, name, cwd: project });
  return thread;
};
const source = await named(
  await server.startThread({ cwd: project }),
  "Fork source · synthetic QA",
);
await turn(
  source.id,
  "## Shared history\n\nThis message belongs to the source and the exact-prefix fork.",
);
const boundary = (await server.readThread(source.id)).items.find(
  (item) => item.type === "agent_message",
);
if (!boundary) throw Error("Missing canonical fork boundary");
await turn(
  source.id,
  "Source-only continuation: this message must not appear in the fork.",
);
const fork = await named(
  await server.forkThread({
    sourceThreadId: source.id,
    through: { type: "item", itemId: boundary.id },
    workspace: { type: "same-directory" },
  }),
  "Fork branch · synthetic QA",
);
await turn(
  fork.id,
  "Branch-only continuation: new history starts below the canonical fork boundary.",
);
const parent = await named(
  await server.startThread({ cwd: project }),
  "Agent communication · synthetic QA",
);
await turn(parent.id, "Review the synthetic interface evidence.");
const child = await named(
  await server.createChildThread({ parentThreadId: parent.id, mode: "fresh" }),
  "QA reviewer · synthetic child",
);
await turn(child.id, "!tool qa_local_receipt {}");
const call = (await server.readThread(child.id)).items.find(
  (item) => item.type === "tool_call",
);
if (!call) throw Error("Missing canonical sender tool call");
await server.sendThreadMessage(parent.id, {
  sender: { threadId: child.id, toolCallId: call.id, callId: call.callId },
  text: "Synthetic reviewer report: source navigation and communication labels are ready for visual review.",
  messageType: "follow_up",
});
// resumeQueue starts the receiver asynchronously; wait for its real terminal facts.
for (let i = 0; i < 500; i++) {
  const snapshot = await server.readThread(parent.id);
  if (
    snapshot.items.some((item) => item.type === "thread_message") &&
    snapshot.turns.every((t) =>
      ["completed", "failed", "interrupted"].includes(t.status),
    )
  )
    break;
  if (i === 499)
    throw Error("Receiver did not settle; inspect before reopening app");
  await new Promise((resolve) => setTimeout(resolve, 20));
}
await server.updateThreadSettings(parent.id, {
  selection: { providerProfileId: "mock-alt", modelId: "fake" },
});
await turn(
  parent.id,
  "After an explicit switch to the second local fake provider profile.",
);
const long = await named(
  await server.startThread({ cwd: project }),
  "Scroll laboratory · synthetic QA",
);
for (let i = 1; i <= 24; i++)
  await turn(
    long.id,
    `## Checkpoint ${String(i).padStart(2, "0")}\n\n` +
      "Synthetic paragraph for readable transcript spacing and stable scroll anchoring. ".repeat(
        5,
      ),
  );
await server.listThreadSummaries({});
await fs.mkdir(path.join(qaRoot, "profile"), { recursive: true });
const profile = {
  version: 3,
  revision: 0,
  onboardingComplete: true,
  computerForegroundControlEnabled: false,
  browserMode: "isolated",
  providerProfiles: [
    {
      providerProfileId: "mock",
      type: "fake",
      displayName: "Mock · local QA",
      models: [
        {
          id: "fake",
          description: "Deterministic local adapter; no online model",
          hidden: false,
          displayName: "Mock · local QA",
          contextWindow: 32768,
          source: "manual",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
        },
      ],
    },
  ],
  defaultModel: { providerProfileId: "mock", modelId: "fake" },
  titleModel: { providerProfileId: "mock", modelId: "fake" },
  workspace: project,
  workspaces: [project, notes],
  projectNames: { [project]: "ZenX Design QA", [notes]: "Release Notes" },
  lastUsedWorkspace: project,
  approvalPolicy: "always",
  experimentalRtkEnabled: false,
  pinnedThreadIds: [created[0].threadId],
  sidebarOrder: {
    projectKeys: [project, notes],
    threadIdsByProject: {
      [project]: created
        .filter((v) => v.cwd === project)
        .map((v) => v.threadId),
      [notes]: created.filter((v) => v.cwd === notes).map((v) => v.threadId),
    },
  },
};
profile.providerProfiles.push({
  ...structuredClone(profile.providerProfiles[0]),
  providerProfileId: "mock-alt",
  displayName: "Mock alternate · local QA",
});
await fs.writeFile(
  path.join(qaRoot, "profile", "host-profile.json"),
  JSON.stringify(profile, null, 2) + "\n",
  { mode: 0o600 },
);
await fs.writeFile(
  marker,
  JSON.stringify(
    {
      repository,
      created,
      seededAt: new Date().toISOString(),
      provider: "fake",
      source: "ZenAppServer public APIs",
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ qaRoot, created }));
await server.closeRuntimeConfiguration();
