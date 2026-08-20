import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZenXTriggerProgramRunner,
  realWindowsProcessOperations,
  terminateWindowsProcessIdentity,
  type TriggerProgramRunInput,
  verifyAndTerminateWindowsProcessTree,
  type WindowsProcessIdentity,
  type WindowsProcessTableSnapshot,
} from "../src/main/trigger-program-runner.js";

const runner = new ZenXTriggerProgramRunner();

test("Windows containment never reuses stale identity evidence for a second tree kill", async () => {
  const root: WindowsProcessIdentity = {
    pid: 101,
    parentPid: 1,
    processGroupId: null,
    sessionId: null,
    startTime: "root-original",
  };
  const descendant: WindowsProcessIdentity = {
    pid: 202,
    parentPid: root.pid,
    processGroupId: null,
    sessionId: null,
    startTime: "descendant-original",
  };
  let table: WindowsProcessTableSnapshot = {
    entries: [root, descendant],
  };
  const terminatedIdentities: string[] = [];

  const result = await verifyAndTerminateWindowsProcessTree(
    root.pid,
    { root, descendants: [descendant] },
    {
      captureProcessTable: async () => structuredClone(table),
      terminateProcessIdentity: async (expected) => {
        const actual = table.entries.find(
          (entry) => entry.pid === expected.pid,
        );
        if (actual?.startTime !== expected.startTime)
          return { ok: false, error: "process was not found" };
        terminatedIdentities.push(expected.startTime ?? "unknown");
        table = {
          entries: [
            {
              ...root,
              startTime: "root-reused-after-first-tree-kill",
            },
            {
              ...descendant,
              startTime: "descendant-reused-after-first-tree-kill",
            },
          ],
        };
        return { ok: true, error: "" };
      },
    },
    { quiescencePollMs: 0 },
  );

  assert.deepEqual(result, { ok: true, error: "" });
  assert.deepEqual(terminatedIdentities, [root.startTime]);
});

test("Windows containment does not kill a replacement created at termination dispatch", async () => {
  const root: WindowsProcessIdentity = {
    pid: 101,
    parentPid: 1,
    processGroupId: null,
    sessionId: null,
    startTime: "root-original",
  };
  const replacement: WindowsProcessIdentity = {
    ...root,
    startTime: "root-reused-at-dispatch",
  };
  let table: WindowsProcessTableSnapshot = { entries: [root] };
  const killedIdentities: string[] = [];

  const result = await verifyAndTerminateWindowsProcessTree(
    root.pid,
    { root, descendants: [] },
    {
      captureProcessTable: async () => structuredClone(table),
      terminateProcessIdentity: async (expected) => {
        table = { entries: [replacement] };
        const actual = table.entries.find(
          (entry) => entry.pid === expected.pid,
        );
        if (actual?.startTime !== expected.startTime)
          return { ok: false, error: "process was not found" };
        if (actual.startTime !== null) killedIdentities.push(actual.startTime);
        return { ok: true, error: "" };
      },
    },
    { quiescencePollMs: 0 },
  );

  assert.deepEqual(result, { ok: true, error: "" });
  assert.deepEqual(killedIdentities, []);
});

test(
  "Windows identity adapter rejects a stale identity and terminates the matching handle",
  { skip: process.platform !== "win32" },
  async () => {
    const { child, identity } = await spawnWindowsIdentityFixture();
    try {
      const stale = await realWindowsProcessOperations.terminateProcessIdentity(
        {
          ...identity,
          startTime: String(BigInt(identity.startTime) + 1n),
        },
      );
      assert.deepEqual(stale, { ok: false, error: "process was not found" });
      process.kill(identity.pid, 0);

      assert.deepEqual(
        await realWindowsProcessOperations.terminateProcessIdentity(identity),
        { ok: true, error: "" },
      );
      await waitForProcessExit(identity.pid);
    } finally {
      killFixtureProcess(identity.pid);
    }
  },
);

test(
  "Windows identity adapter accepts exit after matching the open handle",
  { skip: process.platform !== "win32" },
  async () => {
    const { child, identity } = await spawnWindowsIdentityFixture();
    try {
      const result = await terminateWindowsProcessIdentity(
        identity,
        async () => {
          const exited = new Promise<void>((resolve, reject) => {
            child.once("exit", () => resolve());
            child.once("error", reject);
          });
          assert.equal(child.kill("SIGKILL"), true);
          await exited;
        },
      );

      assert.deepEqual(result, { ok: true, error: "" });
      await waitForProcessExit(identity.pid);
    } finally {
      killFixtureProcess(identity.pid);
    }
  },
);

