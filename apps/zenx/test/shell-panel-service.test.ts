import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ShellToolRuntime,
  ToolEnvironment,
  InMemoryToolPolicyStore,
} from "../../../src/tool.js";
import type { ThreadSnapshot } from "../../../src/app-server.js";
import type {
  ShellSessionRead,
  ShellSessionSummary,
} from "../../../src/shell-session.js";
import { desktopShellPty } from "../src/main/shell-pty.js";
import { ShellPanelService } from "../src/main/shell-panel-service.js";
import { validateShellPanelRequest } from "../src/shell-panel.js";

function fixture(cwd: string, store = new InMemoryToolPolicyStore()) {
  const snapshot: ThreadSnapshot = {
    id: "human",
    cwd,
    sandbox: "danger-full-access",
    approvalPolicy: "always",
    archived: false,
    items: [],
    turns: [],
    provider: "fake",
    model: "fake",
    providerProfileId: "fake",
    modelId: "fake",
    reasoningEffort: null,
  };
  let operations = 0;
  const tools = new ToolEnvironment({
    shellSessions: true,
    runtimes: [
      new ShellToolRuntime({
        pty: desktopShellPty,
        environment: { ...process.env, SHELL: "/bin/sh", HOME: cwd },
      }),
    ],
    policyStore: store,
  });
  const service = new ShellPanelService(
    {
      readThread: async (id) => {
        if (id !== snapshot.id) throw new Error("Unknown thread");
        return { ...snapshot };
      },
      dispatchHostTool: async (_expected, launch) => ({ result: launch() }),
      beginHostOperation: () => {
        operations++;
        return {
          release: () => {
            operations--;
          },
        };
      },
    },
    tools,
  );
  return { service, tools, snapshot, operations: () => operations };
}
async function until(
  service: ShellPanelService,
  taskId: string,
  predicate: (read: ShellSessionRead) => boolean,
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const read = (await service.request({
      operation: "read",
      threadId: "human",
      taskId,
    })) as ShellSessionRead;
    if (predicate(read)) return read;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out observing terminal");
}

