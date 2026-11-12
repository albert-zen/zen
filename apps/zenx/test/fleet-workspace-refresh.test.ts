import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createHostedAppServer } from "../../cli/src/host.js";
import {
  InMemoryThreadJournal,
  type ThreadJournal,
} from "../../../src/journal.js";
import type { AppServerManager } from "../src/main/app-server-manager.js";
import { FleetHostService } from "../src/main/fleet-host.js";
import { FleetSettingsService } from "../src/main/fleet-settings.js";
import type { NativeFleetDevice } from "../src/main/fleet.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function until(check: () => boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert(check(), "Expected canonical subscription state did not arrive");
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-workspace-"));
  const a = path.join(directory, "a"),
    b = path.join(directory, "b");
  await mkdir(a);
  await mkdir(b);
  const key = path.join(directory, "key.pem"),
    cert = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  await chmod(key, 0o600);
  const memory = new InMemoryThreadJournal();
  let completionBarrier: (() => Promise<void>) | undefined;
  const journal: ThreadJournal = {
    read: (id) => memory.read(id),
    create: (items) => memory.create(items),
    listThreadIds: () => memory.listThreadIds(),
    append: async (item) => {
      if (item.type === "turn_completed") await completionBarrier?.();
      await memory.append(item);
    },
  };
  const host = createHostedAppServer({
    cwd: a,
    dataDirectory: path.join(directory, "data"),
    model: "fake",
    provider: { type: "fake" },
    journal,
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  const gateway = new FleetHostService(host, {
    request: async () => ({ rooms: [] }),
    subscribe: () => () => {},
  });
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await gateway.close();
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  });
  let configured = [
    { cwd: a, label: "A" },
    { cwd: b, label: "B" },
  ];
  let resolver: (() => Promise<void>) | undefined;
  let epoch = "one";
  let rpcFailure: ((action: string, input: unknown) => boolean) | undefined;
  let stopped = false;
  const calls: Array<{ action: string; input: unknown }> = [];
  const manager = {
    get processEpoch() {
      return stopped ? undefined : epoch;
    },
    currentConfiguration: async () => ({ processEpoch: epoch }),
    fleetControl: async (action: string, input?: unknown) => {
      calls.push({ action, input });
      if (rpcFailure?.(action, input))
        throw new Error("fixture control RPC unavailable");
      return await gateway.control(action, input);
    },
    stop: async () => {
      stopped = true;
      await gateway.close();
    },
  };
  let selectedManager = manager;
  const service = new FleetSettingsService({
    directory,
    nativeCa: await readFile(cert),
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
    },
    manager: () => selectedManager as unknown as AppServerManager,
    workspaces: async () => {
      const captured = structuredClone(configured);
      await resolver?.();
      return captured;
    },
  });
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  await service.save({
    version: 1,
    devices: [],
    hosting: {
      enabled: true,
      bindAddress: "127.0.0.1",
      port,
      tlsCertificateFile: cert,
      tlsKeyFile: key,
      access: "control",
    },
  });
  const peer: NativeFleetDevice = {
    id: "remote",
    label: "Remote",
    transport: "https",
    endpoint: gateway.status().url!,
    hostId: gateway.status().hostId,
    access: "control",
  };
  const pairing = (await service.hostPair()) as { code: string };
  await service.pair({ ...peer, code: pairing.code });
  async function connect() {
    const credential = (await service.native.options.credentials.get(peer.id))!;
    const url = new URL("/remote", peer.endpoint);
    url.protocol = "wss:";
    const socket = new WebSocket(url, {
      ca: await readFile(cert),
      rejectUnauthorized: true,
      headers: {
        authorization: `Bearer ${credential.token}`,
        "x-zen-device-id": credential.deviceId,
        "x-zen-host-id": peer.hostId,
      },
    });
    sockets.add(socket);
    await once(socket, "open");
    let next = 0;
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    socket.on("message", (raw) => {
      const value = JSON.parse(raw.toString());
      const request = pending.get(value.id);
      if (!request) return;
      pending.delete(value.id);
      clearTimeout(request.timer);
      if (value.error) request.reject(new Error(value.error.message));
      else request.resolve(value.result);
    });
    socket.on("close", () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("fixture socket closed"));
      }
      pending.clear();
    });
    function rpc(method: string, params: unknown = {}): Promise<any> {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("fixture RPC timed out"));
        }, 3000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    }
    const hello = await rpc("zen/remote/hello", {
      version: 1,
      hostId: peer.hostId,
    });
    return { rpc, hello, socket };
  }
  const remote = await connect();
  const workspaces = (await remote.rpc("zen/remote/workspaces"))
    .workspaces as Array<{ id: string; label: string }>;
  return {
    service,
    host,
    gateway,
    manager,
    directory,
    a,
    b,
    peer,
    remote,
    connect,
    calls,
    aId: workspaces.find((w) => w.label === "A")!.id,
    bId: workspaces.find((w) => w.label === "B")!.id,
    configure: (value: typeof configured) => {
      configured = value;
    },
    resolveWith: (value: typeof resolver) => {
      resolver = value;
    },
    epoch: (value: string) => {
      epoch = value;
    },
    failRpc: (value: typeof rpcFailure) => {
      rpcFailure = value;
    },
    replaceManager: () => {
      selectedManager = { ...manager };
    },
    stopped: () => stopped,
    completeWith: (value: typeof completionBarrier) => {
      completionBarrier = value;
    },
  };
}

