import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ShellToolRuntime, type ToolInvocation } from "../src/tool.js";
import { ApplyPatchToolRuntime } from "../src/apply-patch.js";

// These exercise real file effects, including writes through a symlink.
for (const mode of ["read-only", "workspace-write"] as const) {
  test(
    `shell enforces ${mode} against actual files`,
    { skip: process.platform !== "darwin" },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "zen-permission-"));
      try {
        const cwd = path.join(root, "workspace");
        await mkdir(cwd);
        await writeFile(path.join(root, "outside"), "original");
        await symlink(root, path.join(cwd, "escape"));
        const runtime = new ShellToolRuntime();
        const run = (command: string) =>
          runtime.execute({
            callId: "p",
            name: "shell",
            arguments: { command },
            cwd,
            signal: new AbortController().signal,
            sandbox: mode,
          } as ToolInvocation);
        assert.equal((await run("cat ../outside")).output.trim(), "original");
        assert.notEqual((await run("echo bad > escape/outside")).exitCode, 0);
        assert.equal(
          await readFile(path.join(root, "outside"), "utf8"),
          "original",
        );
        assert.equal(
          (await run("echo ok > inside")).exitCode === 0,
          mode === "workspace-write",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test("workspace patch denies symlink escapes before writing any files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-permission-"));
  try {
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    await symlink(root, path.join(cwd, "escape"));
    const result = await new ApplyPatchToolRuntime().execute({
      callId: "p",
      name: "apply_patch",
      arguments: {
        patch:
          "*** Begin Patch\n*** Add File: inside\n+ok\n*** Add File: escape/outside\n+bad\n*** End Patch",
      },
      cwd,
      sandbox: "workspace-write",
      signal: new AbortController().signal,
    } as ToolInvocation);
    assert.notEqual(result.exitCode, 0);
    await assert.rejects(readFile(path.join(cwd, "inside")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(path.join(root, "outside")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { ToolEnvironment, InMemoryToolPolicyStore } from "../src/tool.js";
import { testToolRuntime } from "./tool-fixtures.js";

test("restricted calls never reuse or persist capability approvals", async () => {
  const store = new InMemoryToolPolicyStore({ plugin_action: "approved" });
  const environment = new ToolEnvironment({
    policyStore: store,
    runtimes: [
      testToolRuntime({
        name: "plugin_action",
        execute: async (invocation) => ({
          output: invocation.sandbox ?? "missing",
          exitCode: 0,
        }),
      }),
    ],
  });
  let asked = 0;
  for (let index = 0; index < 2; index++) {
    const signal = new AbortController().signal;
    const prepared = environment.prepare({
      name: "plugin_action",
      callId: String(index),
      arguments: {},
      cwd: process.cwd(),
      sandbox: "read-only",
      signal,
    });
    const decision = await environment.admit(prepared, {
      policy: "ask_unknown",
      approvalRequest: {
        threadId: "t",
        turnId: "u",
        itemId: "i",
        callId: String(index),
        command: "plugin_action",
        cwd: process.cwd(),
        signal,
      },
      requestApproval: async () => {
        asked++;
        return "accept";
      },
    });
    assert.equal(decision, "accept");
    assert.equal(
      (await environment.execute(prepared)).output,
      "danger-full-access",
    );
  }
  assert.equal(asked, 2);
  assert.equal(await store.get("plugin_action"), "approved");
});

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { JsonlThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { CodexConnection } from "../src/protocol/codex/connection.js";
import { type JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { compileModelMessages } from "../src/model.js";

test("three permission modes survive journal reload and broadcast to both clients", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-permission-journal-"));
  const host = () =>
    createHostedAppServer({
      cwd: root,
      dataDirectory: root,
      model: "fake",
      models: ["fake"],
      provider: { type: "fake" },
      toolPresentation: "direct",
      approvalPolicy: "never",
      journal: new JsonlThreadJournal(root),
      threadMetadata: new InMemoryThreadMetadataStore(),
    });
  const server = host();
  const messages: JsonRpcMessage[][] = [[], []];
  const clients = messages.map(
    (output) =>
      new CodexConnection({
        appServer: server,
        zenHome: root,
        send: (message) => {
          output.push(message);
        },
      }),
  );
  try {
    for (const client of clients) {
      await client.receive({ id: 1, method: "initialize", params: {} });
      await client.receive({ method: "initialized" });
    }
    const thread = await server.startThread();
    assert.equal(thread.sandbox, "danger-full-access");
    assert.equal(thread.approvalPolicy, "never");
    for (const client of clients)
      await client.receive({
        id: 2,
        method: "thread/resume",
        params: { threadId: thread.id },
      });
    for (const [index, sandbox] of (
      ["read-only", "workspace-write", "danger-full-access"] as const
    ).entries()) {
      await clients[0]!.receive({
        id: 3 + index,
        method: "thread/permissions/update",
        params: { threadId: thread.id, sandbox },
      });
      const reloadedHost = host();
      const restored = await reloadedHost.readThread(thread.id);
      await reloadedHost.closeHostResources();
      assert.equal(restored.sandbox, sandbox);
      assert.equal(
        restored.approvalPolicy,
        sandbox === "danger-full-access" ? "never" : "always",
      );
      assert.equal(
        restored.items.filter(
          (item) => item.type === "thread_configuration_changed",
        ).length,
        index + 1,
      );
    }
    for (const output of messages) {
      const notifications = output.filter(
        (message) =>
          "method" in message && message.method === "thread/settings/updated",
      );
      assert.equal(notifications.length, 3);
      assert.match(JSON.stringify(notifications), /readOnly/);
      assert.match(JSON.stringify(notifications), /workspaceWrite/);
    }
    const restored = await server.readThread(thread.id);
    assert.match(
      JSON.stringify(compileModelMessages(restored.items)),
      /Full Access/,
    );
    await clients[0]!.receive({
      id: 10,
      method: "thread/permissions/update",
      params: { threadId: thread.id, sandbox: "bogus" },
    });
    assert.ok(
      messages[0]!.some(
        (message) => "id" in message && message.id === 10 && "error" in message,
      ),
    );
    await clients[0]!.receive({
      id: 11,
      method: "thread/start",
      params: { sandbox: "read-only" },
    });
    const created = messages[0]!.find(
      (message) => "id" in message && message.id === 11,
    );
    assert.match(JSON.stringify(created), /readOnly/);
  } finally {
    for (const client of clients) client.close();
    await server.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol session approvals cannot authorize later restricted escalations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-permission-session-"));
  const server = createHostedAppServer({
    cwd: root,
    dataDirectory: root,
    model: "fake",
    provider: { type: "fake" },
    toolPresentation: "direct",
    approvalPolicy: "always",
  });
  let approvals = 0;
  let turnDone: (() => void) | undefined;
  let connection: CodexConnection;
  connection = new CodexConnection({
    appServer: server,
    zenHome: root,
    send: (message) => {
      if (
        "method" in message &&
        message.method === "item/commandExecution/requestApproval" &&
        "id" in message
      ) {
        approvals++;
        if (approvals > 1)
          assert.equal(
            (message.params as { approvalScope?: string }).approvalScope,
            "once",
          );
        queueMicrotask(
          () =>
            void connection.receive({
              id: message.id!,
              result: { decision: "acceptForSession" },
            }),
        );
      }
      if ("method" in message && message.method === "turn/completed")
        turnDone?.();
    },
  });
  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    const thread = await server.startThread();
    await connection.receive({
      id: 2,
      method: "thread/resume",
      params: { threadId: thread.id },
    });
    let requestId = 10;
    const run = async (text: string) => {
      const done = new Promise<void>((resolve) => {
        turnDone = resolve;
      });
      await connection.receive({
        id: requestId++,
        method: "turn/start",
        params: { threadId: thread.id, input: [{ type: "text", text }] },
      });
      await done;
    };
    await run("!shell echo first");
    await server.setThreadPermissions(thread.id, "read-only");
    for (let index = 0; index < 2; index++)
      await run(
        '!tool shell {"command":"echo allowed > once","sandbox_permissions":"require_escalated"}',
      );
    assert.equal(approvals, 3);
    await run("!shell echo denied > blocked");
    assert.equal(approvals, 3);
    await assert.rejects(readFile(path.join(root, "blocked")), {
      code: "ENOENT",
    });
  } finally {
    connection.close();
    await server.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});

test("permission changes wait for yielded tool bodies after their turn completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-permission-busy-"));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const environment = new ToolEnvironment({
    runtimes: [
      testToolRuntime({
        name: "slow",
        taskPolicy: { yieldTimeMs: 1 },
        execute: async () => {
          await pending;
          return { output: "done", exitCode: 0 };
        },
      }),
    ],
  });
  const server = createHostedAppServer({
    cwd: root,
    dataDirectory: root,
    model: "fake",
    provider: { type: "fake" },
    toolPresentation: "direct",
    approvalPolicy: "never",
    toolEnvironment: environment,
  });
  try {
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "!tool slow {}")
    ).done;
    await assert.rejects(
      server.setThreadPermissions(thread.id, "read-only"),
      /running turn and tools/,
    );
    assert.equal(
      (await server.readThread(thread.id)).sandbox,
      "danger-full-access",
    );
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      (await server.setThreadPermissions(thread.id, "read-only")).sandbox,
      "read-only",
    );
  } finally {
    release();
    await server.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});

test("Core explicit full sandbox preserves the Host approval default when approval is omitted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-permission-default-"));
  const server = createHostedAppServer({
    cwd: root,
    dataDirectory: root,
    model: "fake",
    provider: { type: "fake" },
    toolPresentation: "direct",
    approvalPolicy: "always",
  });
  try {
    assert.equal(
      (await server.startThread({ sandbox: "danger-full-access" }))
        .approvalPolicy,
      "always",
    );
  } finally {
    await server.closeHostResources();
    await rm(root, { recursive: true, force: true });
  }
});
