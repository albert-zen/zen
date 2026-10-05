import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  InMemoryToolPolicyStore,
} from "../../../src/tool.js";
import {
  RemoteHostAccess,
  RemoteHostError,
} from "../../../src/protocol/native/remote-host.js";
import { ToolOutputSpool } from "../../../src/tool-output-spool.js";
import { FleetShellGateway } from "../src/main/fleet-shell.js";

test("Fleet shell executes in the target Thread without creating a target turn or Items", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "zen-fleet-shell-"));
  const tools = new ToolEnvironment({ runtimes: [new ShellToolRuntime()] });
  const app = createHostedAppServer({
    dataDirectory: cwd,
    cwd,
    provider: { type: "fake" },
    model: "fake",
    toolEnvironment: tools,
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
  });
  const gateway = new FleetShellGateway(tools);
  const host = new RemoteHostAccess({
    appServer: app,
    hostId: "target",
    access: "control",
    shellEnabled: true,
    shell: gateway,
    workspaces: () => [{ id: "workspace", label: "fixture", cwd }],
  });
  try {
    const thread = await app.startThread({ cwd });
    const before = await app.readThread(thread.id);
    const paired = await host.pair({
      hostId: "target",
      deviceId: "caller",
      code: host.createPairingCode(),
      access: "control",
      shellEnabled: true,
    });
    const result = await host.shell(
      "caller",
      paired.token,
      {
        workspaceId: "workspace",
        targetThreadId: thread.id,
        command: "printf '%s' \"$PWD\"",
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      },
      new AbortController().signal,
    );
    assert.equal(result.output, cwd);
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, "completed");
    const after = await app.readThread(thread.id);
    assert.deepEqual(after.items, before.items);
    assert.deepEqual(after.turns, before.turns);
  } finally {
    host.close();
    await app.closeHostResources();
    await tools.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function fixture(
  t: import("node:test").TestContext,
  options: {
    policy?: "always" | "never";
    stored?: "approved" | "denied";
    shellEnabled?: boolean;
    access?: "read" | "control";
  } = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "zen-fleet-shell-"));
  const tools = new ToolEnvironment({
    runtimes: [new ShellToolRuntime({ terminationGraceMs: 50 })],
    policyStore: new InMemoryToolPolicyStore(
      options.stored ? { shell: options.stored } : {},
    ),
  });
  const app = createHostedAppServer({
    cwd,
    dataDirectory: path.join(cwd, "data"),
    provider: { type: "fake" },
    model: "fake",
    journal: new InMemoryThreadJournal(),
    toolEnvironment: tools,
    approvalPolicy: options.policy ?? "never",
  });
  const gateway = new FleetShellGateway(tools);
  const host = new RemoteHostAccess({
    appServer: app,
    hostId: "target",
    access: options.access ?? "control",
    shellEnabled: options.shellEnabled ?? true,
    shell: gateway,
    grantFile: path.join(cwd, "grants.json"),
    workspaces: () => [{ id: "workspace", label: "fixture", cwd }],
  });
  const thread = await app.startThread({ cwd });
  t.after(async () => {
    host.close();
    await app.closeHostResources();
    await tools.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const pair = (
    shellEnabled?: boolean,
    access: "read" | "control" = "control",
  ) =>
    host.pair({
      hostId: "target",
      deviceId: "caller",
      code: host.createPairingCode(),
      access,
      ...(shellEnabled === undefined ? {} : { shellEnabled }),
    });
  const request = {
    workspaceId: "workspace",
    targetThreadId: thread.id,
    command: "printf okay",
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  };
  return { cwd, tools, app, host, thread, gateway, pair, request };
}
const rejectsCode = (code: string) => (error: unknown) =>
  error instanceof RemoteHostError && error.code === code;

test("shell needs both target Host opt-in and a distinct control-device shell grant", async (t) => {
  for (const entry of [
    { host: false, device: true, access: "control" as const },
    { host: true, device: undefined, access: "control" as const },
    { host: true, device: false, access: "control" as const },
    { host: true, device: true, access: "read" as const },
  ]) {
    const f = await fixture(t, { shellEnabled: entry.host });
    const paired = await f.pair(entry.device, entry.access);
    await assert.rejects(
      f.host.shell(
        "caller",
        paired.token,
        f.request,
        new AbortController().signal,
      ),
      rejectsCode("operation_forbidden"),
    );
    const hello = await f.host.hello("caller", paired.token, "target", 1);
    assert.equal(hello.capabilities.includes("shell"), false);
    assert.equal(f.tools.taskManager.activeTaskCount, 0);
  }
});

test("revoked, missing, archived and wrong-workspace targets fail before shell effects", async (t) => {
  const f = await fixture(t);
  const paired = await f.pair(true);
  await assert.rejects(
    f.host.shell(
      "caller",
      paired.token,
      { ...f.request, targetThreadId: "stale-thread" },
      new AbortController().signal,
    ),
    rejectsCode("thread_not_found"),
  );
  await assert.rejects(
    f.host.shell(
      "caller",
      paired.token,
      { ...f.request, workspaceId: "other" },
      new AbortController().signal,
    ),
    rejectsCode("wrong_workspace"),
  );
  const other = await mkdtemp(path.join(os.tmpdir(), "fleet-other-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  const otherThread = await f.app.startThread({ cwd: other });
  await assert.rejects(
    f.host.shell(
      "caller",
      paired.token,
      { ...f.request, targetThreadId: otherThread.id },
      new AbortController().signal,
    ),
    rejectsCode("wrong_workspace"),
  );
  await f.app.setThreadArchived(f.thread.id, true);
  await assert.rejects(
    f.host.shell(
      "caller",
      paired.token,
      f.request,
      new AbortController().signal,
    ),
    rejectsCode("stale_thread"),
  );
  f.host.revoke("caller");
  await assert.rejects(
    f.host.shell(
      "caller",
      paired.token,
      f.request,
      new AbortController().signal,
    ),
    rejectsCode("revoked"),
  );
  assert.equal(f.tools.taskManager.activeTaskCount, 0);
});

test("target remembered denial wins even under full access", async (t) => {
  const f = await fixture(t, { stored: "denied", policy: "never" });
  const paired = await f.pair(true);
  await assert.rejects(
    f.host.shell(
      "caller",
      paired.token,
      f.request,
      new AbortController().signal,
    ),
    rejectsCode("operation_forbidden"),
  );
  assert.equal(f.tools.taskManager.activeTaskCount, 0);
});

test("target remembered approval is honored, while unknown target approval fails closed without a UI route", async (t) => {
  const unknown = await fixture(t, { policy: "always" });
  const unknownPair = await unknown.pair(true);
  await assert.rejects(
    unknown.host.shell(
      "caller",
      unknownPair.token,
      unknown.request,
      new AbortController().signal,
    ),
    (error: unknown) =>
      rejectsCode("approval_required")(error) &&
      /target Host.*Fleet shell cannot answer/.test((error as Error).message),
  );
  assert.equal(unknown.tools.taskManager.activeTaskCount, 0);
  const approved = await fixture(t, { policy: "always", stored: "approved" });
  const approvedPair = await approved.pair(true);
  const result = await approved.host.shell(
    "caller",
    approvedPair.token,
    approved.request,
    new AbortController().signal,
  );
  assert.equal(result.output, "okay");
});

test("shell invocation uses target permission snapshot and rejects permissions changed during admission", async (t) => {
  const f = await fixture(t);
  let resolves = 0;
  await assert.rejects(
    f.gateway.execute(
      f.request,
      async () => {
        if (++resolves === 2)
          await f.app.setThreadPermissions(f.thread.id, "read-only");
        return await f.app.readThread(f.thread.id);
      },
      new AbortController().signal,
    ),
    rejectsCode("stale_thread"),
  );
  assert.equal(f.tools.taskManager.activeTaskCount, 0);
});

async function processStarted(file: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(file, "utf8"));
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Fixture shell never started");
}
function assertStopped(pid: number) {
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
}

test("shell deadline confirms process cleanup and returns a terminal timeout", async (t) => {
  const f = await fixture(t);
  const paired = await f.pair(true);
  const pidFile = path.join(f.cwd, "pid");
  const done = f.host.shell(
    "caller",
    paired.token,
    {
      ...f.request,
      command: `printf '%s' $$ > '${pidFile}'; sleep 20`,
      timeoutMs: 150,
    },
    new AbortController().signal,
  );
  const pid = await processStarted(pidFile);
  const result = await done;
  assert.equal(result.status, "timed_out");
  assert.equal(result.exitCode, 124);
  assertStopped(pid);
  assert.equal(f.tools.taskManager.activeTaskCount, 0);
});

test("caller cancellation and target grant revocation stop the admitted process", async (t) => {
  for (const action of ["cancel", "revoke"]) {
    const f = await fixture(t);
    const paired = await f.pair(true);
    const controller = new AbortController();
    const pidFile = path.join(f.cwd, "pid");
    const done = f.host.shell(
      "caller",
      paired.token,
      {
        ...f.request,
        command: `printf '%s' $$ > '${pidFile}'; sleep 20`,
        timeoutMs: 3000,
      },
      controller.signal,
    );
    const pid = await processStarted(pidFile);
    if (action === "cancel") controller.abort();
    else f.host.revoke("caller");
    const result = await done;
    assert.equal(result.status, "cancelled");
    assert.equal(result.exitCode, 130);
    assertStopped(pid);
    assert.equal(f.tools.taskManager.activeTaskCount, 0);
  }
});

test("command, deadline and output limits are enforced with existing shell output capture", async (t) => {
  const f = await fixture(t);
  const paired = await f.pair(true);
  for (const invalid of [
    { command: "x".repeat(32769) },
    { timeoutMs: 120001 },
    { maxOutputBytes: 65537 },
    { command: "x\0y" },
  ])
    await assert.rejects(
      f.host.shell(
        "caller",
        paired.token,
        { ...f.request, ...invalid },
        new AbortController().signal,
      ),
      rejectsCode("invalid_request"),
    );
  const result = await f.host.shell(
    "caller",
    paired.token,
    { ...f.request, command: "printf 1234567890", maxOutputBytes: 4 },
    new AbortController().signal,
  );
  assert.equal(result.output, "1234");
  assert.equal(result.sourceTruncated, true);
});

test("shell grants persist, but pre-shell legacy grant files stay denied after restart", async (t) => {
  const f = await fixture(t);
  const paired = await f.pair(true);
  const file = path.join(f.cwd, "grants.json");
  const config = {
    appServer: f.app,
    hostId: "target",
    access: "control" as const,
    shellEnabled: true,
    shell: f.gateway,
    grantFile: file,
    workspaces: () => [{ id: "workspace", label: "fixture", cwd: f.cwd }],
  };
  f.host.close();
  const restored = new RemoteHostAccess(config);
  t.after(() => restored.close());
  assert.equal(
    (
      await restored.shell(
        "caller",
        paired.token,
        f.request,
        new AbortController().signal,
      )
    ).output,
    "okay",
  );
  restored.close();
  const grants = JSON.parse(await readFile(file, "utf8"));
  delete grants.devices[0].shellEnabled;
  await writeFile(file, JSON.stringify(grants));
  const legacy = new RemoteHostAccess(config);
  t.after(() => legacy.close());
  await assert.rejects(
    legacy.shell(
      "caller",
      paired.token,
      f.request,
      new AbortController().signal,
    ),
    rejectsCode("operation_forbidden"),
  );
});

test("spooled target shell output uses the existing bounded preview without exporting target spool paths", async (t) => {
  const f = await fixture(t);
  const spool = new ToolOutputSpool({
    rootDirectory: path.join(f.cwd, "output"),
    maxCaptureBytes: 1024,
    previewBytes: 4,
  });
  const tools = new ToolEnvironment({
    runtimes: [new ShellToolRuntime({ toolOutputSpool: spool })],
    toolOutputSpool: spool,
  });
  t.after(async () => {
    await tools.close();
    await spool.close();
  });
  const gateway = new FleetShellGateway(tools);
  const result = await gateway.execute(
    { ...f.request, command: "printf 0123456789", maxOutputBytes: 4 },
    () => f.app.readThread(f.thread.id),
    new AbortController().signal,
  );
  assert.equal(result.output, "0189");
  assert.equal(result.sourceTruncated, true);
  assert.equal(Buffer.byteLength(result.output), 4);
  assert.equal(JSON.stringify(result).includes(f.cwd), false);
});

test("an unavailable spool does not duplicate overlapping short output previews", async (t) => {
  const f = await fixture(t);
  const unavailable = path.join(f.cwd, "not-a-directory");
  await writeFile(unavailable, "fixture");
  const spool = new ToolOutputSpool({
    rootDirectory: unavailable,
    previewBytes: 1024,
  });
  const tools = new ToolEnvironment({
    runtimes: [new ShellToolRuntime({ toolOutputSpool: spool })],
    toolOutputSpool: spool,
  });
  t.after(async () => {
    await tools.close();
    await spool.close();
  });
  const result = await new FleetShellGateway(tools).execute(
    { ...f.request, command: "printf 'hello-preview'", maxOutputBytes: 1024 },
    () => f.app.readThread(f.thread.id),
    new AbortController().signal,
  );
  assert.equal(result.output, "hello-preview");
  // A lost spool is still reported conservatively; do not hide source uncertainty.
  assert.equal(result.sourceTruncated, true);
});