test(
  "same-epoch workspace removal revokes old TLS read/create and retains unaffected Agents without gateway restart",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const removed = await f.remote.rpc("zen/remote/create", {
      workspaceId: f.bId,
    });
    const retained = await f.remote.rpc("zen/remote/create", {
      workspaceId: f.aId,
    });
    const turn = await f.host.startTurn(retained.id, "Retain this Agent");
    await turn.done;
    const before = await f.host.readThread(retained.id);
    f.configure([{ cwd: f.a, label: "A renamed" }]);
    await f.service.restore();
    assert.deepEqual((await f.remote.rpc("zen/remote/workspaces")).workspaces, [
      { id: f.aId, label: "A renamed" },
    ]);
    await assert.rejects(
      f.remote.rpc("zen/remote/create", { workspaceId: f.bId }),
      /wrong_workspace/,
    );
    await assert.rejects(
      f.remote.rpc("zen/remote/resume", {
        workspaceId: f.bId,
        threadId: removed.id,
      }),
      /wrong_workspace/,
    );
    const resumed = await f.remote.rpc("zen/remote/resume", {
      workspaceId: f.aId,
      threadId: retained.id,
    });
    assert.equal(resumed.thread.id, retained.id);
    assert.equal(resumed.processEpoch, f.remote.hello.processEpoch);
    await f.service.refreshWorkspaces(); // Same list / ordinary use refresh.
    const labelOnly = await f.service.config();
    labelOnly.devices[0]!.label = "Remote renamed";
    await f.service.save(labelOnly, labelOnly.revision);
    assert.equal(f.calls.filter((c) => c.action === "configure").length, 1);
    assert.deepEqual(
      (await f.host.readThread(retained.id)).items,
      before.items,
    );
    assert.equal(f.gateway.status().url, f.peer.endpoint);
  },
);

