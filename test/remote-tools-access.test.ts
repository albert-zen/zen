import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import {
  RemoteHostAccess,
  RemoteHostError,
  type RemoteToolsPort,
} from "../src/protocol/native/remote-host.js";
import {
  REMOTE_TOOL_CAPABILITY,
  type RemoteToolCatalogRequest,
} from "../src/protocol/native/remote-tool-wire.js";

async function fixture(t: TestContext, toolsEnabled = true) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-tools-access-"));
  const app = createHostedAppServer({
    cwd,
    dataDirectory: path.join(cwd, "data"),
    model: "fake",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
  });
  const calls: string[] = [],
    revoked: string[] = [];
  let workspaces = [{ id: "workspace", label: "Work", cwd }];
  let fence: (() => void) | undefined;
  const grantFile = path.join(cwd, "grants.json");
  const tools: RemoteToolsPort = {
    async catalog(request, resolve, peerId) {
      calls.push(peerId);
      fence?.();
      await resolve();
      return {
        version: 1,
        hostId: request.hostId,
        processEpoch: request.processEpoch,
        tools: [],
      };
    },
    async execute() {
      throw new Error("unused");
    },
    async wait() {
      throw new Error("unused");
    },
    async status() {
      throw new Error("unused");
    },
    async cancel() {
      throw new Error("unused");
    },
    revoke(peerId) {
      revoked.push(peerId);
    },
  };
  const options = {
    appServer: app,
    hostId: "target",
    grantFile,
    access: "control" as const,
    shellEnabled: true,
    toolsEnabled,
    tools,
    workspaces: () => workspaces,
  };
  const access = new RemoteHostAccess(options);
  const thread = await app.startThread({ cwd });
  const pair = async (
    deviceId: string,
    optIn?: boolean,
    accessMode: "read" | "control" = "control",
  ) =>
    await access.pair({
      hostId: "target",
      deviceId,
      code: access.createPairingCode(),
      access: accessMode,
      shellEnabled: true,
      ...(optIn === undefined ? {} : { toolsEnabled: optIn }),
    });
  const request = async (
    deviceId: string,
    token: string,
  ): Promise<RemoteToolCatalogRequest> => ({
    version: 1,
    hostId: "target",
    processEpoch: (await access.hello(deviceId, token, "target", 1))
      .processEpoch,
    workspaceId: "workspace",
    targetThreadId: thread.id,
    sourceThreadId: "source",
  });
  t.after(async () => {
    access.close();
    await app.closeHostResources();
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    app,
    access,
    options,
    thread,
    calls,
    revoked,
    pair,
    request,
    grantFile,
    setWorkspaces: () => {
      workspaces = [];
    },
    setFence: (value: () => void) => {
      fence = value;
    },
  };
}
const denied = (code: string) => (error: unknown) =>
  error instanceof RemoteHostError && error.code === code;

test("generic tools require independent host, pairing and control opt-ins", async (t) => {
  const f = await fixture(t);
  for (const [id, optIn, mode] of [
    ["legacy", undefined, "control"],
    ["disabled", false, "control"],
    ["reader", true, "read"],
  ] as const) {
    const p = await f.pair(id, optIn, mode);
    assert.equal(
      (await f.access.hello(id, p.token, "target", 1)).capabilities.includes(
        REMOTE_TOOL_CAPABILITY,
      ),
      false,
    );
    await assert.rejects(
      f.access.toolsCatalog(id, p.token, await f.request(id, p.token)),
      denied("operation_forbidden"),
    );
  }
  const p = await f.pair("tools", true);
  assert.ok(
    (await f.access.hello("tools", p.token, "target", 1)).capabilities.includes(
      REMOTE_TOOL_CAPABILITY,
    ),
  );
  await f.access.toolsCatalog(
    "tools",
    p.token,
    await f.request("tools", p.token),
  );
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!, /^tools:[a-f0-9]{64}$/u);
  assert.equal(
    f.access.devices().find((d) => d.deviceId === "legacy")!.toolsEnabled,
    false,
  );
  const off = await fixture(t, false),
    q = await off.pair("tools", true);
  await assert.rejects(
    off.access.toolsCatalog(
      "tools",
      q.token,
      await off.request("tools", q.token),
    ),
    denied("operation_forbidden"),
  );
});

test("generic gateway fences exact host, epoch, workspace, thread and request fields", async (t) => {
  const f = await fixture(t),
    p = await f.pair("tools", true),
    request = await f.request("tools", p.token);
  for (const [changes, code] of [
    [{ hostId: "other" }, "wrong_host"],
    [{ processEpoch: "old" }, "resync_required"],
    [{ workspaceId: "other" }, "wrong_workspace"],
    [{ targetThreadId: "missing" }, "thread_not_found"],
    [{ deviceId: "attacker" }, "invalid_request"],
    [{ sandbox: "full_access" }, "invalid_request"],
  ] as const)
    await assert.rejects(
      f.access.toolsCatalog("tools", p.token, { ...request, ...changes }),
      denied(code),
    );
  f.setFence(f.setWorkspaces);
  await assert.rejects(
    f.access.toolsCatalog("tools", p.token, request),
    denied("wrong_workspace"),
  );
});

test("generic grants persist explicitly, legacy grants stay disabled and revoke/close notify gateway", async (t) => {
  const f = await fixture(t),
    p = await f.pair("tools", true);
  const stored = JSON.parse(await readFile(f.grantFile, "utf8"));
  assert.equal(stored.devices[0].toolsEnabled, true);
  const restarted = new RemoteHostAccess(f.options);
  t.after(() => restarted.close());
  assert.ok(
    (
      await restarted.hello("tools", p.token, "target", 1)
    ).capabilities.includes(REMOTE_TOOL_CAPABILITY),
  );
  delete stored.devices[0].toolsEnabled;
  await writeFile(f.grantFile, JSON.stringify(stored), { mode: 0o600 });
  const legacy = new RemoteHostAccess(f.options);
  t.after(() => legacy.close());
  assert.equal(
    (await legacy.hello("tools", p.token, "target", 1)).capabilities.includes(
      REMOTE_TOOL_CAPABILITY,
    ),
    false,
  );
  const request = await f.request("tools", p.token);
  f.access.revoke("tools");
  assert.ok(f.revoked.some((peer) => /^tools:[a-f0-9]{64}$/u.test(peer)));
  await assert.rejects(
    f.access.toolsCatalog("tools", p.token, request),
    denied("revoked"),
  );
});
