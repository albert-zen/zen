import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ZenAppServer } from "../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import {
  type ModelAdapter,
  type ModelRequest,
  type ModelEvent,
} from "../../../src/model.js";
import { OpenAiSubscriptionModel } from "../../../src/model/openai-subscription.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import {
  ShellToolExecutor,
  type ToolExecutor,
  type ToolInvocation,
} from "../../../src/tool.js";
import { serveCodexWebSocket } from "../../../src/protocol/codex/websocket.js";
import {
  MutableAppServerRequestPort,
  ZENX_SELF_CONTROL_CAPABILITY_ID,
  ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
  ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
  ZenXSelfControlCapabilityPackage,
  type AppServerRequestPort,
} from "../src/main/capabilities/self-control-package.js";
import { MemoryZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import type { ZenXCapabilityHost } from "../src/main/capabilities/types.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { AppServerManager } from "../src/main/app-server-manager.js";
import {
  ZenXProtocolClient,
  type ClientRequestMethod,
  type ClientRequestParams,
  type ClientRequestResults,
  type ServerNotificationParams,
} from "../src/protocol-client/index.js";

const SELF_CONTROL_TOOL_NAMES = [
  "zenx_projects_list",
  "zenx_threads_list",
  "zenx_threads_create",
  "zenx_threads_read",
  "zenx_threads_status",
  "zenx_threads_send",
];

test("real ZenX host control tools make active semantics explicit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-control-host-"));
  const requestPort = new MutableAppServerRequestPort();
  const capabilities = await grantedSelfControl(directory, requestPort);
  const manager = managerFor(directory, capabilities);
  requestPort.attach(manager, directory);
  const tools = capabilityTools(capabilities);
  try {
    await manager.start();
    const created = await invoke(tools, "zenx_threads_create", {
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const threadId = stringField(created, "threadId");

    const firstCommand = waitForCommand(manager, threadId);
    const first = await invoke(tools, "zenx_threads_send", {
      threadId,
      mode: "start",
      text: slowShell("steer-finished"),
      clientUserMessageId: "host-start-steer",
    });
    const firstTurnId = stringField(first, "turnId");
    await firstCommand;
    const active = await invoke(tools, "zenx_threads_status", { threadId });
    assert.equal(active.status, "active");
    assert.equal(active.activeTurnId, firstTurnId);

    const steered = await invoke(tools, "zenx_threads_send", {
      threadId,
      mode: "steer",
      text: "Use the steering update.",
      expectedTurnId: firstTurnId,
      clientUserMessageId: "host-steer",
    });
    assert.equal(steered.mode, "steer");
    assert.equal(steered.expectedTurnId, firstTurnId);
    await waitUntilIdle(tools, threadId);

    const secondCommand = waitForCommand(manager, threadId);
    const second = await invoke(tools, "zenx_threads_send", {
      threadId,
      mode: "start",
      text: slowShell("replace-finished"),
      clientUserMessageId: "host-start-replace",
    });
    const secondTurnId = stringField(second, "turnId");
    await secondCommand;
    const replaced = await invoke(tools, "zenx_threads_send", {
      threadId,
      mode: "replace",
      text: "Replacement prompt.",
      expectedTurnId: secondTurnId,
      clientUserMessageId: "host-replace",
    });
    assert.equal(replaced.interruptedTurnId, secondTurnId);
    assert.notEqual(replaced.turnId, secondTurnId);
    await waitUntilIdle(tools, threadId);

    await invoke(tools, "zenx_threads_send", {
      threadId,
      mode: "start",
      text: "Follow-up prompt.",
      clientUserMessageId: "host-follow-up",
    });
    await waitUntilIdle(tools, threadId);

    const recent = await invoke(tools, "zenx_threads_read", {
      threadId,
      maxTurns: 4,
      maxItemsPerTurn: 25,
    });
    assert.equal(recent.source, "zenx.app-server");
    const turns = recent.turns as Array<{
      status: string;
      items: Array<{ type: string; clientId?: string }>;
    }>;
    assert(turns.some((turn) => turn.status === "interrupted"));
    assert(
      turns.some((turn) =>
        turn.items.some((item) => item.clientId === "host-follow-up"),
      ),
    );

    const projects = await invoke(tools, "zenx_projects_list", { limit: 10 });
    assert(
      (projects.projects as Array<{ cwd: string; threadIds: string[] }>).some(
        (project) =>
          project.cwd === path.resolve(directory) &&
          project.threadIds.includes(threadId),
      ),
    );
    const listed = await invoke(tools, "zenx_threads_list", {
      workspace: directory,
      query: threadId.slice(0, 8),
      limit: 10,
    });
    assert.equal(
      (listed.threads as Array<{ threadId: string }>)[0]?.threadId,
      threadId,
    );

    const bridgeThread = await manager.request("thread/start", {
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const bridgeCompleted = waitForManagerTurnCompleted(
      manager,
      bridgeThread.thread.id,
    );
    await manager.request("turn/start", {
      threadId: bridgeThread.thread.id,
      input: [{ type: "text", text: '!tool zenx_projects_list {"limit":10}' }],
      clientUserMessageId: "host-capability-bridge",
    });
    await bridgeCompleted;
    const bridgeRead = await manager.request("thread/read", {
      threadId: bridgeThread.thread.id,
      includeTurns: true,
    });
    assert(
      bridgeRead.thread.turns
        .flatMap((turn) => turn.items)
        .some(
          (item) =>
            item.type === "commandExecution" &&
            item.command.startsWith("zenx_projects_list ") &&
            item.status === "completed",
        ),
    );
    assert(
      capabilities
        .snapshot()
        .recentInvocations.some(
          (record) =>
            record.toolName === "zenx_projects_list" &&
            record.status === "completed",
        ),
    );

    await assert.rejects(
      invoke(tools, "zenx_threads_send", {
        threadId,
        mode: "steer",
        text: "missing expected turn",
        clientUserMessageId: "invalid-steer",
      }),
      /requires expectedTurnId/u,
    );
  } finally {
    await manager.stop();
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an Agent drives the complete bounded tracer bullet through App Server wire calls", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-control-agent-"),
  );
  const workspace = path.resolve(os.tmpdir(), "zenx-agent-workspace");
  const requestPort = new MutableAppServerRequestPort();
  const capabilities = await grantedSelfControl(directory, requestPort);
  const tools = capabilityTools(capabilities);
  const appServer = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({
      model: new TracerBulletModel(workspace),
      tools,
    }),
    modelCatalog: new StaticModelCatalog([{ id: "tracer", isDefault: true }]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: workspace,
      model: "tracer",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zenx-agent-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await ZenXProtocolClient.connect({
    url: server.url,
    clientInfo: {
      name: "zenx-agent-control-smoke",
      title: "ZenX Agent Control Smoke",
      version: "0.1.0",
    },
  });
  requestPort.attach(client, workspace);
  const approvals: string[] = [];
  client.onServerRequest(
    "item/commandExecution/requestApproval",
    async (params) => {
      approvals.push(params.command);
      return { decision: "accept" };
    },
  );
  try {
    const source = await client.request("thread/start", {
      cwd: workspace,
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const completed = waitForTurnCompleted(client, source.thread.id);
    const sourceTurn = await client.request("turn/start", {
      threadId: source.thread.id,
      input: [{ type: "text", text: "Run the ZenX tracer bullet." }],
      clientUserMessageId: "tracer-source",
    });
    await completed;

    const sourceRead = await client.request("thread/read", {
      threadId: source.thread.id,
      includeTurns: true,
    });
    const completedSourceTurn = sourceRead.thread.turns.find(
      (turn) => turn.id === sourceTurn.turn.id,
    );
    assert.equal(completedSourceTurn?.status, "completed");
    const calls = completedSourceTurn?.items.filter(
      (item) => item.type === "commandExecution",
    );
    assert.deepEqual(
      calls?.map((call) => call.command.split(" ")[0]),
      [
        "zenx_projects_list",
        "zenx_threads_list",
        "zenx_threads_create",
        "zenx_threads_send",
        "zenx_threads_status",
        "zenx_threads_read",
        "zenx_threads_send",
      ],
    );
    assert(calls?.every((call) => call.status === "completed"));
    assert.equal(approvals.length, 7);
    assert(approvals.every((command) => command.startsWith("zenx_")));

    const listed = await client.request("thread/list", {});
    const target = listed.data.find((thread) => thread.id !== source.thread.id);
    assert.notEqual(target, undefined);
    const targetRead = await client.request("thread/read", {
      threadId: target!.id,
      includeTurns: true,
    });
    assert.equal(targetRead.thread.cwd, workspace);
    assert.deepEqual(
      targetRead.thread.turns.map((turn) => turn.status),
      ["completed", "completed"],
    );
    assert.deepEqual(
      targetRead.thread.turns
        .flatMap((turn) => turn.items)
        .filter((item) => item.type === "userMessage")
        .map((item) => item.clientId),
      ["tracer-child-start", "tracer-child-follow-up"],
    );
  } finally {
    client.close();
    await server.close();
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded reads omit command output and truncate message text", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-control-bound-"),
  );
  const hugeMessage = "long-message".repeat(500);
  const secretOutput = "secret-like-output".repeat(500);
  const port: AppServerRequestPort = {
    configuredWorkspace: "/tmp/work",
    async request<M extends ClientRequestMethod>(
      method: M,
      _params: ClientRequestParams[M],
    ): Promise<ClientRequestResults[M]> {
      assert.equal(method, "thread/read");
      return {
        thread: {
          id: "thread-bounded",
          sessionId: "thread-bounded",
          forkedFromId: null,
          parentThreadId: null,
          preview: "",
          ephemeral: false,
          isPinned: false,
          modelProvider: "fake",
          createdAt: 1,
          updatedAt: 2,
          recencyAt: null,
          status: { type: "idle" },
          path: null,
          cwd: "/tmp/work",
          cliVersion: "zen/0.1.0",
          source: "appServer",
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [
            {
              id: "turn-bounded",
              itemsView: "full",
              status: "completed",
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1_000,
              items: [
                {
                  type: "agentMessage",
                  id: "agent-long",
                  text: hugeMessage,
                  phase: "final_answer",
                  memoryCitation: null,
                },
                {
                  type: "commandExecution",
                  id: "command-secret",
                  pluginId: null,
                  scriptPath: null,
                  command: "inspect",
                  cwd: "/tmp/work",
                  processId: null,
                  source: "agent",
                  status: "completed",
                  commandActions: [],
                  aggregatedOutput: secretOutput,
                  exitCode: 0,
                  durationMs: null,
                },
              ],
            },
          ],
        },
      } as ClientRequestResults[M];
    },
  };
  const capabilities = await grantedSelfControl(directory, port);
  try {
    const result = await invoke(
      capabilityTools(capabilities),
      "zenx_threads_read",
      {
        threadId: "thread-bounded",
        maxTurns: 1,
        maxItemsPerTurn: 2,
      },
    );
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /secret-like-output/u);
    assert.match(serialized, /\[truncated\]/u);
    assert.match(serialized, /"outputOmitted":true/u);
  } finally {
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("all hosted tool definitions serialize through the OpenAI subscription boundary", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-control-openai-"),
  );
  const capabilities = await grantedSelfControl(
    directory,
    new MutableAppServerRequestPort(),
  );
  try {
    const tools = [
      ...new ShellToolExecutor({ environment: {} }).definitions,
      ...capabilities.hostSnapshot().definitions,
    ];
    let capturedInit: RequestInit | undefined;
    const adapter = new OpenAiSubscriptionModel({
      acquireAccessLease: async () => ({ accessToken: subscriptionJwt() }),
      endpoint: "https://example.test/backend-api/codex/responses",
      fetch: async (_input, init) => {
        capturedInit = init;
        return completedSubscriptionResponse();
      },
    });

    for await (const _event of adapter.stream({
      model: "gpt-5.6-terra",
      messages: [],
      tools,
      signal: new AbortController().signal,
    })) {
      // Consuming the stream proves request serialization completed.
    }

    const body = JSON.parse(String(capturedInit?.body)) as {
      tools: Array<{ name: string }>;
    };
    assert.deepEqual(
      body.tools.map((tool) => tool.name),
      ["shell", ...SELF_CONTROL_TOOL_NAMES],
    );
    assert(
      body.tools.every((tool) => /^[a-zA-Z0-9_-]{1,64}$/u.test(tool.name)),
    );
  } finally {
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class TracerBulletModel implements ModelAdapter {
  readonly provider = "tracer";
  readonly #workspace: string;

  constructor(workspace: string) {
    this.#workspace = workspace;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const firstUser = request.messages.find(
      (message) => message.role === "user",
    );
    if (
      firstUser?.role !== "user" ||
      !firstUser.text.includes("tracer bullet")
    ) {
      yield {
        type: "text_delta",
        delta: `Completed: ${firstUser?.text ?? ""}`,
      };
      return;
    }
    const results = request.messages.filter(
      (message) => message.role === "tool",
    );
    const call = (name: string, args: Record<string, unknown>): ModelEvent => ({
      type: "tool_call",
      callId: `tracer-${String(results.length)}`,
      name,
      arguments: args,
    });
    switch (results.length) {
      case 0:
        yield call("zenx_projects_list", { limit: 10 });
        return;
      case 1:
        yield call("zenx_threads_list", {
          workspace: this.#workspace,
          limit: 10,
        });
        return;
      case 2:
        yield call("zenx_threads_create", {
          cwd: this.#workspace,
          model: "tracer",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        });
        return;
      case 3: {
        const target = selfControlResult(results[2]!.text);
        yield call("zenx_threads_send", {
          threadId: target.threadId,
          mode: "start",
          text: "Child initial prompt.",
          clientUserMessageId: "tracer-child-start",
        });
        return;
      }
      case 4: {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const target = selfControlResult(results[2]!.text);
        yield call("zenx_threads_status", { threadId: target.threadId });
        return;
      }
      case 5: {
        const target = selfControlResult(results[2]!.text);
        yield call("zenx_threads_read", {
          threadId: target.threadId,
          maxTurns: 2,
          maxItemsPerTurn: 10,
        });
        return;
      }
      case 6: {
        const target = selfControlResult(results[2]!.text);
        yield call("zenx_threads_send", {
          threadId: target.threadId,
          mode: "start",
          text: "Child follow-up prompt.",
          clientUserMessageId: "tracer-child-follow-up",
        });
        return;
      }
      default:
        yield { type: "text_delta", delta: "ZenX tracer bullet completed." };
    }
  }
}

async function grantedSelfControl(
  directory: string,
  appServer: AppServerRequestPort,
): Promise<ZenXCapabilityService> {
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: directory,
    grantStore: new MemoryZenXCapabilityGrantStore(),
    localDirectory: path.join(directory, "no-local-capabilities"),
  });
  await capabilities.initialize();
  capabilities.register(new ZenXSelfControlCapabilityPackage({ appServer }));
  assert(
    capabilities
      .hostSnapshot()
      .definitions.every(
        (definition) => !SELF_CONTROL_TOOL_NAMES.includes(definition.name),
      ),
    "self-control tools must stay hidden until explicitly granted",
  );
  await capabilities.grant(ZENX_SELF_CONTROL_CAPABILITY_ID, [
    ZENX_SELF_CONTROL_WORKSPACE_PERMISSION,
    ZENX_SELF_CONTROL_LOCAL_DEVICE_PERMISSION,
  ]);
  assert.deepEqual(
    capabilities
      .hostSnapshot()
      .definitions.filter((definition) =>
        SELF_CONTROL_TOOL_NAMES.includes(definition.name),
      )
      .map((definition) => definition.name),
    SELF_CONTROL_TOOL_NAMES,
  );
  return capabilities;
}

function capabilityTools(capabilities: ZenXCapabilityService): ToolExecutor {
  return {
    definitions: capabilities.hostSnapshot().definitions,
    async execute(invocation: ToolInvocation) {
      return await capabilities.execute(invocation);
    },
  };
}

function managerFor(
  directory: string,
  capabilityHost: ZenXCapabilityHost,
): AppServerManager {
  return new AppServerManager({
    entryPath: fileURLToPath(
      new URL("../src/main/app-server-host.ts", import.meta.url),
    ),
    tokenFile: path.join(directory, "runtime", "token"),
    hostConfig: {
      cwd: directory,
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
    capabilityHost,
  });
}

async function invoke(
  tools: ToolExecutor,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await tools.execute({
    callId: `test-${Date.now().toString(36)}-${Math.random().toString(36)}`,
    name,
    arguments: args,
    cwd: process.cwd(),
    signal: new AbortController().signal,
  });
  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.output) as {
    capabilityId: string;
    result: Record<string, unknown>;
  };
  assert.equal(envelope.capabilityId, ZENX_SELF_CONTROL_CAPABILITY_ID);
  return envelope.result;
}

function waitForCommand(
  manager: AppServerManager,
  threadId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose();
      reject(new Error("Timed out waiting for command execution"));
    }, 10_000);
    const dispose = manager.onNotification((method, params) => {
      if (method === "item/started") {
        const started = params as ServerNotificationParams["item/started"];
        if (
          started.threadId !== threadId ||
          started.item.type !== "commandExecution"
        ) {
          return;
        }
        clearTimeout(timer);
        dispose();
        resolve();
      }
    });
  });
}

