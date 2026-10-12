import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { restoreLoginShellPath } from "../src/main/login-shell-environment.js";

const minimalPath = "/usr/bin:/bin:/usr/sbin:/sbin";

test("GUI launch waits for framed login-shell PATH before mutating only PATH", async (t) => {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  Object.defineProperty(child, "stdout", { value: stdout });
  let command = "";
  t.mock.method(
    childProcess,
    "spawn",
    (shell: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      assert.equal(shell, "/bin/zsh");
      assert.equal(args[0], "-ilc");
      assert.equal(options.env.PATH, minimalPath);
      command = args[1]!;
      return child;
    },
  );
  const environment = {
    PATH: minimalPath,
    SHELL: "/bin/zsh",
    HOME: "/Users/test",
    API_KEY: "existing-secret",
  };
  const pending = restoreLoginShellPath({
    platform: "darwin",
    environment,
    fromTerminal: false,
  });
  assert.equal(environment.PATH, minimalPath);
  const marker = command.match(/ZENX_PATH_[a-f0-9]+/u)![0];
  stdout.write(
    `startup noise\nAPI_KEY=do-not-import\n\0${marker}\0/Users/test/.local/bin:${minimalPath}\0${marker}\0logout noise`,
  );
  child.emit("close", 0, null);
  assert.equal(await pending, "restored");
  assert.deepEqual(environment, {
    PATH: `/Users/test/.local/bin:${minimalPath}`,
    SHELL: "/bin/zsh",
    HOME: "/Users/test",
    API_KEY: "existing-secret",
  });
});

function mockShell(t: TestContext) {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  Object.defineProperty(child, "stdout", { value: stdout });
  const kill = t.mock.method(child, "kill", () => true);
  let command = "";
  const spawn = t.mock.method(
    childProcess,
    "spawn",
    (_shell: string, args: string[]) => {
      command = args[1]!;
      return child;
    },
  );
  return {
    child,
    stdout,
    kill,
    spawn,
    frame(path: string | Buffer) {
      const marker = command.match(/ZENX_PATH_[a-f0-9]+/u)![0];
      return Buffer.concat([
        Buffer.from(`\0${marker}\0`),
        Buffer.from(path),
        Buffer.from(`\0${marker}\0`),
      ]);
    },
    complete(path: string) {
      stdout.write(this.frame(path));
      child.emit("close", 0, null);
    },
  };
}

for (const platform of ["linux", "win32"] as const)
  test(`${platform} preserves the inherited environment without invoking a shell`, async (t) => {
    const shell = mockShell(t);
    const environment = { PATH: "custom", SECRET_KEY: "keep-host-only" };
    assert.equal(
      await restoreLoginShellPath({
        platform,
        environment,
        fromTerminal: false,
      }),
      "skipped",
    );
    assert.equal(shell.spawn.mock.callCount(), 0);
    assert.deepEqual(environment, {
      PATH: "custom",
      SECRET_KEY: "keep-host-only",
    });
  });

for (const marker of [
  { TERM_PROGRAM: "Apple_Terminal" },
  { TERM: "xterm-256color" },
])
  test(`terminal marker ${JSON.stringify(marker)} preserves its deliberately supplied PATH`, async (t) => {
    const shell = mockShell(t);
    const environment = { ...marker, PATH: "/custom/bin:/usr/bin" };
    assert.equal(
      await restoreLoginShellPath({ platform: "darwin", environment }),
      "skipped",
    );
    assert.equal(shell.spawn.mock.callCount(), 0);
    assert.equal(environment.PATH, "/custom/bin:/usr/bin");
  });

test("explicit terminal detection preserves PATH even without terminal variables", async (t) => {
  const shell = mockShell(t);
  assert.equal(
    await restoreLoginShellPath({
      platform: "darwin",
      environment: {},
      fromTerminal: true,
    }),
    "skipped",
  );
  assert.equal(shell.spawn.mock.callCount(), 0);
});

for (const path of [
  "",
  "/usr/bin:",
  "relative:/usr/bin",
  "/usr/bin\0SECRET=bad",
])
  test(`malformed PATH ${JSON.stringify(path)} cannot replace the inherited PATH`, async (t) => {
    const shell = mockShell(t);
    const environment = { PATH: minimalPath, SHELL: "/bin/zsh" };
    const pending = restoreLoginShellPath({
      platform: "darwin",
      environment,
      fromTerminal: false,
    });
    shell.complete(path);
    assert.equal(await pending, "invalid-output");
    assert.equal(environment.PATH, minimalPath);
  });