for (const superseded of [false, true])
  test(
    `retained TLS workspace watch reconnects through ${superseded ? "superseded and " : ""}held scope refresh and recovers its completion exactly once; removed scope stops`,
    { timeout: 20_000 },
    async (t) => {
      const f = await fixture(t);
      const completionEntered = deferred(),
        complete = deferred();
      const refreshEntered = deferred(),
        refreshRelease = deferred();
      const oldEntered = deferred(),
        oldRelease = deferred();
      const controller = new AbortController();
      let completionsWaiting = 0;
      f.completeWith(async () => {
        if (++completionsWaiting === 2) completionEntered.resolve();
        await complete.promise;
      });
      const a = await f.host.startThread({ cwd: f.a });
      const b = await f.host.startThread({ cwd: f.b });
      const aTurn = await f.host.startTurn(a.id, "A source task");
      const bTurn = await f.host.startTurn(b.id, "B source task");
      await completionEntered.promise;
      const aEvents: unknown[] = [],
        bEvents: unknown[] = [];
      const aErrors: string[] = [],
        bErrors: string[] = [];
      let aReady = 0,
        bReady = 0;
      try {
        const stopA = await f.service.native.subscribeThread(
          f.peer,
          f.aId,
          a.id,
          {
            includeCurrentTerminal: false,
            onTurn: (event) => aEvents.push(event),
            onError: (error) => aErrors.push(error.message),
            onReady: () => ++aReady,
          },
          controller.signal,
        );
        const stopB = await f.service.native.subscribeThread(
          f.peer,
          f.bId,
          b.id,
          {
            includeCurrentTerminal: false,
            onTurn: (event) => bEvents.push(event),
            onError: (error) => bErrors.push(error.message),
            onReady: () => ++bReady,
          },
          controller.signal,
        );
        t.after(stopA);
        t.after(stopB);
        f.configure([{ cwd: f.a, label: "A" }]);
        let resolutions = 0;
        f.resolveWith(async () => {
          if (superseded && ++resolutions === 1) {
            oldEntered.resolve();
            await oldRelease.promise;
            return;
          }
          refreshEntered.resolve();
          await refreshRelease.promise;
        });
        let refreshing: Promise<void>;
        if (superseded) {
          const oldRefresh = f.service.refreshWorkspaces();
          const obsolete = assert.rejects(
            oldRefresh,
            /scope changed.*newer workspace refresh pending/,
          );
          await oldEntered.promise;
          f.configure([{ cwd: f.a, label: "A latest" }]);
          refreshing = f.service.refreshWorkspaces();
          oldRelease.resolve();
          await obsolete;
        } else refreshing = f.service.refreshWorkspaces();
        await refreshEntered.promise;
        await assert.rejects(
          f.remote.rpc("zen/remote/create", { workspaceId: f.aId }),
          /scope_refreshing/,
        );
        complete.resolve();
        await Promise.all([aTurn.done, bTurn.done]);
        await until(
          () =>
            aErrors.some((error) => error.includes("scope_refreshing")) &&
            bErrors.some((error) => error.includes("scope_refreshing")),
        );
        assert.deepEqual(aEvents, []);
        assert.deepEqual(bEvents, []);
        // Hold through a reconnect attempt too: pending remains transient, and
        // the observed active Turn identity survives read-only reconnect.
        await new Promise((resolve) => setTimeout(resolve, 1150));
        assert.equal(aReady, 1);
        refreshRelease.resolve();
        await refreshing;
        await until(
          () =>
            aReady === 2 &&
            aEvents.length === 1 &&
            bErrors.some((error) => error.includes("wrong_workspace")),
        );
        assert.deepEqual(aEvents, [
          { threadId: a.id, turnId: aTurn.id, status: "completed" },
        ]);
        assert.deepEqual(bEvents, []);
        assert.equal(bReady, 1);
        assert.equal(
          f.calls.filter((call) => call.action === "configure").length,
          1,
        );
        await assert.rejects(
          f.remote.rpc("zen/remote/resume", {
            workspaceId: f.bId,
            threadId: b.id,
          }),
          /wrong_workspace/,
        );
        await assert.rejects(
          f.remote.rpc("zen/remote/create", { workspaceId: f.bId }),
          /wrong_workspace/,
        );
        f.completeWith(undefined);
        f.resolveWith(undefined);
        f.configure([
          { cwd: f.a, label: "A" },
          { cwd: f.b, label: "B" },
        ]);
        await f.service.refreshWorkspaces();
        const laterB = await f.host.startTurn(
          b.id,
          "A removed watch must not silently resume",
        );
        await laterB.done;
        await new Promise((resolve) => setTimeout(resolve, 1150));
        assert.equal(bReady, 1);
        assert.deepEqual(bEvents, []);
        assert.equal(aEvents.length, 1);
      } finally {
        complete.resolve();
        refreshRelease.resolve();
        oldRelease.resolve();
        controller.abort();
      }
    },
  );

