import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import {
  ToolEnvironment,
  type ToolRuntime,
  type ToolPolicyStore,
} from "../src/tool.js";
import {
  RemoteHostAccess,
  RemoteHostError,
  type RemoteWorkspace,
} from "../src/protocol/native/remote-host.js";
import { FleetToolGateway } from "../src/protocol/native/remote-tools.js";
import { makeRemoteToolAdmissionId } from "../src/protocol/native/remote-tool-wire.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const denied = (code: string) => (error: unknown) =>
  error instanceof RemoteHostError && error.code === code;
async function fixture(
  t: TestContext,
  execute: ToolRuntime["execute"],
  policyStore?: ToolPolicyStore,
  threadMetadata = new InMemoryThreadMetadataStore(),
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-tools-admission-"));
  const tools = new ToolEnvironment({
    runtimes: [
      {
        name: "effect",
        remoteExecution: "text-json",
        enforcesSandbox: true,
        specification: {
          name: "effect",
          description: "Effect fixture",
          inputSchema: { type: "object" },
        },
        execute,
      },
    ],
    ...(policyStore === undefined ? {} : { policyStore }),
  });
  const app = createHostedAppServer({
    cwd,
    dataDirectory: path.join(cwd, "data"),
    provider: { type: "fake" },
    model: "fake",
    journal: new InMemoryThreadJournal(),
    threadMetadata,
    approvalPolicy: "never",
    toolEnvironment: tools,
    toolPresentation: "direct",
  });
  let workspaces: readonly RemoteWorkspace[] = [
    { id: "work", label: "Work", cwd },
  ];
  let asynchronousWorkspaces = false;
  let workspaceReads = 0,
    failedWorkspaceRead = -1;
  let gateway!: FleetToolGateway;
  const access = new RemoteHostAccess({
    appServer: app,
    hostId: "host",
    access: "control",
    toolsEnabled: true,
    tools: (identity) =>
      (gateway = new FleetToolGateway({ ...identity, tools })),
    workspaces: () => {
      if (++workspaceReads === failedWorkspaceRead)
        throw new RemoteHostError("scope_refreshing");
      return asynchronousWorkspaces ? Promise.resolve(workspaces) : workspaces;
    },
  });
  const thread = await app.startThread({ cwd });
  const peer = await access.pair({
    hostId: "host",
    deviceId: "peer",
    code: access.createPairingCode(),
    access: "control",
    toolsEnabled: true,
  });
  const catalog = await access.toolsCatalog("peer", peer.token, {
    version: 1,
    hostId: "host",
    processEpoch: (await access.hello("peer", peer.token, "host", 1))
      .processEpoch,
    workspaceId: "work",
    targetThreadId: thread.id,
    sourceThreadId: "source",
  });
  const now = Date.now();
  const request = {
    version: 1 as const,
    hostId: "host",
    processEpoch: catalog.processEpoch,
    workspaceId: "work",
    targetThreadId: thread.id,
    sourceThreadId: "source",
    admissionId: makeRemoteToolAdmissionId(now, now + 60_000, "effect"),
    createdAtMs: now,
    expiresAtMs: now + 60_000,
    name: "effect",
    toolGeneration: catalog.tools.find(
      (entry) => entry.definition.name === "effect",
    )!.generation,
    arguments: {},
    yieldTimeMs: 1000,
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
  };
  t.after(async () => {
    access.close();
    await app.closeHostResources();
    await tools.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    app,
    tools,
    gateway,
    access,
    thread,
    peer,
    request,
    removeWorkspace: () => {
      workspaces = [];
    },
    setWorkspaces: (entries: readonly RemoteWorkspace[]) => {
      workspaces = entries;
    },
    setAsynchronousWorkspaces: () => {
      asynchronousWorkspaces = true;
    },
    failWorkspaceAfter: (reads: number) => {
      failedWorkspaceRead = workspaceReads + reads;
    },
  };
}

for (const change of [
  "removal",
  "remapping",
  "shared symlink remapping",
  "asynchronous provider",
] as const) {
  test(`workspace ${change} inside the dispatch fence prevents task launch`, async (t) => {
    const inFence = deferred(),
      release = deferred();
    const metadata = new InMemoryThreadMetadataStore();
    const originalRead = metadata.read.bind(metadata);
    let untilFence = 0,
      policyReads = 0,
      effects = 0;
    metadata.read = async (id) => {
      if (untilFence > 0 && --untilFence === 0) {
        inFence.resolve();
        await release.promise;
      }
      return await originalRead(id);
    };
    const f = await fixture(
      t,
      async () => {
        effects++;
        return { output: "effect", exitCode: 0 };
      },
      {
        async get() {
          if (++policyReads === 2) untilFence = 2;
          return undefined;
        },
        async set() {},
      },
      metadata,
    );
    t.after(() => release.resolve());
    const other = path.join(f.cwd, "other");
    await mkdir(other);
    const alias = path.join(f.cwd, "alias");
    let request = f.request;
    if (change === "shared symlink remapping") {
      await symlink(f.cwd, alias, "junction");
      const thread = await f.app.startThread({ cwd: alias });
      assert.equal(thread.cwd, alias);
      request = { ...request, targetThreadId: thread.id };
      f.setWorkspaces([{ id: "work", label: "Work", cwd: alias }]);
    }
    const executing = f.access.toolsExecute("peer", f.peer.token, request);
    await inFence.promise;
    assert.equal(effects, 0);
    assert.equal(f.app.activitySnapshot().activeToolTasks, 0);
    if (change === "removal") f.removeWorkspace();
    else if (change === "remapping")
      f.setWorkspaces([{ id: "work", label: "Work", cwd: other }]);
    else if (change === "asynchronous provider") f.setAsynchronousWorkspaces();
    else {
      await rm(alias);
      await symlink(other, alias, "junction");
    }
    release.resolve();
    await assert.rejects(
      executing,
      denied(
        change === "asynchronous provider"
          ? "operation_forbidden"
          : "wrong_workspace",
      ),
    );
    assert.equal(effects, 0);
    assert.equal(f.app.activitySnapshot().activeToolTasks, 0);
    assert.equal(f.app.activitySnapshot().rootOperations.length, 0);
    const target = await f.app.readThread(request.targetThreadId);
    assert.equal(target.turns.length, 0);
    assert.equal(
      target.items.some((item) => item.type === "tool_call"),
      false,
    );
  });
}

test("Promise workspace providers allow catalog reads but fail closed before a new tool task", async (t) => {
  let effects = 0;
  const f = await fixture(t, async () => {
    effects++;
    return { output: "effect", exitCode: 0 };
  });
  f.setAsynchronousWorkspaces();
  const catalog = await f.access.toolsCatalog("peer", f.peer.token, {
    version: 1,
    hostId: f.request.hostId,
    processEpoch: f.request.processEpoch,
    workspaceId: f.request.workspaceId,
    targetThreadId: f.request.targetThreadId,
    sourceThreadId: f.request.sourceThreadId,
  });
  assert.ok(catalog.tools.some((entry) => entry.definition.name === "effect"));
  await assert.rejects(
    f.access.toolsExecute("peer", f.peer.token, f.request),
    (error) =>
      denied("operation_forbidden")(error) &&
      error instanceof Error &&
      /synchronous.*workspace/i.test(error.message),
  );
  assert.equal(effects, 0);
  assert.equal(f.app.activitySnapshot().activeToolTasks, 0);
  assert.equal(f.app.activitySnapshot().rootOperations.length, 0);
});

test("synchronous canonical workspace aliases still admit exactly one target task", async (t) => {
  let effects = 0;
  const f = await fixture(t, async () => {
    effects++;
    return { output: "effect", exitCode: 0 };
  });
  const alias = path.join(f.cwd, "alias");
  await symlink(f.cwd, alias, "junction");
  const thread = await f.app.startThread({ cwd: alias });
  const request = { ...f.request, targetThreadId: thread.id };
  const first = await f.access.toolsExecute("peer", f.peer.token, request);
  const replay = await f.access.toolsExecute("peer", f.peer.token, request);
  assert.equal(first.status, "completed");
  assert.deepEqual(replay, first);
  assert.equal(effects, 1);
  assert.equal((await f.app.readThread(thread.id)).turns.length, 0);
  assert.equal(f.app.activitySnapshot().activeToolTasks, 0);
  assert.equal(f.app.activitySnapshot().rootOperations.length, 0);
});

test("Host scope refresh before drain restores the same ACK without reexecution", async (t) => {
  const finish = deferred();
  let effects = 0;
  const f = await fixture(t, async (invocation) => {
    effects++;
    invocation.taskContext!.onOutput("first");
    await finish.promise;
    return { output: "retained final output", exitCode: 0 };
  });
  t.after(() => finish.resolve());
  const executeWait = f.tools.waitRuntime.execute.bind(f.tools.waitRuntime);
  let drains = 0;
  f.tools.waitRuntime.execute = async (invocation) => {
    drains++;
    return executeWait(invocation);
  };
  const first = await f.access.toolsExecute("peer", f.peer.token, {
    ...f.request,
    yieldTimeMs: 1,
  });
  assert.equal(first.status, "running");
  const ack = {
    version: 1 as const,
    hostId: f.request.hostId,
    processEpoch: f.request.processEpoch,
    sourceThreadId: f.request.sourceThreadId,
    workspaceId: f.request.workspaceId,
    targetThreadId: f.request.targetThreadId,
    admissionId: f.request.admissionId,
    taskId: first.taskId,
    ackCursor: first.cursor,
    yieldTimeMs: 1000,
    maxOutputBytes: 1024,
  };
  // Host and gateway each validate scope twice; the fifth lookup is the
  // additional #drain authorization, before its destructive wait begins.
  f.failWorkspaceAfter(5);
  await assert.rejects(
    f.access.toolsWait("peer", f.peer.token, ack),
    denied("scope_refreshing"),
  );
  assert.equal(drains, 0);
  finish.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const [last, replay] = await Promise.all([
    f.access.toolsWait("peer", f.peer.token, ack),
    f.access.toolsWait("peer", f.peer.token, ack),
  ]);
  assert.deepEqual(replay, last);
  assert.equal(last.status, "completed");
  assert.equal(last.output, "retained final output");
  assert.notEqual(last.cursor, first.cursor);
  assert.equal(last.admissionId, first.admissionId);
  assert.equal(last.taskId, first.taskId);
  assert.equal(drains, 1);
  assert.equal(effects, 1);
});

test("completed permission reduction during final policy read prevents dispatch", async (t) => {
  const reading = deferred(),
    release = deferred();
  let reads = 0,
    effects = 0;
  const f = await fixture(
    t,
    async () => {
      effects++;
      return { output: "effect", exitCode: 0 };
    },
    {
      async get() {
        if (++reads === 2) {
          reading.resolve();
          await release.promise;
        }
        return undefined;
      },
      async set() {},
    },
  );
  t.after(() => release.resolve());
  const executing = f.access.toolsExecute("peer", f.peer.token, f.request);
  await reading.promise;
  assert.equal(
    (await f.app.setThreadPermissions(f.thread.id, "read-only")).sandbox,
    "read-only",
  );
  release.resolve();
  await assert.rejects(executing, denied("stale_thread"));
  assert.equal(effects, 0);
});

test("accepted maintenance rejects new generic execution before effects", async (t) => {
  let effects = 0;
  const f = await fixture(t, async () => {
    effects++;
    return { output: "effect", exitCode: 0 };
  });
  const maintenance = f.app.tryBeginMaintenance();
  assert.equal(maintenance.accepted, true);
  if (!maintenance.accepted) return;
  t.after(() => maintenance.end());
  await assert.rejects(
    f.access.toolsExecute("peer", f.peer.token, f.request),
    denied("thread_busy"),
  );
  assert.equal(effects, 0);
});

test("pending policy admission fences maintenance and transfers to the target task", async (t) => {
  const reading = deferred(),
    release = deferred(),
    started = deferred(),
    finish = deferred();
  let reads = 0;
  const f = await fixture(
    t,
    async () => {
      started.resolve();
      await finish.promise;
      return { output: "effect", exitCode: 0 };
    },
    {
      async get() {
        if (++reads === 2) {
          reading.resolve();
          await release.promise;
        }
        return undefined;
      },
      async set() {},
    },
  );
  t.after(() => {
    release.resolve();
    finish.resolve();
  });
  const executing = f.access.toolsExecute("peer", f.peer.token, {
    ...f.request,
    yieldTimeMs: 1,
  });
  await reading.promise;
  assert.equal(f.app.tryBeginMaintenance().accepted, false);
  assert.equal(
    f.app.activitySnapshot().rootOperations.filter((op) => op.kind === "tool")
      .length,
    1,
  );
  release.resolve();
  await started.promise;
  await executing;
  assert.equal(f.app.activitySnapshot().rootOperations.length, 0);
  assert.equal(f.app.activitySnapshot().activeToolTasks, 1);
  assert.equal(f.app.tryBeginMaintenance().accepted, false);
  finish.resolve();
});

test("post-dispatch archive withholds contents and reports unknown outcome", async (t) => {
  let effects = 0;
  let archive!: (threadId: string) => Promise<unknown>;
  const f = await fixture(t, async (invocation) => {
    effects++;
    await archive(invocation.threadId!);
    return { output: "private completed effect", exitCode: 0 };
  });
  archive = (id) => f.app.setThreadArchived(id, true);
  await assert.rejects(
    f.access.toolsExecute("peer", f.peer.token, f.request),
    (error) =>
      denied("operation_unknown")(error) &&
      error instanceof Error &&
      /do not rerun/i.test(error.message) &&
      !error.message.includes("private completed effect"),
  );
  assert.equal(effects, 1);
});

for (const change of ["workspace", "revocation"] as const) {
  test(`post-dispatch ${change} loss withholds contents and reports unknown outcome`, async (t) => {
    let effects = 0;
    let loseScope!: () => void;
    const f = await fixture(t, async () => {
      effects++;
      loseScope();
      return { output: "private completed effect", exitCode: 0 };
    });
    loseScope =
      change === "workspace"
        ? f.removeWorkspace
        : () => f.access.revoke("peer");
    await assert.rejects(
      f.access.toolsExecute("peer", f.peer.token, f.request),
      (error) =>
        denied("operation_unknown")(error) &&
        error instanceof Error &&
        /do not rerun/i.test(error.message) &&
        !error.message.includes("private completed effect"),
    );
    assert.equal(effects, 1);
  });
}

test("dispatch fence orders a concurrent permission edit after synchronous target task registration", async (t) => {
  const inFence = deferred(),
    release = deferred(),
    finish = deferred();
  const metadata = new InMemoryThreadMetadataStore();
  const originalRead = metadata.read.bind(metadata);
  let untilFence = 0,
    policyReads = 0,
    effects = 0;
  metadata.read = async (id) => {
    if (untilFence > 0 && --untilFence === 0) {
      inFence.resolve();
      await release.promise;
    }
    return await originalRead(id);
  };
  const f = await fixture(
    t,
    async () => {
      effects++;
      await finish.promise;
      return { output: "effect", exitCode: 0 };
    },
    {
      async get() {
        if (++policyReads === 2) untilFence = 2;
        return undefined;
      },
      async set() {},
    },
    metadata,
  );
  t.after(() => {
    release.resolve();
    finish.resolve();
  });
  const executing = f.access.toolsExecute("peer", f.peer.token, {
    ...f.request,
    yieldTimeMs: 1,
  });
  await inFence.promise;
  const permissions = f.app.setThreadPermissions(f.thread.id, "read-only");
  const rejection = assert.rejects(
    permissions,
    (error) =>
      error instanceof Error && "code" in error && error.code === "thread_busy",
  );
  release.resolve();
  const result = await executing;
  await rejection;
  assert.equal(effects, 1);
  assert.equal(result.status, "running");
  assert.equal(
    (await f.app.readThread(f.thread.id)).sandbox,
    "danger-full-access",
  );
  assert.equal(f.app.activitySnapshot().activeToolTasks, 1);
  assert.equal(f.app.activitySnapshot().rootOperations.length, 0);
  finish.resolve();
});

for (const change of [
  "registration replacement",
  "grant revocation",
] as const) {
  test(`exact ${change} inside the dispatch fence prevents the prepared body`, async (t) => {
    const inFence = deferred(),
      release = deferred();
    const metadata = new InMemoryThreadMetadataStore();
    const originalRead = metadata.read.bind(metadata);
    let untilFence = 0,
      policyReads = 0,
      effects = 0;
    metadata.read = async (id) => {
      if (untilFence > 0 && --untilFence === 0) {
        inFence.resolve();
        await release.promise;
      }
      return await originalRead(id);
    };
    const f = await fixture(
      t,
      async () => {
        effects++;
        return { output: "old", exitCode: 0 };
      },
      {
        async get() {
          if (++policyReads === 2) untilFence = 2;
          return undefined;
        },
        async set() {},
      },
      metadata,
    );
    t.after(() => release.resolve());
    const executing = f.access.toolsExecute("peer", f.peer.token, f.request);
    await inFence.promise;
    if (change === "grant revocation") f.access.revoke("peer");
    else {
      f.tools.unregisterBundle({ kind: "builtin", id: "effect" });
      f.tools.registerRuntime({
        name: "effect",
        remoteExecution: "text-json",
        enforcesSandbox: true,
        specification: {
          name: "effect",
          description: "Replacement",
          inputSchema: { type: "object" },
        },
        async execute() {
          effects++;
          return { output: "replacement", exitCode: 0 };
        },
      });
    }
    release.resolve();
    await assert.rejects(
      executing,
      denied(change === "grant revocation" ? "revoked" : "operation_forbidden"),
    );
    assert.equal(effects, 0);
    assert.equal(f.app.activitySnapshot().rootOperations.length, 0);
  });
}

for (const operation of ["wait", "cancel"] as const) {
  test(`post-${operation} scope loss reports unknown and preserves the same destructive receipt`, async (t) => {
    const finish = deferred();
    let effects = 0;
    const f = await fixture(t, async (invocation) => {
      effects++;
      invocation.taskContext!.onOutput("first");
      await new Promise<void>((resolve) => {
        invocation.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
        void finish.promise.then(resolve);
      });
      return { output: "private final output", exitCode: 0 };
    });
    t.after(() => finish.resolve());
    const first = await f.access.toolsExecute("peer", f.peer.token, {
      ...f.request,
      yieldTimeMs: 1,
    });
    const observe = {
      version: 1 as const,
      hostId: f.request.hostId,
      processEpoch: f.request.processEpoch,
      sourceThreadId: f.request.sourceThreadId,
      workspaceId: f.request.workspaceId,
      targetThreadId: f.request.targetThreadId,
      admissionId: f.request.admissionId,
      taskId: first.taskId,
      ackCursor: first.cursor,
      yieldTimeMs: 1000,
      maxOutputBytes: 1024,
    };
    const original = f.gateway.wait.bind(f.gateway);
    let observed = false;
    f.gateway.wait = async (...args: Parameters<typeof original>) => {
      if (operation === "wait") finish.resolve();
      const result = await original(...args);
      if (!observed) {
        observed = true;
        await f.app.setThreadArchived(f.thread.id, true);
      }
      return result;
    };
    await assert.rejects(
      operation === "wait"
        ? f.access.toolsWait("peer", f.peer.token, observe)
        : f.access.toolsCancel("peer", f.peer.token, observe),
      (error) =>
        denied("operation_unknown")(error) &&
        error instanceof Error &&
        /do not rerun/i.test(error.message) &&
        !error.message.includes("private final output"),
    );
    await f.app.setThreadArchived(f.thread.id, false);
    const recovered = await f.access.toolsWait("peer", f.peer.token, observe);
    assert.equal(recovered.taskId, first.taskId);
    assert.equal(recovered.admissionId, f.request.admissionId);
    assert.equal(recovered.output, "private final output");
    assert.equal(effects, 1);
  });
}