for (const output of [
  "empty",
  "unframed",
  "truncated",
  "duplicate",
  "invalid-utf8",
] as const)
  test(`${output} shell output falls back without importing arbitrary exports`, async (t) => {
    const shell = mockShell(t);
    const environment = { PATH: minimalPath, SHELL: "/bin/zsh" };
    const pending = restoreLoginShellPath({
      platform: "darwin",
      environment,
      fromTerminal: false,
    });
    const frame = shell.frame(
      output === "invalid-utf8" ? Buffer.from([0xff]) : "/usr/bin",
    );
    shell.stdout.write(
      output === "empty"
        ? ""
        : output === "unframed"
          ? "PATH=/evil\nNODE_OPTIONS=bad"
          : output === "truncated"
            ? frame.subarray(0, -5)
            : output === "duplicate"
              ? Buffer.concat([frame, frame])
              : frame,
    );
    shell.child.emit("close", 0, null);
    assert.equal(await pending, "invalid-output");
    assert.deepEqual(environment, { PATH: minimalPath, SHELL: "/bin/zsh" });
  });

test("bounded output terminates the helper without waiting for close", async (t) => {
  const shell = mockShell(t);
  const environment = { PATH: minimalPath, SHELL: "/bin/zsh" };
  const pending = restoreLoginShellPath({
    platform: "darwin",
    environment,
    fromTerminal: false,
  });
  shell.stdout.write(Buffer.alloc(128 * 1024 + 1));
  assert.equal(await pending, "invalid-output");
  assert.equal(shell.kill.mock.callCount(), 1);
  assert.equal(shell.stdout.destroyed, true);
  assert.equal(environment.PATH, minimalPath);
});

test("hung login shell times out and late output cannot mutate PATH", async (t) => {
  const shell = mockShell(t);
  const environment = { PATH: minimalPath, SHELL: "/bin/zsh" };
  const pending = restoreLoginShellPath({
    platform: "darwin",
    environment,
    fromTerminal: false,
    timeoutMs: 10,
  });
  assert.equal(await pending, "timed-out");
  shell.child.emit("close", 0, null);
  assert.equal(shell.kill.mock.callCount(), 1);
  assert.equal(environment.PATH, minimalPath);
});

test("Quit cancels promptly and prevents a late PATH publication", async (t) => {
  const shell = mockShell(t);
  const controller = new AbortController();
  const environment = { PATH: minimalPath, SHELL: "/bin/zsh" };
  const pending = restoreLoginShellPath({
    platform: "darwin",
    environment,
    fromTerminal: false,
    signal: controller.signal,
  });
  shell.stdout.write(shell.frame("/custom/bin:/usr/bin"));
  controller.abort();
  assert.equal(await pending, "cancelled");
  shell.child.emit("close", 0, null);
  assert.equal(shell.kill.mock.callCount(), 1);
  assert.equal(environment.PATH, minimalPath);
});

test("already cancelled startup never spawns", async (t) => {
  const shell = mockShell(t);
  assert.equal(
    await restoreLoginShellPath({
      platform: "darwin",
      environment: {},
      fromTerminal: false,
      signal: AbortSignal.abort(),
    }),
    "cancelled",
  );
  assert.equal(shell.spawn.mock.callCount(), 0);
});

for (const failure of ["throw", "error", "exit"] as const)
  test(`${failure} shell failure retains the existing PATH`, async (t) => {
    const shell = mockShell(t);
    if (failure === "throw")
      shell.spawn.mock.mockImplementation(() => {
        throw new Error("spawn failed");
      });
    const environment = { PATH: minimalPath, SHELL: "/bin/zsh" };
    const pending = restoreLoginShellPath({
      platform: "darwin",
      environment,
      fromTerminal: false,
    });
    if (failure === "error") shell.child.emit("error", new Error("ENOENT"));
    if (failure === "exit") {
      shell.stdout.write(shell.frame("/uncommitted"));
      shell.child.emit("close", 1, null);
    }
    assert.equal(await pending, "failed");
    assert.equal(environment.PATH, minimalPath);
  });

for (const shellPath of [
  "zsh",
  "/bin/zsh -c evil",
  "/usr/bin/false",
  "/bin/zsh\0",
])
  test(`unsupported SHELL ${JSON.stringify(shellPath)} is never executed`, async (t) => {
    const shell = mockShell(t);
    assert.equal(
      await restoreLoginShellPath({
        platform: "darwin",
        environment: { SHELL: shellPath },
        fromTerminal: false,
      }),
      "unsupported-shell",
    );
    assert.equal(shell.spawn.mock.callCount(), 0);
  });

test("an empty inherited environment can receive a framed PATH", async (t) => {
  const shell = mockShell(t);
  const environment: NodeJS.ProcessEnv = {};
  const pending = restoreLoginShellPath({
    platform: "darwin",
    environment,
    fromTerminal: false,
  });
  shell.complete(minimalPath);
  assert.equal(await pending, "restored");
  assert.deepEqual(environment, { PATH: minimalPath });
});