test("Windows containment discovers and kills a descendant born during termination", async () => {
  const root: WindowsProcessIdentity = {
    pid: 101,
    parentPid: 1,
    processGroupId: null,
    sessionId: null,
    startTime: "root-original",
  };
  const lateDescendant: WindowsProcessIdentity = {
    pid: 303,
    parentPid: root.pid,
    processGroupId: null,
    sessionId: null,
    startTime: "late-descendant",
  };
  let table: WindowsProcessTableSnapshot = { entries: [root] };
  const taskkills: Array<[number, boolean]> = [];

  const result = await verifyAndTerminateWindowsProcessTree(
    root.pid,
    { root, descendants: [] },
    {
      captureProcessTable: async () => structuredClone(table),
      terminateProcessIdentity: async (expected) => {
        taskkills.push([expected.pid, true]);
        table =
          expected.pid === root.pid
            ? { entries: [lateDescendant] }
            : { entries: [] };
        return { ok: true, error: "" };
      },
    },
    { quiescencePollMs: 0 },
  );

  assert.deepEqual(result, { ok: true, error: "" });
  assert.deepEqual(taskkills, [
    [root.pid, true],
    [lateDescendant.pid, true],
  ]);
});

test("Windows containment fails when the deadline finds a non-empty tree", async () => {
  const root: WindowsProcessIdentity = {
    pid: 101,
    parentPid: 1,
    processGroupId: null,
    sessionId: null,
    startTime: "root-original",
  };
  let captures = 0;
  const taskkills: Array<[number, boolean]> = [];

  const result = await verifyAndTerminateWindowsProcessTree(
    root.pid,
    { root, descendants: [] },
    {
      captureProcessTable: async () => {
        captures += 1;
        return { entries: [root] };
      },
      terminateProcessIdentity: async (expected) => {
        taskkills.push([expected.pid, true]);
        return { ok: true, error: "" };
      },
    },
    { quiescenceTimeoutMs: 0, quiescencePollMs: 0 },
  );

  assert.deepEqual(result, {
    ok: false,
    error:
      "process-tree quiescence could not be proven before the bounded deadline",
  });
  assert.equal(captures, 1);
  assert.deepEqual(taskkills, []);
});

test("program runner preserves a normal exit with bounded JSON input, cwd, and env", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-program-"));
  const input: TriggerProgramRunInput = {
    invocationId: "invocation-stable",
    stage: "action",
    event: { completedItemText: "deploy" },
  };
  const result = await runner.run(
    {
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.on('data',d=>{const x=JSON.parse(d); console.log(JSON.stringify({ok:true, cwd:process.cwd(), env:process.env.ZENX_FIXTURE, invocationId:x.invocationId}))})",
      ],
      cwd: directory,
      env: { ZENX_FIXTURE: "yes" },
    },
    input,
    new AbortController().signal,
  );
  assert.equal(result.status, "completed");
  assert.match(result.output ?? "", /invocation-stable/u);
  assert.match(result.output ?? "", /"env":"yes"/u);
  assert.match(result.output ?? "", /zenx-program-/u);
});

test("predicate output distinguishes match and non-match", async () => {
  const make = (match: boolean) =>
    runner.run(
      {
        command: process.execPath,
        args: ["-e", `console.log(JSON.stringify({match:${String(match)}}))`],
      },
      {
        invocationId: "predicate-id",
        stage: "predicate",
        event: {},
      },
      new AbortController().signal,
    );
  assert.equal((await make(true)).status, "matched");
  assert.equal((await make(false)).status, "non_match");
});

test("program runner records malformed, nonzero, and oversized outcomes", async () => {
  const malformed = await runner.run(
    { command: process.execPath, args: ["-e", "console.log('nope')"] },
    { invocationId: "malformed", stage: "action", event: {} },
    new AbortController().signal,
  );
  assert.equal(malformed.status, "malformed_output");

  const nonzero = await runner.run(
    {
      command: process.execPath,
      args: ["-e", "console.error('bad'); process.exit(3)"],
    },
    { invocationId: "nonzero", stage: "action", event: {} },
    new AbortController().signal,
  );
  assert.equal(nonzero.status, "nonzero_exit");
  assert.equal(nonzero.exitCode, 3);

  const oversized = await runner.run(
    {
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({ok:true, x:'x'.repeat(1000)}))",
      ],
      maxOutputBytes: 256,
    },
    { invocationId: "oversized", stage: "action", event: {} },
    new AbortController().signal,
  );
  assert.equal(oversized.status, "oversized_output");
});

