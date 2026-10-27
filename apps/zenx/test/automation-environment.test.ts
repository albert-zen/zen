import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AutomationEnvironment } from "../src/main/automation-environment.js";

function fixture(idle = "active") {
  const monitor = Object.assign(new EventEmitter(), {
    idle,
    getSystemIdleState() {
      return this.idle;
    },
  });
  const started: string[] = [],
    stopped: number[] = [];
  const environment = new AutomationEnvironment({
    platform: "win32",
    monitor,
    blocker: {
      start(kind) {
        started.push(kind);
        return started.length;
      },
      stop(id) {
        stopped.push(id);
      },
    },
  });
  return { environment, monitor, started, stopped };
}

test("a locked desktop refuses GUI admission without trying to unlock or wake it", () => {
  const f = fixture("locked");
  assert.equal(f.environment.snapshot().sessionState, "locked");
  assert.equal(f.environment.snapshot().lockedUse, "unsupported");
  assert.throws(
    () => f.environment.acquire(new AbortController().signal),
    /locked/,
  );
  assert.deepEqual(f.started, []);
  f.environment.close();
});

test("lock aborts current work and retires observations, but wake blocker lives until native settlement", () => {
  const f = fixture();
  let retired = 0;
  f.environment.onInvalidated(() => retired++);
  const lease = f.environment.acquire(new AbortController().signal);
  f.monitor.idle = "locked";
  f.monitor.emit("lock-screen");
  assert.equal(lease.signal.aborted, true);
  assert.equal(retired, 1);
  assert.deepEqual(f.stopped, []);
  lease.release();
  lease.release();
  assert.deepEqual(f.stopped, [1]);
  f.monitor.idle = "active";
  f.monitor.emit("unlock-screen");
  assert.equal(retired, 2);
  assert.equal(
    lease.signal.aborted,
    true,
    "unlock never revives an old admission",
  );
  const fresh = f.environment.acquire(new AbortController().signal);
  assert.equal(fresh.signal.aborted, false);
  fresh.release();
  f.environment.close();
});

test("system sleep and resume invalidate refs independently of display sleep", () => {
  const f = fixture();
  let retired = 0;
  f.environment.onInvalidated(() => retired++);
  f.monitor.emit("suspend");
  assert.throws(
    () => f.environment.acquire(new AbortController().signal),
    /suspended/,
  );
  f.monitor.emit("resume");
  assert.equal(retired, 2);
  assert.equal(f.environment.snapshot().displayState, "unknown");
  const lease = f.environment.acquire(new AbortController().signal);
  assert.deepEqual(f.started, ["prevent-app-suspension"]);
  lease.release();
  f.environment.close();
});

test("shared active calls hold one bounded-lifetime blocker and close removes OS subscriptions", () => {
  const f = fixture();
  const first = f.environment.acquire(new AbortController().signal);
  const second = f.environment.acquire(new AbortController().signal);
  assert.equal(f.started.length, 1);
  first.release();
  assert.deepEqual(f.stopped, []);
  second.release();
  assert.deepEqual(f.stopped, [1]);
  f.environment.close();
  assert.equal(f.monitor.listenerCount("lock-screen"), 0);
  assert.throws(
    () => f.environment.acquire(new AbortController().signal),
    /closed/,
  );
});

test("a missed OS lock notification is caught at the next admission probe", () => {
  const f = fixture();
  f.monitor.idle = "locked";
  assert.throws(
    () => f.environment.acquire(new AbortController().signal),
    /locked/,
  );
  f.environment.close();
});

