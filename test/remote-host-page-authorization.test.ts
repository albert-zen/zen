import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import {
  RemoteHostAccess,
  RemoteHostError,
} from "../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../src/protocol/native/remote-transport.js";
import type { RemoteRecoveryPage } from "../src/protocol/native/remote-wire.js";

type Reply = {
  result?: RemoteRecoveryPage;
  error?: { data?: { code?: string } };
};
async function rpc(
  ws: WebSocket,
  id: number,
  method: string,
  params: object,
): Promise<Reply> {
  const response = new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", on);
      reject(new Error(`timeout: ${method}`));
    }, 10_000);
    const on = (raw: unknown) => {
      const value = JSON.parse(String(raw)) as Reply & { id?: number };
      if (value.id !== id) return;
      clearTimeout(timer);
      ws.off("message", on);
      resolve(value);
    };
    ws.on("message", on);
  });
  ws.send(JSON.stringify({ id, method, params }));
  return await response;
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-page-auth-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
  } catch {
    await rm(dir, { recursive: true, force: true });
    t.skip("OpenSSL unavailable");
    return;
  }
  const cert = await readFile(path.join(dir, "cert.pem"));
  const host = createHostedAppServer({
    cwd: dir,
    dataDirectory: path.join(dir, "data"),
    model: "fake",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
  });
  let allowed = true;
  const access = new RemoteHostAccess({
    appServer: host,
    hostId: "desktop",
    workspaces: () =>
      allowed ? [{ id: "demo", cwd: dir, label: "Demo" }] : [],
  });
  const server = await serveRemoteHost({
    enabled: true,
    listen: "127.0.0.1",
    port: 0,
    tls: { cert, key: await readFile(path.join(dir, "key.pem")) },
    access,
  });
  const token = (
    await access.pair({
      hostId: "desktop",
      deviceId: "phone",
      code: access.createPairingCode(),
    })
  ).token;
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const ws = new WebSocket(server.url, {
      ca: cert,
      headers: { Authorization: `Bearer ${token}`, "x-zen-device-id": "phone" },
    });
    sockets.push(ws);
    await once(ws, "open");
    assert(
      (await rpc(ws, 1, "zen/remote/hello", { hostId: "desktop", version: 1 }))
        .result,
    );
    return ws;
  };
  return {
    dir,
    token,
    host,
    access,
    server,
    connect,
    allow(value: boolean) {
      allowed = value;
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await server.close();
      access.close();
      await host.closeHostResources();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function createHistory(
  f: NonNullable<Awaited<ReturnType<typeof fixture>>>,
  count = 12,
) {
  const thread = await f.host.startThread({
    cwd: f.dir,
    sandbox: "read-only",
    approvalPolicy: "always",
  });
  for (let n = 0; n < count; n++)
    await (
      await f.host.startTurn(thread.id, `scope-${n} ${"x".repeat(29000)}`)
    ).done;
  return thread;
}

test("cached page and fresh cursor both reject a removed dynamic workspace; valid terminal retry remains identical", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  try {
    const thread = await createHistory(f);
    const ws = await f.connect();
    const first = await rpc(ws, 2, "zen/remote/resume", {
      workspaceId: "demo",
      threadId: thread.id,
    });
    assert(first.result?.nextCursor);
    const used = first.result.nextCursor;
    const second = await rpc(ws, 3, "zen/remote/resume/page", { cursor: used });
    assert(second.result?.nextCursor);
    f.allow(false);
    const duplicate = await rpc(ws, 4, "zen/remote/resume/page", {
      cursor: used,
    });
    assert.equal(duplicate.error?.data?.code, "wrong_workspace");
    assert.equal(
      duplicate.result,
      undefined,
      "revocation must not replay cached public text",
    );
    const fresh = await rpc(ws, 5, "zen/remote/resume/page", {
      cursor: second.result.nextCursor,
    });
    assert.equal(
      fresh.error?.data?.code,
      "stale_cursor",
      "lost scope clears the old cursor and barrier",
    );
    f.allow(true);
    assert.equal(
      (await rpc(ws, 6, "zen/remote/resume/page", { cursor: used })).error?.data
        ?.code,
      "stale_cursor",
      "regrant must not revive an old cursor",
    );
    let current = (
      await rpc(ws, 7, "zen/remote/resume", {
        workspaceId: "demo",
        threadId: thread.id,
      })
    ).result;
    assert(current?.nextCursor);
    let terminalCursor: string | undefined;
    for (let n = 8; current?.nextCursor && n < 100; n++) {
      terminalCursor = current.nextCursor;
      const next = await rpc(ws, n, "zen/remote/resume/page", {
        cursor: terminalCursor,
      });
      assert(next.result, JSON.stringify(next.error));
      current = next.result;
    }
    assert(current && current.nextCursor === null && terminalCursor);
    const repeated = await rpc(ws, 108, "zen/remote/resume/page", {
      cursor: terminalCursor,
    });
    assert.deepEqual(
      repeated.result,
      current,
      "authorized terminal-page retry replays exactly the same bounded page",
    );
    assert.equal(
      (await rpc(ws, 109, "zen/remote/resume/page", { cursor: "not-issued" }))
        .error?.data?.code,
      "stale_cursor",
    );
    f.allow(false);
    const deniedTerminal = await rpc(ws, 110, "zen/remote/resume/page", {
      cursor: terminalCursor,
    });
    assert.equal(deniedTerminal.error?.data?.code, "wrong_workspace");
    assert.equal(deniedTerminal.result, undefined);
  } finally {
    await f.close();
  }
});

test("Thread cwd change blocks previous-page and fresh cursor; device revocation and epoch fences persist", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  try {
    const thread = await createHistory(f);
    const ws = await f.connect();
    const first = await rpc(ws, 2, "zen/remote/resume", {
      workspaceId: "demo",
      threadId: thread.id,
    });
    assert(first.result?.nextCursor);
    const used = first.result.nextCursor;
    const second = await rpc(ws, 3, "zen/remote/resume/page", { cursor: used });
    assert(second.result?.nextCursor);
    const other = path.join(f.dir, "other");
    await mkdir(other);
    const read = f.host.readThread.bind(f.host);
    f.host.readThread = async (id) => {
      const view = await read(id);
      return id === thread.id ? { ...view, cwd: other } : view;
    };
    assert.equal(
      (await rpc(ws, 4, "zen/remote/resume/page", { cursor: used })).error?.data
        ?.code,
      "wrong_workspace",
    );
    assert.equal(
      (
        await rpc(ws, 5, "zen/remote/resume/page", {
          cursor: second.result.nextCursor,
        })
      ).error?.data?.code,
      "stale_cursor",
    );
    f.host.readThread = read;
    const resumed = await rpc(ws, 6, "zen/remote/resume", {
      workspaceId: "demo",
      threadId: thread.id,
    });
    assert(resumed.result?.nextCursor);
    // The recovery epoch is Host-owned; a foreign epoch must not authorize a page.
    const oldEpoch = await f.access.beginRecovery(
      "phone",
      f.token,
      "demo",
      thread.id,
    );
    await assert.rejects(
      f.access.recoveryThread("phone", f.token, "demo", {
        ...oldEpoch.boundary,
        processEpoch: "old-process",
      }),
      (e: unknown) =>
        e instanceof RemoteHostError && e.code === "resync_required",
    );
    const closed = once(ws, "close");
    f.access.revoke("phone");
    await closed;
    assert.equal(ws.readyState, WebSocket.CLOSED);
  } finally {
    await f.close();
  }
});

