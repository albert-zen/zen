import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ForegroundActivity } from "../src/main/foreground-activity.js";
import {
  MacForegroundInputDriver,
  runProcess,
} from "../src/main/capabilities/computer-provider.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const invocation = () => ({
  callId: "owned-helper",
  name: "computer_foreground_key_press",
  arguments: { key: "enter" },
  cwd: "/tmp",
  signal: new AbortController().signal,
});
function activity() {
  return new ForegroundActivity({
    presenter: { update: async () => {}, close: () => {} },
    agentName: () => "Owned fixture",
    report: () => {},
  });
}
function fakeChild(kill: () => boolean, pid: number | undefined = 42) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdin: Object.assign(new EventEmitter(), { end() {} }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill,
  });
}

for (const killResult of ["sent", "false", "throws", "error event"] as const) {
  test(`Mac foreground cancellation waits for native close when kill ${killResult}`, async () => {
    let killRequests = 0;
    const child = fakeChild(() => {
      killRequests++;
      if (killResult === "throws") throw new Error("EPERM");
      if (killResult === "error event") child.emit("error", new Error("ESRCH"));
      return killResult === "sent";
    });
    const driver = new MacForegroundInputDriver("/unused", {
      compile: async () => "/owned/helper",
      runProcess: (command, args, timeout, stdin, signal, _spawn, onStopping) =>
        runProcess(
          command,
          args,
          timeout,
          stdin,
          signal,
          (() => child) as unknown as typeof spawn,
          onStopping,
        ),
    });
    const owner = activity();
    let settled = false;
    const running = owner.run(invocation(), (signal, onStopping) =>
      driver.run({ operation: "key", key: "enter" }, signal, onStopping),
    );
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = assert.rejects(running, /stopped by user/);
    try {
      await tick();
      owner.stop(owner.snapshot.activities.map((item) => item.id));
      await tick();
      assert.equal(killRequests, 1);
      assert.equal(settled, false);
      assert.equal(owner.snapshot.activities.length, 1);
      assert.equal(owner.snapshot.activities[0]?.stopping, true);
      child.emit("exit", null, "SIGKILL");
      await tick();
      assert.equal(
        settled,
        false,
        "exit alone must not retire a pending native close",
      );
    } finally {
      child.emit("close", null, "SIGKILL");
    }
    await rejected;
    assert.equal(owner.snapshot.activities.length, 0);
    owner.close();
  });
}

test("native helper timeout announces stopping but cannot fabricate close after a failed kill", async () => {
  let killRequests = 0;
  const child = fakeChild(() => {
    killRequests++;
    return false;
  });
  const driver = new MacForegroundInputDriver("/unused", {
    compile: async () => "/owned/helper",
    runProcess: (command, args, _timeout, stdin, signal, _spawn, onStopping) =>
      runProcess(
        command,
        args,
        10,
        stdin,
        signal,
        (() => child) as unknown as typeof spawn,
        onStopping,
      ),
  });
  const owner = activity();
  let settled = false;
  const running = owner.run(invocation(), (signal, onStopping) =>
    driver.run({ operation: "key", key: "enter" }, signal, onStopping),
  );
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejected = assert.rejects(running, /helper timed out after 10ms/);
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(killRequests, 1);
    assert.equal(settled, false);
    assert.equal(owner.snapshot.activities[0]?.stopping, true);
    child.emit(
      "error",
      new Error("later error must not replace original timeout"),
    );
    await tick();
    assert.equal(settled, false);
    assert.equal(killRequests, 1);
  } finally {
    child.emit("close", 0, null);
  }
  await rejected;
  assert.equal(owner.snapshot.activities.length, 0);
  owner.close();
});

test("confirmed spawn failure settles without waiting for a nonexistent helper", async () => {
  let killRequests = 0;
  const child = fakeChild(() => {
    killRequests++;
    return false;
  });
  Reflect.deleteProperty(child, "pid");
  const running = runProcess(
    "/missing/helper",
    [],
    10_000,
    undefined,
    undefined,
    (() => child) as unknown as typeof spawn,
  );
  const rejected = assert.rejects(running, /ENOENT/);
  child.emit("error", new Error("ENOENT"));
  await rejected;
  assert.equal(killRequests, 0);
});

test("actual owned Node child closes before the foreground indicator reports settlement", async () => {
  let child: ChildProcess | undefined;
  let nativeClosed = false;
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const owner = activity();
  const running = owner.run(invocation(), (signal, onStopping) =>
    runProcess(
      process.execPath,
      ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
      3_000,
      undefined,
      signal,
      ((...args: Parameters<typeof spawn>) => {
        child = spawn(...args);
        child.stdout?.once("data", ready);
        child.once("close", () => {
          nativeClosed = true;
        });
        return child;
      }) as typeof spawn,
      onStopping,
    ),
  );
  const rejected = assert.rejects(running, /stopped by user/);
  try {
    await readiness;
    owner.stop(owner.snapshot.activities.map((item) => item.id));
    assert.equal(owner.snapshot.activities[0]?.stopping, true);
    await rejected;
    assert.equal(nativeClosed, true);
    assert.equal(owner.snapshot.activities.length, 0);
  } finally {
    if (child && !nativeClosed) child.kill("SIGKILL");
    owner.close();
  }
});