test("an unavailable session probe retires old observations and refuses new GUI admission", () => {
  for (const unavailable of ["unknown", "throws"]) {
    const f = fixture();
    let retired = 0;
    f.environment.onInvalidated(() => retired++);
    const pending = f.environment.acquire(new AbortController().signal);
    f.monitor.getSystemIdleState = () => {
      if (unavailable === "throws") throw new Error("OS probe unavailable");
      return unavailable;
    };
    assert.throws(
      () => f.environment.acquire(new AbortController().signal),
      /unknown.*No input dispatched/,
    );
    assert.equal(pending.signal.aborted, true);
    assert.equal(retired, 1);
    assert.equal(f.environment.snapshot().sessionState, "unknown");
    assert.equal(f.started.length, 1, "rejected admission starts no blocker");
    assert.deepEqual(
      f.stopped,
      [],
      "pending native work still owns its blocker",
    );
    pending.release();
    assert.deepEqual(f.stopped, [1]);
    f.monitor.getSystemIdleState = () => "active";
    const fresh = f.environment.acquire(new AbortController().signal);
    assert.equal(
      retired,
      2,
      "fresh active evidence still requires new observations",
    );
    assert.equal(fresh.signal.aborted, false);
    fresh.release();
    f.environment.close();
  }
});

test("macOS fresh native accessibility admission works while locked without admitting foreground input", async () => {
  const monitor = Object.assign(new EventEmitter(), {
    getSystemIdleState: () => "locked",
  });
  const environment = new AutomationEnvironment({
    platform: "darwin",
    monitor,
    nativeSessionProbe: async () => "locked",
  });
  await environment.refresh();
  const caller = new AbortController().signal;
  const lease = environment.acquire(caller, "native-targeted-accessibility");
  assert.equal(lease.signal.aborted, false);
  assert.equal(environment.snapshot().sessionState, "locked");
  assert.throws(() => environment.acquire(caller), /locked/);
  monitor.emit("unlock-screen");
  assert.equal(
    lease.signal.aborted,
    true,
    "session changes retire even scoped admissions",
  );
  lease.release();
  environment.close();
});

test("targeted accessibility does not admit unknown, suspended or non-macOS locked sessions", () => {
  const caller = new AbortController().signal;
  const f = fixture("locked");
  assert.throws(
    () => f.environment.acquire(caller, "native-targeted-accessibility"),
    /locked/,
  );
  f.environment.close();
  const monitor = Object.assign(new EventEmitter(), {
    getSystemIdleState: () => "unknown",
  });
  const environment = new AutomationEnvironment({
    platform: "darwin",
    monitor,
  });
  assert.throws(
    () => environment.acquire(caller, "native-targeted-accessibility"),
    /unknown/,
  );
  monitor.emit("suspend");
  assert.throws(
    () => environment.acquire(caller, "native-targeted-accessibility"),
    /suspended/,
  );
  environment.close();
});

test("macOS startup ignores Electron active when native session is already locked", async () => {
  const monitor = Object.assign(new EventEmitter(), {
    getSystemIdleState: () => "active",
  });
  const environment = new AutomationEnvironment({
    platform: "darwin",
    monitor,
    nativeSessionProbe: async () => "locked",
  });
  assert.equal(
    environment.snapshot().sessionState,
    "unknown",
    "no optimistic active state before native probe",
  );
  await environment.refresh();
  assert.equal(environment.snapshot().sessionState, "locked");
  assert.throws(
    () => environment.acquire(new AbortController().signal),
    /locked/,
  );
  environment.close();
});

test("native probe failure stays unknown and a late unlocked result cannot overwrite lock", async () => {
  const monitor = Object.assign(new EventEmitter(), {
    getSystemIdleState: () => "active",
  });
  let resolve!: (state: "active") => void;
  const pending = new Promise<"active">((done) => {
    resolve = done;
  });
  const environment = new AutomationEnvironment({
    platform: "darwin",
    monitor,
    nativeSessionProbe: () => pending,
  });
  const refresh = environment.refresh();
  monitor.emit("lock-screen");
  resolve("active");
  await refresh;
  assert.equal(environment.snapshot().sessionState, "locked");
  environment.close();
  const failed = new AutomationEnvironment({
    platform: "darwin",
    monitor,
    nativeSessionProbe: async () => {
      throw new Error("native unavailable");
    },
  });
  await failed.refresh();
  assert.equal(failed.snapshot().sessionState, "unknown");
  failed.close();
});
