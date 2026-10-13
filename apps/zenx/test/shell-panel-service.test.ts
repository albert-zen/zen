import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { get } from "node:http";
import { stripVTControlCharacters } from "node:util";
import {
  ShellToolRuntime,
  ToolEnvironment,
  InMemoryToolPolicyStore,
} from "../../../src/tool.js";
import type { ToolTaskOptions } from "../../../src/tool-task.js";
import type { ThreadSnapshot } from "../../../src/app-server.js";
import type {
  ShellSessionRead,
  ShellSessionSummary,
} from "../../../src/shell-session.js";
import { desktopShellPty } from "../src/main/shell-pty.js";
import {
  trackWindowsShellProcess,
  WINDOWS_SHELL_SHUTDOWN_WAIT_MS,
} from "../src/main/shell-process-termination.js";
import { ShellPanelService } from "../src/main/shell-panel-service.js";
import { validateShellPanelRequest } from "../src/shell-panel.js";

const nodePtyVersion = (
  createRequire(import.meta.url)("node-pty/package.json") as { version: string }
).version;

function fixture(
  cwd: string,
  store = new InMemoryToolPolicyStore(),
  taskOptions?: ToolTaskOptions,
  pty = desktopShellPty,
) {
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
    ...(taskOptions ? { taskOptions } : {}),
    runtimes: [
      new ShellToolRuntime({
        ...(process.platform === "win32"
          ? {
              trackProcess: trackWindowsShellProcess,
              ownedCleanupWaitMs: WINDOWS_SHELL_SHUTDOWN_WAIT_MS,
            }
          : {}),
        pty: {
          async spawn(options) {
            const trace = (stage: string) => {
              if (process.env.ZENX_SHELL_TEST_DIAGNOSTICS === "1")
                console.info(`[Shell PTY ${process.platform}] ${stage}`);
            };
            trace(
              `spawn started ${options.cols}x${options.rows}, OS ${os.release()}, Node ${process.version}, node-pty ${nodePtyVersion}`,
            );
            const terminal = await pty.spawn(options);
            trace("spawn returned");
            return {
              write(data) {
                trace(`write ${JSON.stringify(data)}`);
                terminal.write(data);
              },
              resize(cols, rows) {
                trace(`resize ${cols}x${rows}`);
                terminal.resize(cols, rows);
              },
              onData: (listener) =>
                terminal.onData((data) => {
                  trace(`output ${JSON.stringify(data)}`);
                  listener(data);
                }),
              onExit: (listener) =>
                terminal.onExit((event) => {
                  trace("observed exit");
                  listener(event);
                }),
              kill(signal) {
                trace(`kill ${signal ?? "default"} started`);
                terminal.kill(signal);
                trace("kill returned");
              },
            };
          },
        },
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
  stage = "terminal",
) {
  const deadline = Date.now() + 5000;
  let last: ShellSessionRead | undefined;
  while (Date.now() < deadline) {
    const read = (await service.request({
      operation: "read",
      threadId: "human",
      taskId,
    })) as ShellSessionRead;
    last = read;
    if (predicate(read)) return read;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `Timed out observing ${stage}: ${JSON.stringify({
      status: last?.session.status,
      output: last?.output.slice(-4096),
    })}`,
  );
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
    if (process.platform === "win32") {
      // Control registration precedes PowerShell's first prompt. Exercise input
      // as a user would, after the shell has actually entered its read loop.
      await until(f.service, created.taskId, (r) =>
        /PS [^\r\n]*> /u.test(stripVTControlCharacters(r.output)),
      );
      // Establish evaluation before resizing, not merely echoed input. Keep the
      // wrapped post-resize command below as a separate regression assertion.
      await f.service.request({
        operation: "write",
        threadId: "human",
        taskId: created.taskId,
        data: "123+456\r",
      });
      await until(
        f.service,
        created.taskId,
        (r) =>
          /(?:^|\r?\n)579\r?\n[\s\S]*PS [^\r\n]*> /u.test(
            stripVTControlCharacters(r.output),
          ),
        "pre-resize PowerShell evaluation",
      );
    }
    await f.service.request({
      operation: "resize",
      threadId: "human",
      taskId: created.taskId,
      cols: 92,
      rows: 30,
    });
    if (process.platform === "win32") {
      await f.service.request({
        operation: "write",
        threadId: "human",
        taskId: created.taskId,
        data: "234+567;'ok'>p\r",
      });
      try {
        await until(
          f.service,
          created.taskId,
          (r) =>
            /(?:^|\r?\n)801\r?\n[\s\S]*PS [^\r\n]*> /u.test(
              stripVTControlCharacters(r.output),
            ),
          "post-resize short PowerShell evaluation",
        );
      } catch (error) {
        const executed = await readFile(path.join(directory, "p"))
          .then((data) => data.toString("hex"))
          .catch(() => "absent");
        throw new Error(
          `Post-resize evaluation file: ${executed}; ${String(error)}`,
          {
            cause: error,
          },
        );
      }
    }
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
    const observed = await until(
      f.service,
      created.taskId,
      (r) => r.output.includes("SHARED_PTY_PROBE"),
      "post-resize wrapped command output",
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
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
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
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
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
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

test("human PTY outlives the Agent deadline and still exits on Host disposal", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-shell-lifetime-"),
  );
  let observeExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    observeExit = resolve;
  });
  const f = fixture(
    directory,
    undefined,
    { timeoutMs: 80 },
    {
      async spawn(options) {
        const terminal = await desktopShellPty.spawn(options);
        terminal.onExit(() => observeExit());
        return terminal;
      },
    },
  );
  try {
    const human = (await f.service.request({
      operation: "create",
      threadId: "human",
      cols: 80,
      rows: 24,
    })) as ShellSessionSummary;
    await until(f.service, human.taskId, (view) => view.session.inputAvailable);
    const invocation = (name: string, args: Record<string, unknown>) => ({
      name,
      arguments: args,
      cwd: directory,
      threadId: "human",
      callId: "lifetime",
      signal: new AbortController().signal,
    });
    let agent = await f.tools.execute(
      f.tools.prepare(
        invocation("shell", {
          // Isolate the deadline from descendant containment: the fixture
          // runs entirely in the owned foreground shell process.
          command:
            process.platform === "win32"
              ? "for /L %i in (1,0,2) do @rem"
              : "while :; do :; done",
          yield_time_ms: 1000,
        }),
      ),
    );
    if (
      (agent.structuredContent as { status: string }).status ===
      "cancel_requested"
    ) {
      // The execution deadline is still 80ms. Native ownership verification is
      // asynchronous, so observe its result rather than equating a yield with it.
      agent = await f.tools.waitRuntime.execute(
        invocation("wait", {
          task_id: (agent.structuredContent as { task_id: string }).task_id,
          yield_time_ms: 5000,
        }),
      );
    }
    assert.equal(
      (agent.structuredContent as { status: string }).status,
      "timed_out",
    );
    assert.equal(
      (agent.structuredContent as { timeout_ms: number }).timeout_ms,
      80,
    );
    const view = (await f.service.request({
      operation: "read",
      threadId: "human",
      taskId: human.taskId,
    })) as ShellSessionRead;
    assert.equal(view.session.status, "running");
    assert.equal(view.session.inputAvailable, true);
    const receipt = await f.tools.waitRuntime.execute(
      invocation("wait", { task_id: human.taskId, yield_time_ms: 1 }),
    );
    assert.equal(
      (receipt.structuredContent as { timeout_ms: number | null }).timeout_ms,
      null,
    );
    await f.tools.close();
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("PTY survived Host disposal")),
          1000,
        );
        timer.unref();
      }),
    ]);
    assert.deepEqual(f.tools.taskManager.listShellSessions("human"), []);
  } finally {
    await f.tools.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

test("panel Stop terminates an ordinary Agent Shell development server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-agent-service-"));
  const marker = path.join(directory, "service.json");
  const script = path.join(directory, "service.cjs");
  const token = randomUUID();
  await writeFile(
    script,
    `
const fs = require('node:fs');
const server = require('node:http').createServer((req, res) => {
  res.end(${JSON.stringify(token)});
  if (req.url === '/stop/' + ${JSON.stringify(token)}) server.close(() => process.exit(0));
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, port: server.address().port}));
});
// An outer bound cleans up even if the test runner is interrupted.
setTimeout(() => process.exit(1), 20000).unref();
`,
  );
  const f = fixture(directory);
  let owned: { pid: number; port: number } | undefined;
  const request = (route = "/") =>
    new Promise<string>((resolve, reject) => {
      const req = get(
        { hostname: "127.0.0.1", port: owned!.port, path: route, timeout: 500 },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += String(chunk);
          });
          response.on("end", () => resolve(body));
        },
      );
      req.once("error", reject);
      req.once("timeout", () =>
        req.destroy(new Error("Fixture request timeout")),
      );
    });
  try {
    const command =
      process.platform === "win32"
        ? `"${process.execPath}" "${script}"`
        : `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const receipt = await f.tools.execute(
      f.tools.prepare({
        name: "shell",
        arguments: { command, yield_time_ms: 1 },
        cwd: directory,
        threadId: "human",
        callId: "service-stop",
        signal: new AbortController().signal,
      }),
    );
    const taskId = (receipt.structuredContent as { task_id: string }).task_id;
    const deadline = Date.now() + 5000;
    while (!owned && Date.now() < deadline) {
      try {
        owned = JSON.parse(await readFile(marker, "utf8"));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert(owned, "Agent service fixture started");
    assert.equal(
      await request(),
      token,
      "exact fixture owns the listening port",
    );
    await f.service.request({ operation: "stop", threadId: "human", taskId });
    await until(
      f.service,
      taskId,
      (view) => view.session.status === "cancelled",
    );
    let serving = true;
    let alive = true;
    const stoppedBy = Date.now() + 1000;
    while ((serving || alive) && Date.now() < stoppedBy) {
      try {
        serving = (await request()) === token;
      } catch {
        serving = false;
      }
      try {
        process.kill(owned.pid, 0);
        if (process.platform === "linux") {
          alive = !(await readFile(`/proc/${owned.pid}/stat`, "utf8")).includes(
            ") Z ",
          );
        }
      } catch (error) {
        if (
          ["ESRCH", "ENOENT"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          alive = false;
        else throw error;
      }
      if (serving || alive)
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      serving,
      false,
      `Agent service survived Stop (owned PID ${owned.pid})`,
    );
    assert.equal(
      alive,
      false,
      "the exact Agent service fixture process exited",
    );
  } finally {
    // Never scan or kill a PID that may have been reused. Only the authenticated
    // synthetic fixture endpoint may request its own graceful cleanup.
    if (owned) {
      try {
        if ((await request()) === token) await request(`/stop/${token}`);
      } catch {
        /* The exact fixture has already stopped. */
      }
    }
    await f.tools.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

const windowsFolderVariables = [
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "SYSTEMDRIVE",
  "HOMEDRIVE",
  "HOMEPATH",
];
for (const restoreFolders of [false, true]) {
  test(
    `Windows Utility control: standard folders ${restoreFolders ? "restored" : "filtered"}`,
    { skip: process.platform !== "win32" },
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "zen-pty-utility-"),
      );
      const provider = {
        async spawn(options: Parameters<typeof desktopShellPty.spawn>[0]) {
          // Diagnostic only: explicitly named system folder paths, never the full
          // Host environment, credentials or arbitrary user variables.
          const folders = restoreFolders
            ? Object.fromEntries(
                Object.entries(process.env).filter(
                  ([key, value]) =>
                    value !== undefined &&
                    windowsFolderVariables.includes(key.toUpperCase()),
                ),
              )
            : {};
          console.info(
            `[Windows Utility control] restored keys ${JSON.stringify(Object.keys(folders))}`,
          );
          return desktopShellPty.spawn({
            ...options,
            env: { ...options.env, ...folders },
          });
        },
      };
      const f = fixture(directory, undefined, undefined, provider);
      try {
        const created = (await f.service.request({
          operation: "create",
          threadId: "human",
          cols: 80,
          rows: 24,
        })) as ShellSessionSummary;
        const write = (data: string) =>
          f.service.request({
            operation: "write",
            threadId: "human",
            taskId: created.taskId,
            data,
          });
        await until(
          f.service,
          created.taskId,
          (r) => /PS [^\r\n]*> /u.test(stripVTControlCharacters(r.output)),
          "Utility control first prompt",
        );
        const markerPath = path
          .join(directory, "direct.txt")
          .replaceAll("'", "''");
        await write(
          `[Console]::WriteLine('PSHOME='+$PSHOME);[Console]::WriteLine('PSModulePath='+$env:PSModulePath);[Console]::WriteLine('LOCALAPPDATA='+$env:LOCALAPPDATA);[IO.File]::WriteAllText('${markerPath}','ok');[Console]::WriteLine(('DIRECT_'+'PROBE'))\r`,
        );
        await until(
          f.service,
          created.taskId,
          (r) =>
            /DIRECT_PROBE[\s\S]*PS [^\r\n]*> /u.test(
              stripVTControlCharacters(r.output),
            ),
          "direct .NET output and file without resize",
        );
        assert.equal(
          await readFile(path.join(directory, "direct.txt"), "utf8"),
          "ok",
        );
        // Match the actual original cmdlet and redirection, before any resize.
        // Arithmetic alone was insufficient to isolate the earlier failure.
        await write(
          "Write-Output ('SHARED_' + 'PTY_PROBE'); 'ok'>utility.txt\r",
        );
        try {
          await until(
            f.service,
            created.taskId,
            (r) =>
              /SHARED_PTY_PROBE[\s\S]*PS [^\r\n]*> /u.test(
                stripVTControlCharacters(r.output),
              ),
            "Utility output and redirection before resize",
          );
        } catch (error) {
          const marker = await readFile(path.join(directory, "utility.txt"))
            .then((b) => b.toString("hex"))
            .catch(() => "absent");
          throw new Error(
            `Standard folder control ${restoreFolders}; Utility file ${marker}; ${String(error)}`,
          );
        }
        assert(
          (await readFile(path.join(directory, "utility.txt"))).length > 0,
        );
        await f.service.request({
          operation: "resize",
          threadId: "human",
          taskId: created.taskId,
          cols: 92,
          rows: 30,
        });
        await write("Write-Output ('AFTER_' + 'RESIZE'); 'ok'>after.txt\r");
        await until(
          f.service,
          created.taskId,
          (r) =>
            /AFTER_RESIZE[\s\S]*PS [^\r\n]*> /u.test(
              stripVTControlCharacters(r.output),
            ),
          "Utility output and redirection after resize",
        );
        assert((await readFile(path.join(directory, "after.txt"))).length > 0);
        await write("exit\r");
        await until(
          f.service,
          created.taskId,
          (r) => r.session.status === "completed",
          "Utility control natural exit",
        );
      } finally {
        await f.tools.close();
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      }
    },
  );
}
