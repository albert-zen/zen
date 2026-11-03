import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { createLiveUserMcpHost } from "../test/fixtures/live-user-mcp-host.js";

// Actual Codex + actual MCP/Host, but a deterministic Responses protocol fixture,
// NOT a live model, Desktop approval test, production registration, or user config.
// Protocol inspected using Codex 0.166.0-alpha.1 app-server generate-ts --experimental.
const root = await mkdtemp(path.join(os.tmpdir(), "zen-codex-mcp-turn-"));
const liveMode = process.env.ZEN_MCP_CODEX_LIVE_HOST === "1";
const useBuilt = process.env.ZEN_MCP_TEST_USE_BUILT === "1";
let liveHost: Awaited<ReturnType<typeof createLiveUserMcpHost>> | undefined;
let localServer: ReturnType<typeof createServer> | undefined;
try {
  const home = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  await mkdir(home);
  await mkdir(workspace);
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  const fixture = fileURLToPath(
    new URL("../test/fixtures/real-user-mcp-stdio.ts", import.meta.url),
  );
  const codex = process.env.ZEN_CODEX_EXECUTABLE ?? "codex";
  const cleanEnvironment = {
    PATH: process.env.PATH!,
    HOME: root,
    CODEX_HOME: home,
    TMPDIR: root,
    LOGNAME: "zen-mcp-fixture",
    USER: "zen-mcp-fixture",
    SHELL: "/bin/sh",
    TERM: "dumb",
  };
  const version = execFileSync(codex, ["--version"], {
    encoding: "utf8",
    env: cleanEnvironment,
  }).trim();
  const document = {
    id: "local-protocol-fixture",
    title: "Actual Codex MCP Board write",
    summary: "Deterministic local protocol fixture, not a real model response",
    blocks: [{ kind: "note", id: "scope", text: "Actual private Host CAS" }],
    events: [],
  };
  let boardSnapshot: string;
  let sidebarSnapshot: string;
  let sidebarExpected: Record<string, unknown>;
  const steps = [
    {
      name: "zenx_threads_read",
      arguments: () => ({}),
      verify: (value: any) =>
        assert.match(
          JSON.stringify(value),
          liveMode
            ? /Actual already-running Desktop child history/
            : /A real private MCP fixture history/,
        ),
    },
    {
      name: "zenx_board_read",
      arguments: () => ({ view: "document" }),
      verify: (value: any) => {
        assert.equal(value.exists, false);
        assert.match(value.snapshot, /^mcp:[^:]+:r[1-9][0-9]*$/);
        boardSnapshot = value.snapshot;
      },
    },
    {
      name: "zenx_board_put",
      arguments: () => ({ snapshot: boardSnapshot, document }),
      verify: (value: any) => assert.equal(value.applied, true),
    },
    {
      name: "zenx_board_put",
      arguments: () => ({
        snapshot: boardSnapshot,
        document: { ...document, title: "Stale Board write must not apply" },
      }),
      verify: (value: any) => assert.equal(value.applied, false),
    },
    {
      name: "zenx_board_read",
      arguments: () => ({ view: "document" }),
      verify: (value: any) => {
        assert.deepEqual(value.document, {
          ...document,
          owner: { kind: "thread" },
        });
        assert.notEqual(value.snapshot, boardSnapshot);
      },
    },
    {
      name: "zenx_self_control_sidebar_read",
      arguments: () => ({}),
      verify: (value: any) => {
        assert.equal(value.state.open, false);
        assert.match(value.snapshot, /^mcp:[^:]+:r[1-9][0-9]*$/);
        sidebarSnapshot = value.snapshot;
        sidebarExpected = { ...value.state, open: true };
      },
    },
    {
      name: "zenx_self_control_sidebar_update",
      arguments: () => ({ snapshot: sidebarSnapshot, patch: { open: true } }),
      verify: (value: any) => assert.equal(value.applied, true),
    },
    {
      name: "zenx_self_control_sidebar_update",
      arguments: () => ({ snapshot: sidebarSnapshot, patch: { open: false } }),
      verify: (value: any) => assert.equal(value.applied, false),
    },
    {
      name: "zenx_self_control_sidebar_read",
      arguments: () => ({}),
      verify: (value: any) => {
        assert.deepEqual(value.state, sidebarExpected);
        assert.notEqual(value.snapshot, sidebarSnapshot);
      },
    },
  ];
  const finalText =
    "LOCAL_PROTOCOL_FIXTURE_COMPLETED: actual Host read/CAS verified";
  let providerRequests = 0;
  let verifiedOutputs = 0;
  let fixtureError: unknown;
  const blockedEgress = new Set<string>();
  const server = (localServer = createServer(async (request, response) => {
    try {
      // Proxy requests for any external target are rejected locally, never forwarded.
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        blockedEgress.add(`${request.method} ${request.url}`);
        response.writeHead(403).end();
        return;
      }
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers["x-api-key"], undefined);
      let raw = "";
      for await (const chunk of request) {
        raw += String(chunk);
        assert(Buffer.byteLength(raw) < 4 * 1024 * 1024, "Request too large");
      }
      const body = JSON.parse(raw);
      assert.equal(body.model, "zen-local-protocol-fixture");
      assert.equal(body.stream, true);
      const index = providerRequests++;
      assert(index <= steps.length, "Unexpected extra provider request");
      if (index > 0) {
        const outputs = body.input.filter(
          (item: any) =>
            item.type === "function_call_output" &&
            item.call_id === `fixture_call_${index}`,
        );
        assert.equal(
          outputs.length,
          1,
          "Codex must return the actual MCP output",
        );
        const output = outputs[0].output;
        const texts =
          typeof output === "string"
            ? [output]
            : output
                .filter((part: any) => part.type === "input_text")
                .map((part: any) => part.text);
        const payload = texts.find((text: string) => text.startsWith("{"));
        assert(
          payload,
          `Expected actual JSON Host output for step ${index} ${steps[index - 1]!.name}, received ${JSON.stringify(texts)}`,
        );
        steps[index - 1]!.verify(JSON.parse(payload));
        verifiedOutputs++;
      }
      const step = steps[index];
      let item;
      if (step) {
        const namespace = body.tools.find(
          (tool: any) =>
            tool.type === "namespace" && tool.name === "mcp__zen_bound",
        );
        assert(
          namespace?.tools.some((tool: any) => tool.name === step.name),
          `Actual Codex request did not expose ${step.name}`,
        );
        item = {
          type: "function_call",
          id: `fixture_function_${index + 1}`,
          call_id: `fixture_call_${index + 1}`,
          namespace: namespace.name,
          name: step.name,
          arguments: JSON.stringify(step.arguments()),
        };
      } else {
        item = {
          type: "message",
          id: "fixture_final_message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: finalText, annotations: [] }],
        };
      }
      const result = {
        id: `fixture_response_${index + 1}`,
        object: "response",
        created_at: 1,
        model: body.model,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const emit = (event: any) =>
        response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      emit({
        type: "response.created",
        response: { ...result, status: "in_progress", output: [] },
      });
      emit({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          ...item,
          ...(step ? { arguments: "" } : { content: [] }),
        },
      });
      if (!step)
        emit({
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: finalText,
        });
      emit({ type: "response.output_item.done", output_index: 0, item });
      emit({ type: "response.completed", response: result });
      response.end();
    } catch (error) {
      fixtureError ??= error;
      if (!response.headersSent) response.writeHead(500);
      response.end("Deterministic local protocol fixture assertion failed");
    }
  }));
  server.on("connect", (request, socket) => {
    blockedEgress.add(`CONNECT ${request.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const local = `http://127.0.0.1:${address.port}`;
  const childEnvironment = {
    ...cleanEnvironment,
    // This rejecting local proxy is not a kernel network isolation guarantee.
    HTTP_PROXY: local,
    HTTPS_PROXY: local,
    ALL_PROXY: local,
    NO_PROXY: "127.0.0.1,localhost",
  };
  let mcpArgs = ["--import", "tsx", fixture];
  let hostBefore:
    { processId: number; processEpoch: string; itemCount: number } | undefined;
  let hostAfter: typeof hostBefore;
  let hostItemsBefore: readonly unknown[] | undefined;
  let independentSdkReadback = false;
  if (liveMode) {
    const { createLiveUserMcpHost } =
      await import("../test/fixtures/live-user-mcp-host.js");
    // This explicit fixture boots the actual Desktop child BEFORE Codex starts.
    // The production launcher below only connects to this existing descriptor.
    liveHost = await createLiveUserMcpHost(path.join(root, "private-host"), {
      environment: childEnvironment,
      useBuilt,
    });
    const before = await liveHost.manager.request("zen/thread/read", {
      threadId: liveHost.threadId,
    });
    hostItemsBefore = before.thread.items;
    const processId = liveHost.manager.processId;
    const processEpoch = liveHost.manager.processEpoch;
    assert.equal(typeof processId, "number");
    assert.equal(typeof processEpoch, "string");
    hostBefore = {
      processId: processId!,
      processEpoch: processEpoch!,
      itemCount: before.thread.items.length,
    };
    mcpArgs = [
      ...(useBuilt ? [] : ["--import", "tsx"]),
      fileURLToPath(
        new URL(
          useBuilt
            ? "../out/main/user-mcp-stdio-cli.js"
            : "../src/main/user-mcp-stdio-cli.ts",
          import.meta.url,
        ),
      ),
      "--descriptor",
      liveHost.descriptorFile,
      "--thread",
      liveHost.threadId,
    ];
  }
  await writeFile(
    path.join(home, "config.toml"),
    [
      'model = "zen-local-protocol-fixture"',
      'model_provider = "zen_local_fixture"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'web_search = "disabled"',
      "[analytics]",
      "enabled = false",
      "[model_providers.zen_local_fixture]",
      'name = "Deterministic local protocol fixture, not a real model"',
      `base_url = ${JSON.stringify(`${local}/v1`)}`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "[mcp_servers.zen_bound]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify(mcpArgs)}`,
      `cwd = ${JSON.stringify(repository)}`,
      "startup_timeout_sec = 60",
      "tool_timeout_sec = 30",
      // These two fixed synthetic writes are explicitly in this smoke's scope.
      // Configure only this throwaway Codex client, not the Host's permissions.
      "[mcp_servers.zen_bound.tools.zenx_board_put]",
      'approval_mode = "approve"',
      "[mcp_servers.zen_bound.tools.zenx_self_control_sidebar_update]",
      'approval_mode = "approve"',
      "[mcp_servers.zen_bound.env]",
      ...(liveMode
        ? []
        : [
            `ZEN_MCP_FIXTURE_ROOT = ${JSON.stringify(path.join(root, "private-host"))}`,
          ]),
      "",
    ].join("\n"),
  );
  const child = spawn(codex, ["app-server", "--stdio", "--strict-config"], {
    cwd: workspace,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += String(data)));
  let next = 1;
  const pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  const completedMcpCalls: any[] = [];
  const completedMessages: any[] = [];
  let resolveTerminal!: (value: any) => void;
  let rejectTerminal!: (error: Error) => void;
  const terminal = new Promise<any>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  // The terminal can reject while an earlier RPC is still being awaited.
  void terminal.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const call = pending.get(message.id);
    if (call) {
      pending.delete(message.id);
      if (message.error) call.reject(new Error(JSON.stringify(message.error)));
      else call.resolve(message.result);
      return;
    }
    if (message.id != null) {
      // No auto-approvals, commands, OAuth or other unsolicited client actions.
      child.stdin.write(
        JSON.stringify({
          id: message.id,
          error: {
            code: -32601,
            message: "No client actions in offline fixture",
          },
        }) + "\n",
      );
      return;
    }
    if (message.method === "item/completed") {
      const item = message.params.item;
      if (item.type === "mcpToolCall") completedMcpCalls.push(item);
      if (item.type === "agentMessage") completedMessages.push(item);
    }
    if (message.method === "turn/completed") resolveTerminal(message.params);
  });
  const fail = (error: Error) => {
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    rejectTerminal(error);
  };
  child.stdin.on("error", fail);
  child.once("error", fail);
  child.once("exit", (code) =>
    fail(new Error(`Codex exited (${code}). stderr=${stderr}`)),
  );
  const timeout = setTimeout(() => {
    fail(new Error(`Actual Codex turn timed out. stderr=${stderr}`));
    child.kill("SIGKILL");
  }, 120000);
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    await request("initialize", {
      clientInfo: { name: "zen-offline-codex-mcp-turn", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const started = await request("thread/start", {
      cwd: workspace,
      model: "zen-local-protocol-fixture",
      modelProvider: "zen_local_fixture",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      environments: [],
    });
    const threadId = started.thread.id;
    // Reuse this thread's connection and wait for readiness. Global discovery may
    // launch a separate process and must not share this private Host writer root.
    const discovery = await request("mcpServerStatus/list", {
      threadId,
      serverName: "zen_bound",
      detail: "toolsAndAuthOnly",
      limit: 100,
    });
    const bound = discovery.data.find(
      (entry: any) => entry.name === "zen_bound",
    );
    assert(bound, "Bound MCP server missing");
    assert.equal(bound.runtimeStatus, "connected");
    assert.deepEqual(
      Object.keys(bound.tools).sort(),
      [...new Set(steps.map((step) => step.name))].sort(),
    );
    const startedTurn = await request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: "Exercise the authorized private Host MCP fixture only. The local Responses protocol fixture will read history, verify Board/sidebar CAS and stale conflicts, then return its terminal marker. This is not a real LLM test.",
          text_elements: [],
        },
      ],
    });
    const result = await terminal;
    if (fixtureError) throw fixtureError;
    assert.equal(result.threadId, threadId);
    assert.equal(result.turn.id, startedTurn.turn.id);
    assert.equal(result.turn.status, "completed");
    assert.equal(result.turn.error, null);
    assert.equal(providerRequests, steps.length + 1);
    assert.equal(verifiedOutputs, steps.length);
    assert.equal(completedMcpCalls.length, steps.length);
    assert.deepEqual(
      completedMcpCalls.map((item) => item.tool),
      steps.map((step) => step.name),
    );
    for (const item of completedMcpCalls) {
      assert.equal(item.server, "zen_bound");
      assert.equal(item.status, "completed");
      assert.equal(item.error, null);
      assert(item.result?.content?.some((part: any) => part.type === "text"));
    }
    assert(completedMessages.some((item) => item.text === finalText));
    if (liveHost) {
      // Independent official SDK client, same production launcher and live Host.
      // Its reads use a separate MCP connection, not Codex's snapshot registry.
      const { Client } =
        await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } =
        await import("@modelcontextprotocol/sdk/client/stdio.js");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: mcpArgs,
        cwd: repository,
        env: childEnvironment,
        stderr: "pipe",
      });
      let sdkStderr = "";
      transport.stderr?.on("data", (data) => (sdkStderr += String(data)));
      const client = new Client({
        name: "independent-live-host-readback",
        version: "1",
      });
      try {
        await client.connect(transport);
        const read = async (name: string, args: Record<string, unknown>) => {
          const result = await client.callTool({ name, arguments: args });
          assert.notEqual(result.isError, true, JSON.stringify(result));
          return JSON.parse(
            (result.content as any[])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          );
        };
        const board = await read("zenx_board_read", { view: "document" });
        assert.deepEqual(board.document, {
          ...document,
          owner: { kind: "thread" },
        });
        const sidebar = await read("zenx_self_control_sidebar_read", {});
        assert.equal(sidebar.state.open, true);
        independentSdkReadback = true;
      } catch (error) {
        throw new Error(
          `Independent live Host readback failed. stderr=${sdkStderr}`,
          { cause: error },
        );
      } finally {
        await client.close();
        await transport.close();
      }
      const after = await liveHost.manager.request("zen/thread/read", {
        threadId: liveHost.threadId,
      });
      assert.deepEqual(
        after.thread.items,
        hostItemsBefore,
        "Existing Host history must remain unchanged",
      );
      hostAfter = {
        processId: liveHost.manager.processId!,
        processEpoch: liveHost.manager.processEpoch!,
        itemCount: after.thread.items.length,
      };
      assert.deepEqual(
        hostAfter,
        hostBefore,
        "Launcher and tools must not restart the Host or append a Host Turn",
      );
    }
    console.log(
      JSON.stringify(
        {
          version,
          mode: liveMode
            ? `production connect-only launcher -> already-running actual Desktop child (${useBuilt ? "built" : "source"})`
            : "existing actual Host composition fixture",
          ...(liveMode
            ? {
                liveHost: {
                  before: hostBefore,
                  after: hostAfter,
                  independentSdkReadback,
                },
              }
            : {}),
          provider:
            "deterministic loopback Responses protocol fixture, no real LLM",
          providerRequests,
          completedMcpCalls: completedMcpCalls.map((item) => item.tool),
          verified: [
            "actual Codex model request -> MCP call -> actual Host history read",
            "actual Board CAS applied, stale CAS rejected, readback unchanged",
            "actual sidebar CAS applied, stale CAS rejected, readback unchanged",
            "actual tool outputs returned to Codex provider requests",
            "actual Codex turn/completed status=completed and final marker",
          ],
          safety: {
            credentialsInherited: false,
            authorizationHeadersReceived: false,
            upstreamForwarding: false,
            networkBoundary:
              "local rejecting HTTP(S) proxy, not kernel isolation",
            blockedBackgroundTargets: [...blockedEgress].sort(),
            productionRegistration: false,
            userConfigurationChanged: false,
          },
          notVerified: [
            "real LLM behavior",
            "Desktop approval UI",
            "Room/workspace Board semantics",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    lines.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
} finally {
  // These also own setup failures before Codex/RPC cleanup exists.
  try {
    await liveHost?.close();
  } finally {
    if (localServer?.listening) {
      localServer.closeAllConnections();
      await new Promise<void>((resolve) => localServer!.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}