test("removing scope during a cached-page authorization read cannot publish old content", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  let release = () => {};
  try {
    const thread = await createHistory(f);
    const ws = await f.connect();
    const first = await rpc(ws, 2, "zen/remote/resume", {
      workspaceId: "demo",
      threadId: thread.id,
    });
    assert(first.result?.nextCursor);
    const used = first.result.nextCursor;
    const second = await rpc(ws, 3, "zen/remote/resume/page", { cursor: used });
    assert(second.result?.nextCursor);
    const read = f.host.readThread.bind(f.host);
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed = false;
    f.host.readThread = async (id) => {
      if (id === thread.id && !delayed) {
        delayed = true;
        entered();
        await held;
      }
      return await read(id);
    };
    const retry = rpc(ws, 4, "zen/remote/resume/page", { cursor: used });
    await waiting;
    f.allow(false);
    release();
    const denied = await retry;
    assert.equal(denied.result, undefined);
    assert.equal(denied.error?.data?.code, "wrong_workspace");
    assert.equal(
      (
        await rpc(ws, 5, "zen/remote/resume/page", {
          cursor: second.result.nextCursor,
        })
      ).error?.data?.code,
      "stale_cursor",
    );
  } finally {
    release();
    await f.close();
  }
});

test("an authorization read completing after another resume never replays the old cached page", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  try {
    const old = await createHistory(f);
    const current = await f.host.startThread({
      cwd: f.dir,
      sandbox: "read-only",
      approvalPolicy: "always",
    });
    const ws = await f.connect();
    const first = await rpc(ws, 2, "zen/remote/resume", {
      workspaceId: "demo",
      threadId: old.id,
    });
    assert(first.result?.nextCursor);
    const used = first.result.nextCursor;
    assert(
      (await rpc(ws, 3, "zen/remote/resume/page", { cursor: used })).result
        ?.nextCursor,
    );
    const read = f.host.readThread.bind(f.host);
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed = false;
    f.host.readThread = async (id) => {
      if (id === old.id && !delayed) {
        delayed = true;
        enter();
        await held;
      }
      return await read(id);
    };
    const retry = rpc(ws, 4, "zen/remote/resume/page", { cursor: used });
    await entered;
    const latest = await rpc(ws, 5, "zen/remote/resume", {
      workspaceId: "demo",
      threadId: current.id,
    });
    assert.equal(latest.result?.thread.id, current.id);
    release();
    const result = await retry;
    assert.equal(result.error?.data?.code, "stale_cursor");
    assert.equal(result.result, undefined);
    assert.equal(
      (await rpc(ws, 6, "zen/remote/resume/page", { cursor: used })).error?.data
        ?.code,
      "stale_cursor",
    );
  } finally {
    await f.close();
  }
});