test("real PTY shares human input/output and task identity with Agent read/wait", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-shared-pty-"));
  const f = fixture(directory);
  try {
    const created = (await f.service.request({
      operation: "create",
      threadId: "human",
      cols: 80,
      rows: 24,
    })) as ShellSessionSummary;
    assert.equal(created.origin, "user");
    assert.equal(created.cwd, directory);
    await until(f.service, created.taskId, (r) => r.session.inputAvailable);
    await f.service.request({
      operation: "resize",
      threadId: "human",
      taskId: created.taskId,
      cols: 92,
      rows: 30,
    });
    const command =
      process.platform === "win32"
        ? "Write-Output ('SHARED_' + 'PTY_PROBE')\r"
        : "printf 'SHARED_%s\\n' 'PTY_PROBE'\r";
    await f.service.request({
      operation: "write",
      threadId: "human",
      taskId: created.taskId,
      data: command,
    });
    const observed = await until(f.service, created.taskId, (r) =>
      r.output.includes("SHARED_PTY_PROBE"),
    );
    assert.equal(observed.session.kind, "terminal");
    assert.equal(
      observed.session.lifecycle,
      undefined,
      "PTYs do not invent pipe EOF facts",
    );
    const invoke = (
      name: string,
      args: Record<string, unknown>,
      signal = new AbortController().signal,
    ) => ({
      name,
      arguments: args,
      cwd: directory,
      threadId: "human",
      callId: "agent",
      signal,
    });
    const read = await f.tools.execute(
      f.tools.prepare(invoke("shell_sessions", { task_id: created.taskId })),
    );
    assert.match(read.output, /SHARED_PTY_PROBE/);
    await assert.rejects(
      () =>
        f.tools.waitRuntime.execute(
          invoke("wait", { task_id: created.taskId, terminate: true }),
        ),
      /Human terminals are read-only/,
    );
    const abort = new AbortController();
    const waiting = f.tools.waitRuntime.execute(
      invoke(
        "wait",
        { task_id: created.taskId, yield_time_ms: 10000 },
        abort.signal,
      ),
    );
    abort.abort(new Error("Agent interrupted"));
    await assert.rejects(waiting, /Agent interrupted/);
    assert.equal(
      (
        (await f.service.request({
          operation: "read",
          threadId: "human",
          taskId: created.taskId,
        })) as ShellSessionRead
      ).session.status,
      "running",
    );
    const receipt = await f.tools.waitRuntime.execute(
      invoke("wait", { task_id: created.taskId, yield_time_ms: 1 }),
    );
    assert.match(receipt.output, /SHARED_PTY_PROBE/);
    assert.equal(
      (receipt.structuredContent as { task_id: string }).task_id,
      created.taskId,
    );
    await f.service.request({
      operation: "write",
      threadId: "human",
      taskId: created.taskId,
      data: "exit\r",
    });
    const final = await until(
      f.service,
      created.taskId,
      (r) => r.session.status === "completed",
    );
    assert.equal(final.session.inputAvailable, false);
    assert.equal(f.operations(), 0);
  } finally {
    await f.tools.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("panel rejects routing, directory overrides, policy bypass and cross-thread access", async () => {
  for (const input of [
    { operation: "list", threadId: "human", device: "remote" },
    { operation: "create", threadId: "human", cols: 80, rows: 24, cwd: "/" },
    { operation: "create", threadId: "human", cols: 0, rows: 24 },
    {
      operation: "write",
      threadId: "human",
      taskId: "test",
      data: "x".repeat(65537),
    },
  ])
    assert.throws(() => validateShellPanelRequest(input));
  const store = new InMemoryToolPolicyStore({ shell: "denied" });
  const f = fixture(os.tmpdir(), store);
  try {
    const create = {
      operation: "create",
      threadId: "human",
      cols: 80,
      rows: 24,
    };
    await assert.rejects(() => f.service.request(create), /denied/);
    assert.equal(f.operations(), 0);
    await store.set("shell", "approved");
    f.snapshot.sandbox = "read-only";
    await assert.rejects(() => f.service.request(create), /Full Access/);
    f.snapshot.sandbox = "danger-full-access";
    f.snapshot.archived = true;
    await assert.rejects(() => f.service.request(create), /Restore/);
    await assert.rejects(
      () => f.service.request({ operation: "list", threadId: "another" }),
      /Unknown thread/,
    );
    assert.deepEqual(f.tools.taskManager.listShellSessions("human"), []);
  } finally {
    await f.tools.close();
  }
});

test("stopping a terminal closes its foreground fixture process", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-pty-stop-"));
  const marker = path.join(directory, "pid");
  const script = path.join(directory, "foreground.cjs");
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
  );
  const f = fixture(directory);
  let pid: number | undefined;
  try {
    const created = (await f.service.request({
      operation: "create",
      threadId: "human",
      cols: 80,
      rows: 24,
    })) as ShellSessionSummary;
    await until(f.service, created.taskId, (r) => r.session.inputAvailable);
    const command =
      process.platform === "win32"
        ? `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'\r`
        : `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\r`;
    await f.service.request({
      operation: "write",
      threadId: "human",
      taskId: created.taskId,
      data: command,
    });
    const deadline = Date.now() + 5000;
    while (!pid && Date.now() < deadline) {
      try {
        pid = Number(await readFile(marker, "utf8"));
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    assert(pid, "foreground fixture started");
    await f.service.request({
      operation: "stop",
      threadId: "human",
      taskId: created.taskId,
    });
    await until(
      f.service,
      created.taskId,
      (r) => r.session.status === "cancelled",
    );
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive && process.platform !== "win32") {
        try {
          alive = !(await readFile(`/proc/${pid}/stat`, "utf8")).includes(
            ") Z ",
          );
        } catch {
          /* No procfs on macOS. */
        }
      }
      if (alive) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      alive,
      false,
      "foreground process did not survive terminal stop",
    );
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
    }
    await f.tools.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual Shell dispatch is fenced against an in-flight permission downgrade", async () => {
  const { createHostedAppServer } = await import("../../cli/src/host.js");
  const { InMemoryThreadJournal } = await import("../../../src/journal.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-shell-fence-"));
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let enteredCommit!: () => void;
  const commitStarted = new Promise<void>((resolve) => {
    enteredCommit = resolve;
  });
  const journal = new InMemoryThreadJournal();
  const append = journal.append.bind(journal);
  journal.append = async (item) => {
    if (item.type === "thread_configuration_changed") {
      enteredCommit();
      await commitGate;
    }
    await append(item);
  };
  const tools = new ToolEnvironment({
    shellSessions: true,
    runtimes: [new ShellToolRuntime({ pty: desktopShellPty })],
  });
  const app = createHostedAppServer({
    cwd: directory,
    dataDirectory: directory,
    approvalPolicy: "never",
    provider: { type: "fake" },
    model: "fake",
    journal,
    toolEnvironment: tools,
    toolPresentation: "direct",
  });
  let enteredDispatch!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => {
    enteredDispatch = resolve;
  });
  const dispatch = app.dispatchHostTool.bind(app);
  app.dispatchHostTool = async (expected, launch) => {
    enteredDispatch();
    return dispatch(expected, launch);
  };
  const service = new ShellPanelService(app, tools);
  try {
    const thread = await app.startThread();
    const changing = app.setThreadPermissions(thread.id, "read-only");
    await commitStarted;
    const creation = service.request({
      operation: "create",
      threadId: thread.id,
      cols: 80,
      rows: 24,
    });
    const rejected = assert.rejects(creation, /changed before dispatch/);
    await dispatchStarted;
    assert.deepEqual(tools.taskManager.listShellSessions(thread.id), []);
    releaseCommit();
    await changing;
    await rejected;
    assert.deepEqual(tools.taskManager.listShellSessions(thread.id), []);
    assert.equal((await app.readThread(thread.id)).sandbox, "read-only");
  } finally {
    releaseCommit();
    await tools.close();
    await app.closeRuntimeConfiguration();
    await rm(directory, { recursive: true, force: true });
  }
});