async function waitUntilIdle(
  tools: ToolExecutor,
  threadId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await invoke(tools, "zenx_threads_status", { threadId });
    if (status.status === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Thread to become idle");
}

function waitForTurnCompleted(
  client: ZenXProtocolClient,
  threadId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose();
      reject(new Error("Timed out waiting for turn/completed"));
    }, 10_000);
    const dispose = client.onNotification("turn/completed", (params) => {
      if (params.threadId === threadId) {
        clearTimeout(timer);
        dispose();
        resolve();
      }
    });
  });
}

function waitForManagerTurnCompleted(
  manager: AppServerManager,
  threadId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose();
      reject(new Error("Timed out waiting for hosted turn/completed"));
    }, 10_000);
    const dispose = manager.onNotification((method, params) => {
      if (method !== "turn/completed") return;
      const completed = params as ServerNotificationParams["turn/completed"];
      if (completed.threadId !== threadId) return;
      clearTimeout(timer);
      dispose();
      resolve();
    });
  });
}

function selfControlResult(text: string): { threadId: string } {
  const envelope = JSON.parse(text) as {
    capabilityId: string;
    result: { threadId: string };
  };
  assert.equal(envelope.capabilityId, ZENX_SELF_CONTROL_CAPABILITY_ID);
  return envelope.result;
}

function slowShell(label: string): string {
  return `!shell node -e "setTimeout(() => console.log('${label}'), 300)"`;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  assert.equal(typeof field, "string");
  return field as string;
}

function subscriptionJwt(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_zenx_tool_contract",
    },
  })}.signature`;
}

function completedSubscriptionResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        output: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\r\n\r\ndata: [DONE]\r\n\r\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}