test("program runner preserves timeout and cancellation outcomes after containment", async () => {
  const timedOut = await runner.run(
    {
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},30000)"],
      timeoutMs: 20,
    },
    { invocationId: "timeout", stage: "action", event: {} },
    new AbortController().signal,
  );
  assert.equal(timedOut.status, "timed_out");

  const controller = new AbortController();
  const cancelled = runner.run(
    { command: process.execPath, args: ["-e", "setTimeout(()=>{},30000)"] },
    { invocationId: "cancel", stage: "action", event: {} },
    controller.signal,
  );
  controller.abort(new Error("fixture cancellation"));
  assert.equal((await cancelled).status, "cancelled");
});

test(
  "program runner preserves cooperative termination",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-program-cooperative-"),
    );
    const ready = path.join(directory, "ready");
    const terminated = path.join(directory, "terminated");
    const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(terminated)},'term');process.exit(0)});setInterval(()=>{},1000);`;
    const controller = new AbortController();
    try {
      const running = runner.run(
        { command: process.execPath, args: ["-e", program] },
        { invocationId: "cooperative", stage: "action", event: {} },
        controller.signal,
      );
      await waitForFile(ready);
      controller.abort(new Error("cooperative fixture"));
      assert.equal((await running).status, "cancelled");
      assert.equal(await waitForFile(terminated), "term");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "program runner escalates from cooperative termination to a hard kill",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-program-hard-kill-"),
    );
    const marker = path.join(directory, "late-marker");
    const ready = path.join(directory, "ready");
    const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{});setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),5000);`;
    const controller = new AbortController();
    try {
      const running = runner.run(
        { command: process.execPath, args: ["-e", program] },
        { invocationId: "hard-kill", stage: "action", event: {} },
        controller.signal,
      );
      const pid = Number(await waitForFile(ready));
      controller.abort(new Error("hard-kill fixture"));
      assert.equal((await running).status, "cancelled");
      await waitForProcessExit(pid);
      await assert.rejects(stat(marker), { code: "ENOENT" });
    } finally {
      await assert.rejects(stat(marker), { code: "ENOENT" });
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("program runner contains a descendant after cancellation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-program-kill-"));
  const marker = path.join(directory, "late-marker");
  const ready = path.join(directory, "ready");
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),5000);`;
  const ignoreTermination =
    process.platform === "win32" ? "" : "process.on('SIGTERM',()=>{});";
  const parent = `const {spawn}=require('node:child_process');${ignoreTermination}spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>process.stdout.write(JSON.stringify({ok:true})+'\\n'),50);`;
  const controller = new AbortController();
  try {
    const running = runner.run(
      {
        command: process.execPath,
        args: ["-e", parent],
        maxOutputBytes: 64 * 1024,
      },
      { invocationId: "contained-cancel", stage: "action", event: {} },
      controller.signal,
    );
    const descendantPid = Number(await waitForFile(ready));
    assert(Number.isInteger(descendantPid) && descendantPid > 0);
    controller.abort(new Error("cancel fixture"));
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.equal(result.output, null);
    await waitForProcessExit(descendantPid);
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally {
    await assert.rejects(stat(marker), { code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  }
});

test("program runner contains descendants when the direct child exits", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-program-tree-close-"),
  );
  const marker = path.join(directory, "late-marker");
  const ready = path.join(directory, "ready");
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),5000);`;
  const exitOnTermination =
    process.platform === "win32"
      ? ""
      : "process.on('SIGTERM',()=>process.exit(0));";
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});${exitOnTermination}setInterval(()=>{},1000);`;
  const controller = new AbortController();
  try {
    const running = runner.run(
      { command: process.execPath, args: ["-e", parent] },
      { invocationId: "tree-close", stage: "action", event: {} },
      controller.signal,
    );
    const descendantPid = Number(await waitForFile(ready));
    assert(Number.isInteger(descendantPid) && descendantPid > 0);
    controller.abort(new Error("tree close fixture"));
    assert.equal((await running).status, "cancelled");
    await waitForProcessExit(descendantPid);
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally {
    await assert.rejects(stat(marker), { code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "program runner rejects an overflowed process-table snapshot instead of proving false quiescence",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await installProcessTableFixture("overflow");
    const ready = path.join(fixture.directory, "ready");
    const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    const controller = new AbortController();
    let pid = 0;
    try {
      const running = runner.run(
        { command: process.execPath, args: ["-e", program] },
        {
          invocationId: "overflowed-process-table",
          stage: "action",
          event: {},
        },
        controller.signal,
      );
      pid = Number(await waitForFile(ready));
      controller.abort(new Error("overflow fixture"));
      const result = await running;
      assert.equal(result.status, "failed");
      assert.match(
        result.error ?? "",
        /process-table snapshot exceeded its 128 KiB bound/u,
      );
      assert.doesNotMatch(
        result.error ?? "",
        /bounded process-tree termination deadline expired/u,
      );
    } finally {
      fixture.restorePath();
      killFixtureProcess(pid);
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);

test(
  "program runner preserves process discovery failure instead of reporting a deadline",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await installProcessTableFixture("failure");
    const ready = path.join(fixture.directory, "ready");
    const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    const controller = new AbortController();
    let pid = 0;
    try {
      const running = runner.run(
        { command: process.execPath, args: ["-e", program] },
        { invocationId: "failed-process-table", stage: "action", event: {} },
        controller.signal,
      );
      pid = Number(await waitForFile(ready));
      controller.abort(new Error("discovery failure fixture"));
      const result = await running;
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /ps exited with code 7/u);
      assert.doesNotMatch(
        result.error ?? "",
        /bounded process-tree termination deadline expired/u,
      );
    } finally {
      fixture.restorePath();
      killFixtureProcess(pid);
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for fixture file: ${file}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Fixture process ${String(pid)} did not exit`);
}