test(
  "workspace refresh clears old scope before a blocked resolver and reports resolution failure without restart",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const entered = deferred(),
      release = deferred();
    f.resolveWith(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("fixture missing Project path");
    });
    const refreshing = f.service.refreshWorkspaces();
    const failure = assert.rejects(
      refreshing,
      /missing Project path.*Remote workspace access disabled/,
    );
    await entered.promise;
    await assert.rejects(
      f.remote.rpc("zen/remote/workspaces"),
      /scope_refreshing/,
    );
    await assert.rejects(
      f.remote.rpc("zen/remote/create", { workspaceId: f.bId }),
      /scope_refreshing/,
    );
    release.resolve();
    await failure;
    assert.equal(f.gateway.status().enabled, true);
    assert.equal(f.calls.filter((c) => c.action === "configure").length, 1);
    assert.match(
      String((await f.service.status()).host.error),
      /gateway remains running/,
    );
    f.resolveWith(undefined);
    f.configure([{ cwd: f.a, label: "A" }]);
    await f.service.refreshWorkspaces();
    assert.equal((await f.service.status()).host.error, undefined);
    assert.deepEqual((await f.remote.rpc("zen/remote/workspaces")).workspaces, [
      { id: f.aId, label: "A" },
    ]);
  },
);

test(
  "a newer Project refresh invalidates a blocked old allowlist before it can restore removed access",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const removed = await f.remote.rpc("zen/remote/create", {
      workspaceId: f.bId,
    });
    const oldEntered = deferred(),
      oldRelease = deferred();
    const newEntered = deferred(),
      newRelease = deferred();
    let resolutions = 0;
    f.resolveWith(async () => {
      if (++resolutions === 1) {
        oldEntered.resolve();
        await oldRelease.promise;
      } else {
        newEntered.resolve();
        await newRelease.promise;
      }
    });
    const oldRefresh = f.service.refreshWorkspaces();
    const obsolete = assert.rejects(
      oldRefresh,
      /workspace scope changed.*Remote workspace access disabled/,
    );
    await oldEntered.promise;
    f.configure([{ cwd: f.a, label: "A" }]);
    const newRefresh = f.service.refreshWorkspaces();
    oldRelease.resolve();
    await obsolete;
    await newEntered.promise;
    assert.equal(
      f.calls.filter((call) => call.action === "workspaces").length,
      0,
      "An obsolete refresh must not permanently clear scope between queued generations",
    );
    await assert.rejects(
      f.remote.rpc("zen/remote/workspaces"),
      /scope_refreshing/,
    );
    await assert.rejects(
      f.remote.rpc("zen/remote/resume", {
        workspaceId: f.bId,
        threadId: removed.id,
      }),
      /scope_refreshing/,
    );
    await assert.rejects(
      f.remote.rpc("zen/remote/create", { workspaceId: f.bId }),
      /scope_refreshing/,
    );
    assert.equal(f.calls.filter((c) => c.action === "configure").length, 1);
    newRelease.resolve();
    await newRefresh;
    assert.deepEqual((await f.remote.rpc("zen/remote/workspaces")).workspaces, [
      { id: f.aId, label: "A" },
    ]);
    assert.equal((await f.service.status()).host.error, undefined);
  },
);

test(
  "failed replacement acknowledgement cannot preserve the old allowlist on the live TLS gateway",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    f.configure([{ cwd: f.a, label: "A" }]);
    f.failRpc(
      (action, input) =>
        action === "workspaces" && Array.isArray(input) && input.length > 0,
    );
    await assert.rejects(
      f.service.refreshWorkspaces(),
      /RPC unavailable.*gateway remains running/,
    );
    assert.deepEqual(
      (await f.remote.rpc("zen/remote/workspaces")).workspaces,
      [],
    );
    await assert.rejects(
      f.remote.rpc("zen/remote/create", { workspaceId: f.bId }),
      /wrong_workspace/,
    );
    assert.equal(f.gateway.status().enabled, true);
    assert.equal(f.calls.filter((c) => c.action === "configure").length, 1);
  },
);

