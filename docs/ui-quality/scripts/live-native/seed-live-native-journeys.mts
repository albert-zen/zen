import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { installLiveQa } from "./live-qa-controls.mjs";

const [repositoryArg, rootArg] = process.argv.slice(2);
if (!repositoryArg || !rootArg)
  throw Error(
    "Usage: node --import tsx seed-live-native-journeys.mts repository NEW-qa-root",
  );
const repository = await fs.realpath(path.resolve(repositoryArg));
const requestedRoot = path.resolve(rootArg);
await fs.mkdir(requestedRoot);
const qaRoot = await fs.realpath(requestedRoot); // Refuse every existing path, including active app profiles.
const load = (relative: string) =>
  import(pathToFileURL(path.join(repository, relative)).href);
const { FakeModel } = await load("src/model.ts");
const { ZenAppServer, AppServerError } = await load("src/app-server.ts");
const { createHostedAppServer } = await load("apps/cli/src/host.ts");
const { ToolEnvironment } = await load("src/tool.ts");
const { validateHostProfile, hostConfigFromProfile } = await load(
  "apps/zenx/src/main/host-profile.ts",
);
const { pendingQueuedMessages } = await load("src/input-queue.ts");
const { pendingSteerMessages } = await load("src/steer-recall.ts");
const { serveCodexWebSocket } = await load("src/protocol/codex/websocket.ts");
const { ZenXProtocolClient } = await load(
  "apps/zenx/src/protocol-client/index.ts",
);
await fs.writeFile(path.join(qaRoot, "seed-controls.jsonl"), "");
installLiveQa({
  FakeModel,
  ZenAppServer,
  AppServerError,
  receiptPath: path.join(qaRoot, "seed-controls.jsonl"),
  intervalMs: 10,
  chunks: 500,
  failureMs: 500,
  admissionMs: 150,
});
const project = path.join(qaRoot, "project"),
  data = path.join(qaRoot, "data");