async function installProcessTableFixture(
  mode: "overflow" | "failure",
): Promise<{
  directory: string;
  restorePath(): void;
}> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-process-table-fixture-"),
  );
  const state = path.join(directory, "captured-once");
  const ready = path.join(directory, "ready");
  const overflowOutput = path.join(directory, "overflow-output");
  const executable = path.join(directory, "ps");
  const originalPath = process.env.PATH;
  const source = `#!/bin/sh
state=${JSON.stringify(state)}
ready=${JSON.stringify(ready)}
if [ ! -f "$state" ]; then
  : > "$state"
  IFS= read -r pid < "$ready"
  case "$*" in
    *sid=*) printf '%s 1 %s %s Thu Jan  1 00:00:00 1970\\n' "$pid" "$pid" "$pid" ;;
    *) printf '%s 1 %s Thu Jan  1 00:00:00 1970\\n' "$pid" "$pid" ;;
  esac
  exit 0
fi
if [ ${JSON.stringify(mode)} = failure ]; then exit 7; fi
exec /bin/cat ${JSON.stringify(overflowOutput)}
`;
  await writeFile(
    overflowOutput,
    "900000 1 900000 900000 Thu Jan  1 00:00:00 1970\n".repeat(8_000),
    "utf8",
  );
  await writeFile(executable, source, "utf8");
  await chmod(executable, 0o755);
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
  return {
    directory,
    restorePath: () => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    },
  };
}

function killFixtureProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function spawnWindowsIdentityFixture(): Promise<{
  child: ReturnType<typeof spawn>;
  identity: WindowsProcessIdentity & { startTime: string };
}> {
  const script = [
    "$start = [System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks",
    "$start -= $start % 10",
    '[Console]::Out.WriteLine("$PID|$start")',
    "[Console]::Out.Flush()",
    "while ($true) { Start-Sleep -Seconds 1 }",
  ].join("; ");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  assert(child.pid !== undefined);
  assert(child.stdout !== null);
  const line = await new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (value: string | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (value instanceof Error) {
        killFixtureProcess(child.pid!);
        reject(value);
      } else resolve(value);
    };
    const onData = (chunk: string): void => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline >= 0) finish(output.slice(0, newline).trim());
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null): void =>
      finish(
        new Error(
          `Windows identity fixture exited with code ${String(code)} before reporting its identity`,
        ),
      );
    const timer = setTimeout(
      () => finish(new Error("Windows identity fixture did not become ready")),
      10_000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  const match = line.match(/^(\d+)\|(\d+)$/u);
  if (match === null || Number(match[1]) !== child.pid) {
    killFixtureProcess(child.pid);
    throw new Error("Windows identity fixture reported an invalid identity");
  }
  return {
    child,
    identity: {
      pid: child.pid,
      parentPid: process.pid,
      processGroupId: null,
      sessionId: null,
      startTime: match[2]!,
    },
  };
}