test(
  "an unacknowledged workspace update fails closed and reports gateway or Host shutdown",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    f.failRpc((action) => action === "workspaces");
    await assert.rejects(
      f.service.refreshWorkspaces(),
      /RPC unavailable.*Fleet gateway stopped/,
    );
    assert.equal(f.gateway.status().enabled, false);
    assert.equal(f.stopped(), false);
    f.failRpc(undefined);
    await f.service.refreshWorkspaces();
    assert.equal(f.gateway.status().enabled, true);
    f.failRpc((action) => action === "workspaces" || action === "configure");
    await assert.rejects(
      f.service.refreshWorkspaces(),
      /Fleet Host stopped because workspace access could not be disabled/,
    );
    assert.equal(f.stopped(), true);
    assert.equal(f.gateway.status().enabled, false);
    assert.match(String((await f.service.status()).host.error), /Host stopped/);
  },
);

test(
  "new-epoch restore and a newer disabling save serialize so stale restore cannot re-enable hosting",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const entered = deferred(),
      release = deferred();
    f.epoch("two");
    f.resolveWith(async () => {
      entered.resolve();
      await release.promise;
    });
    const restoring = f.service.restore();
    await entered.promise;
    const config = await f.service.config();
    let saved = false;
    const saving = f.service
      .save(
        { ...config, hosting: { ...config.hosting!, enabled: false } },
        config.revision,
      )
      .then(() => {
        saved = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(saved, false);
    await assert.rejects(
      f.remote.rpc("zen/remote/workspaces"),
      /scope_refreshing/,
    );
    release.resolve();
    await Promise.all([restoring, saving]);
    assert.equal(f.gateway.status().enabled, false);
    assert.equal((await f.service.config()).hosting!.enabled, false);
    await f.service.restore();
    assert.equal(f.gateway.status().enabled, false);
    assert.equal(
      f.calls.filter((c) => c.action === "configure").at(-1)!.input &&
        (
          f.calls.filter((c) => c.action === "configure").at(-1)!.input as {
            enabled: boolean;
          }
        ).enabled,
      false,
    );
  },
);

for (const invalidation of ["epoch", "manager", "revision"] as const) {
  test(
    `workspace refresh fences a stale ${invalidation} captured during resolution`,
    { timeout: 20_000 },
    async (t) => {
      const f = await fixture(t);
      const entered = deferred(),
        release = deferred();
      f.resolveWith(async () => {
        entered.resolve();
        await release.promise;
      });
      const refreshing = f.service.refreshWorkspaces();
      const failure = assert.rejects(
        refreshing,
        /Host or settings changed.*Remote workspace access disabled/,
      );
      await entered.promise;
      if (invalidation === "epoch") f.epoch("two");
      else if (invalidation === "manager") f.replaceManager();
      else {
        const config = await f.service.config();
        config.revision = (config.revision ?? 0) + 1;
        await writeFile(f.service.file, JSON.stringify(config));
      }
      release.resolve();
      await failure;
      assert.equal(f.calls.filter((c) => c.action === "configure").length, 1);
      assert.deepEqual(
        (await f.remote.rpc("zen/remote/workspaces")).workspaces,
        [],
      );
      assert.equal(f.gateway.status().enabled, true);
    },
  );
}

test(
  "invalid Host workspace replacement rejects and clears the dynamic allowlist",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.gateway.control("workspaces", [
        { id: f.aId, label: "A", cwd: f.a },
        { id: f.aId, label: "Duplicate", cwd: f.b },
      ]),
      /Invalid Fleet workspace allowlist/,
    );
    assert.deepEqual(
      (await f.remote.rpc("zen/remote/workspaces")).workspaces,
      [],
    );
    assert.match(
      f.gateway.status().error!,
      /Invalid Fleet workspace allowlist/,
    );
    await f.service.refreshWorkspaces();
    assert.equal(f.gateway.status().error, undefined);
    assert.equal(
      (await f.remote.rpc("zen/remote/workspaces")).workspaces.length,
      2,
    );
  },
);