await fs.mkdir(project);
await fs.mkdir(path.join(qaRoot, "profile"));
await fs.writeFile(
  path.join(project, "README.md"),
  "# Isolated live native UI QA\n\nSynthetic local fake provider. The QA adapter emits text/usage only and rejects tool-command input; this is not a global sandbox.\n",
);
const model = {
  id: "fake",
  contextWindow: 131072,
  inputModalities: ["text"],
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  isDefault: true,
};
const hostOptions = () => ({
  cwd: project,
  dataDirectory: data,
  approvalPolicy: "always",
  toolPresentation: "direct",
  toolEnvironment: new ToolEnvironment({ runtimes: [] }),
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
let host = createHostedAppServer(hostOptions());
const threads: Record<string, { threadId: string; name: string }> = {};
const named = async (key: string, name: string) => {
  const thread = await host.startThread({
    cwd: project,
    sandbox: "read-only",
    approvalPolicy: "always",
  });
  await host.setThreadName(thread.id, name);
  threads[key] = { threadId: thread.id, name };
  return thread.id;
};
const done = async (id: string, text: string) => {
  await (
    await host.startTurn(id, text)
  ).done;
};
const until = async (predicate, label: string) => {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`Timed out: ${label}`);
};
const assertions: Record<string, unknown> = {};
try {
  const stream = await named("stream", "Live stream · hold and follow · QA");
  for (let i = 1; i <= 30; i++)
    await done(
      stream,
      `## Reading checkpoint ${String(i).padStart(2, "0")}\n\n` +
        "Synthetic reading history. Keep this paragraph in view while a new response streams below. ".repeat(
          6,
        ),
    );
  assertions.longThreadCompletedTurns = (
    await host.readThread(stream)
  ).turns.length;
  assert.equal(assertions.longThreadCompletedTurns, 30);
  const pending = await named("pending", "Held pending · steer and queue · QA");
  const held = await host.startTurn(
    pending,
    "QA_HOLD: keep the current sample open while canonical pending messages arrive.",
    { clientId: "seed-hold" },
  );
  void held.done.catch(() => undefined);
  // Wait for the model to run by observing its fixture receipt, not fabricated canonical facts.
  await until(
    async () =>
      (
        await fs.readFile(path.join(qaRoot, "seed-controls.jsonl"), "utf8")
      ).includes("model_started"),
    "held model started",
  );
  for (let i = 1; i <= 2; i++)
    await host.stageSteerMessage(
      pending,
      held.id,
      `Steer ${i}: review **readability** before continuing. Synthetic local input.`,
      { clientId: `seed-steer-${i}` },
    );
  for (let i = 1; i <= 3; i++)
    await host.queueMessage(
      pending,
      `Queued ${i}: a separate next turn for layout review. Synthetic local input.`,
      `seed-queue-${i}`,
    );
  await host.interruptTurn(pending, held.id).catch(() => undefined);
  await held.done.catch(() => undefined);
  let snapshot = await host.readThread(pending);
  assert.equal(snapshot.turns.at(-1).status, "interrupted");
  assert.equal(pendingSteerMessages(snapshot.items).length, 2);
  assert.equal(pendingQueuedMessages(snapshot.items).length, 5);
  assertions.pendingBeforeRestart = {
    steer: 2,
    queue: 3,
    lastTurn: "interrupted",
  };

  const failure = await named("failure", "Provider failure · held steer · QA");
  const failed = await host.startTurn(
    failure,
    "QA_FAIL: controlled local failure after visible partial output.",
    { clientId: "seed-failure" },
  );
  void failed.done.catch(() => undefined);
  await until(
    async () =>
      (
        await fs.readFile(path.join(qaRoot, "seed-controls.jsonl"), "utf8")
      ).includes('"command":"QA_FAIL"'),
    "failing model started",
  );
  await host.stageSteerMessage(
    failure,
    failed.id,
    "This steer remains pending after the controlled provider failure.",
    { clientId: "seed-failure-steer" },
  );
  await failed.done.catch(() => undefined);
  snapshot = await host.readThread(failure);
  assert.equal(snapshot.turns.at(-1).status, "failed");
  assert(
    snapshot.items.some(
      (i) =>
        i.type === "failure" &&
        i.message.includes("Synthetic QA provider failure"),
    ),
  );
  assert.equal(pendingSteerMessages(snapshot.items).length, 1);
  assertions.providerFailure = { canonicalFailure: true, heldSteer: 1 };
  const admission = await named("admission", "Admission and retry · QA");
  await done(
    admission,
    "Use QA_ADMIT for a 15-second local admission wait, or QA_REJECT for an injected pre-admission rejection. The native IPC surface may conservatively show Delivery not confirmed and retain its recovery copy. These commands are active only in the isolated QA launch.",
  );

  await host.listThreadSummaries({});
  await host.closeHostResources();
  host = createHostedAppServer(hostOptions());
  snapshot = await host.readThread(pending);
  assert.equal(pendingSteerMessages(snapshot.items).length, 2);
  assert.equal(pendingQueuedMessages(snapshot.items).length, 5);
  assert.equal(snapshot.turns.at(-1).status, "interrupted");
  assert.equal(
    pendingSteerMessages((await host.readThread(failure)).items).length,
    1,
  );
  assertions.reopenedCanonicalState = true;

  // Exercise the same native transport that the desktop uses on a disposable thread.
  const transport = await serveCodexWebSocket({
    appServer: host,
    zenHome: data,
    listen: "ws://127.0.0.1:0",
  });
  const client = await ZenXProtocolClient.connect({
    url: transport.url,
    clientInfo: { name: "live-qa-seed-check", version: "1.0" },
    reconnect: { maxAttempts: 1, minDelayMs: 10, maxDelayMs: 10 },
  });
  try {
    const verify = await named("protocol", "Native protocol receipts · QA");
    let settled = false;
    const delayed = client
      .request("zen/turn/send", {
        threadId: verify,
        clientUserMessageId: "verify-delay",
        input: [
          { type: "text", text: "QA_ADMIT: native protocol waiting state" },
        ],
      })
      .finally(() => {
        settled = true;
      });
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(settled, false);
    assert.equal(
      (await host.readThread(verify)).items.some(
        (i) => i.type === "user_message" && i.clientId === "verify-delay",
      ),
      false,
    );
    await delayed;
    await until(
      async () =>
        (await host.readThread(verify)).turns.every(
          (t) => t.status === "completed",
        ),
      "delayed send complete",
    );
    await assert.rejects(
      client.request("zen/turn/send", {
        threadId: verify,
        clientUserMessageId: "verify-reject",
        input: [
          { type: "text", text: "QA_REJECT: fail before native admission" },
        ],
      }),
      /Synthetic QA admission rejection/,
    );
    assert.equal(
      (await host.readThread(verify)).items.some(
        (i) => i.type === "user_message" && i.clientId === "verify-reject",
      ),
      false,
    );
    const active = await client.request("zen/turn/send", {
      threadId: verify,
      clientUserMessageId: "verify-stream",
      input: [
        {
          type: "text",
          text: "QA_STREAM: native sustained output verification",
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 120));
    const queue = await client.request("zen/turn/send", {
      threadId: verify,
      clientUserMessageId: "verify-queue",
      mode: "queue",
      input: [{ type: "text", text: "Native queued verification" }],
    });
    const steer = await client.request("zen/turn/send", {
      threadId: verify,
      clientUserMessageId: "verify-steer",
      mode: "steer",
      expectedTurnId: active.turnId,
      input: [{ type: "text", text: "Native steer verification" }],
    });
    assert.equal(queue.admission.state, "queued");
    assert.equal(steer.admission.state, "queued");
    const read = await client.request("zen/thread/read", { threadId: verify });
    assert.equal(pendingQueuedMessages(read.thread.items).length, 2);
    await client.request("turn/interrupt", {
      threadId: verify,
      turnId: active.turnId,
    });
    assert(
      (await host.readThread(verify)).items.some(
        (i) =>
          i.type === "agent_message" &&
          i.turnId === active.turnId &&
          i.incomplete === true &&
          i.text.includes("Live checkpoint"),
      ),
    );
    assertions.nativeProtocol = {
      admissionWaitUncommitted: true,
      admissionFailureUncommitted: true,
      liveStreamInterrupted: true,
      interruptedPartialRetained: true,
      queuedReceipt: queue.admission,
      steerReceipt: steer.admission,
    };
  } finally {
    client.close();
    await transport.close();
  }
  await host.listThreadSummaries({});
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
        displayName: "Controlled local QA · FakeModel",
        models: [
          {
            ...model,
            isDefault: undefined,
            displayName: "Local deterministic QA",
            description:
              "Synthetic local timing and failure fixture; no remote provider",
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
    projectNames: { [project]: "Live native UI QA" },
    lastUsedWorkspace: project,
    approvalPolicy: "always",
    toolPresentation: "direct",
    experimentalRtkEnabled: false,
    composerSendMode: "batch",
    composerSendModeExplicit: true,
    pinnedThreadIds: [],
    visibleSubagentThreadIds: [],
    sidebarOrder: {
      projectKeys: [project],
      threadIdsByProject: {
        [project]: Object.values(threads).map((t) => t.threadId),
      },
    },
  };
  const validatedProfile = validateHostProfile(profile);
  const config = hostConfigFromProfile(validatedProfile, {
    dataDirectory: data,
    subscriptionProfilePath: path.join(qaRoot, "unused-subscription-profile"),
    fallbackWorkspace: project,
  });
  assert(config.providers.every((p) => p.provider.type === "fake"));
  assertions.hostProfileSchema = true;
  assertions.hostConfigFromProfile = true;
  await fs.writeFile(
    path.join(qaRoot, "profile", "host-profile.json"),
    JSON.stringify(validatedProfile, null, 2) + "\n",
    { mode: 0o600 },
  );
  validateHostProfile(
    JSON.parse(
      await fs.readFile(
        path.join(qaRoot, "profile", "host-profile.json"),
        "utf8",
      ),
    ),
  );
  const manifest = {
    kind: "zenx-live-native-qa-v1",
    repository,
    qaRoot,
    repositoryCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    repositoryTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    sourceWorktreeDirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: repository,
        encoding: "utf8",
      }).trim().length > 0,
    qaRuntime: {
      adapter:
        "Exported FakeModel.prototype.stream replaced only in isolated host memory; no delegation to production FakeModel",
      ordinaryInput: "Fixture-local text echo",
      toolCommandInput:
        "Reject !shell/!tool at any text-line or typed-part start before model output",
      admission:
        "Public send methods wrapped before commit, not a durable accepted state",
      stream: {
        command: "QA_STREAM",
        intervalMs: 1000,
        maxChunks: 600,
        stop: "native Stop",
      },
      hold: { command: "QA_HOLD", maxMs: 600000 },
      failure: {
        command: "QA_FAIL",
        afterMs: 3000,
        modelRecoveryBlocked: true,
      },
      admissionDelay: { command: "QA_ADMIT", delayMs: 15000 },
      admissionRejection: {
        command: "QA_REJECT",
        delayMs: 3000,
        code: "invalid_input",
        committed: false,
        nativePresentation:
          "May remain Delivery not confirmed after IPC; recovery copy retained until explicit dismissal",
      },
      limitations: [
        "Synthetic local timing/failure injection, not real provider behavior",
        "CLI receipts do not prove visual quality or actual scroll position",
        "Native IPC may conservatively classify injected rejection as unknown delivery; edited send does not dismiss the original recovery copy",
        "Interrupted partial output is retained as incomplete and discoverable in Activity, not promoted to a completed final answer",
        "The QA adapter emits text/usage only, never delegates to production FakeModel, and rejects !shell/!tool; the fixture does not globally isolate manual profile/plugin/tool actions",
        "Renderer default-session non-loopback requests blocked; not an OS firewall",
      ],
    },
    createdAt: new Date().toISOString(),
    synthetic: true,
    productionFilesEdited: false,
    source:
      "createHostedAppServer + public AppServer APIs + native WebSocket protocol",
    provider: "local FakeModel with QA-only timing/failure injection",
    threads,
    assertions,
  };
  await fs.writeFile(
    path.join(qaRoot, "seed-result.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  await host.closeHostResources();
}
