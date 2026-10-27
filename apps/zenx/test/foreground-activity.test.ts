import assert from "node:assert/strict";
import test from "node:test";
import {
  ForegroundActivity,
  type ForegroundActivitySnapshot,
} from "../src/main/foreground-activity.js";
import {
  ComputerZenXCapabilityPackage,
  type ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";
import type { ToolInvocation } from "../../../src/tool.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    callId: "call",
    canonicalToolCallId: "canonical-call",
    name: "computer_foreground_click",
    arguments: { x: 10, y: 20 },
    cwd: "/fixture",
    signal: new AbortController().signal,
    threadId: "thread",
    ...overrides,
  };
}
function fixture() {
  const snapshots: ForegroundActivitySnapshot[] = [];
  const errors: unknown[] = [];
  const owners: ToolInvocation[] = [];
  let closed = false;
  const activity = new ForegroundActivity({
    presenter: {
      update: async (snapshot) => {
        snapshots.push(snapshot);
      },
      close: () => {
        closed = true;
      },
    },
    agentName: () => "Atlas",
    stopOwner: async (owner) => {
      owners.push(owner);
    },
    report: (error) => errors.push(error),
  });
  return {
    activity,
    snapshots,
    errors,
    owners,
    get closed() {
      return closed;
    },
  };
}

test("foreground input waits for indicator rendering and cleans up on success", async () => {
  const painted = deferred();
  const states: ForegroundActivitySnapshot[] = [];
  let started = false;
  const activity = new ForegroundActivity({
    presenter: {
      update: async (state) => {
        states.push(state);
        if (state.activities.length) await painted.promise;
      },
      close: () => {},
    },
    agentName: () => "Atlas",
    report: () => {},
  });
  const result = activity.run(invocation(), async () => {
    started = true;
    return 42;
  });
  await tick();
  assert.equal(started, false);
  assert.equal(states[0]?.activities[0]?.agentName, "Atlas");
  assert.equal(states[0]?.activities[0]?.action, "click");
  painted.resolve();
  assert.equal(await result, 42);
  assert.equal(activity.snapshot.activities.length, 0);
  assert.equal(states.at(-1)?.activities.length, 0);
});

test("failed indicator never dispatches foreground input", async () => {
  let started = false;
  const activity = new ForegroundActivity({
    presenter: {
      update: async (state) => {
        if (state.activities.length) throw new Error("render unavailable");
      },
      close: () => {},
    },
    agentName: () => "Agent",
    report: () => {},
  });
  await assert.rejects(
    activity.run(invocation(), async () => {
      started = true;
    }),
    /render unavailable/,
  );
  assert.equal(started, false);
  assert.equal(activity.snapshot.activities.length, 0);
});

test("concurrent calls are counted independently through success and failure", async () => {
  const { activity, snapshots } = fixture();
  const a = deferred();
  const b = deferred();
  const first = activity.run(invocation(), () => a.promise);
  const second = activity.run(
    invocation({ callId: "second" }),
    () => b.promise,
  );
  await tick();
  assert.equal(activity.snapshot.activities.length, 2);
  a.resolve();
  await first;
  assert.equal(activity.snapshot.activities.length, 1);
  assert.equal(snapshots.at(-1)?.activities.length, 1);
  const rejected = assert.rejects(second, /backend failure/);
  b.reject(new Error("backend failure"));
  await rejected;
  assert.equal(activity.snapshot.activities.length, 0);
});

test("Stop cancels only displayed owners and keeps stopping visible until settlement", async () => {
  const { activity, owners } = fixture();
  const a = deferred();
  const b = deferred();
  let firstSignal!: AbortSignal;
  let secondSignal!: AbortSignal;
  const first = activity.run(invocation(), (signal) => {
    firstSignal = signal;
    return a.promise;
  });
  const second = activity.run(
    invocation({ callId: "other", threadId: "other" }),
    (signal) => {
      secondSignal = signal;
      return b.promise;
    },
  );
  await tick();
  const firstId = activity.snapshot.activities[0]!.id;
  activity.stop([firstId, "forged"]);
  activity.stop([firstId]);
  assert.equal(firstSignal.aborted, true);
  assert.equal(secondSignal.aborted, false);
  assert.equal(activity.snapshot.activities.length, 2);
  assert.deepEqual(
    activity.snapshot.activities.map((item) => item.stopping),
    [true, false],
  );
  assert.equal(owners.length, 1);
  a.resolve();
  await first;
  assert.equal(activity.snapshot.activities.length, 1);
  b.resolve();
  await second;
  assert.equal(activity.snapshot.activities.length, 0);
});

test("external cancellation while rendering cannot dispatch; provider cancellation remains visible", async () => {
  const { activity } = fixture();
  const controller = new AbortController();
  const pending = deferred();
  const running = activity.run(
    invocation({ signal: controller.signal }),
    () => pending.promise,
  );
  await tick();
  controller.abort();
  assert.equal(activity.snapshot.activities[0]?.stopping, true);
  pending.resolve();
  await running;
  assert.equal(activity.snapshot.activities.length, 0);
});

test("renderer loss cancels active input and shutdown cannot admit another call", async () => {
  const state = fixture();
  const pending = deferred();
  let signal!: AbortSignal;
  const running = state.activity.run(invocation(), (value) => {
    signal = value;
    return pending.promise;
  });
  await tick();
  state.activity.unavailable(new Error("renderer crashed"));
  assert.equal(signal.aborted, true);
  assert.equal(state.activity.snapshot.activities[0]?.stopping, true);
  state.activity.close();
  assert.equal(state.closed, true);
  await assert.rejects(
    state.activity.run(invocation(), async () => {}),
    /closed/,
  );
  pending.resolve();
  await running;
  assert.equal(state.activity.snapshot.activities.length, 0);
});

test("foreground hook never runs for background, invalid args, or missing consent", async () => {
  const calls: string[] = [];
  const runner = {
    run: async <T>(
      _invocation: ToolInvocation,
      operation: (signal: AbortSignal) => Promise<T>,
    ) => {
      calls.push("indicator");
      return operation(new AbortController().signal);
    },
  };
  const backend = {
    listWindows: async () => ({ windows: [] }),
    foregroundClick: async () => {
      calls.push("input");
    },
  } as unknown as ZenXComputerBackend;
  const denied = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    false,
    runner,
  );
  await assert.rejects(
    denied.invoke("computer_foreground_click", invocation()),
    /foreground_required/,
  );
  const allowed = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    true,
    runner,
  );
  await allowed.invoke(
    "computer_list_windows",
    invocation({ name: "computer_list_windows", arguments: {} }),
  );
  await assert.rejects(
    allowed.invoke(
      "computer_foreground_click",
      invocation({ arguments: { x: "bad", y: 1 } }),
    ),
    /finite/,
  );
  assert.deepEqual(calls, []);
});

test("indicator cancellation window fences consent revocation and never sends input", async () => {
  const state = fixture();
  let sent = false;
  const backend = {
    foregroundClick: async () => {
      sent = true;
    },
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    true,
    state.activity,
  );
  const running = computer.invoke("computer_foreground_click", invocation());
  await tick();
  computer.setForegroundControlAllowed(false);
  await assert.rejects(running, /foreground_required/);
  assert.equal(sent, false);
  assert.equal(state.activity.snapshot.activities.length, 0);
});

test("indicator comes before existing notice and actual backend invocation", async () => {
  const state = fixture();
  const backend = {
    foregroundClick: async (
      _x: number,
      _y: number,
      _button: string,
      _signal: AbortSignal,
      onStopping?: () => void,
    ) => {
      assert.equal(state.activity.snapshot.activities.length, 1);
      onStopping?.();
      assert.equal(state.activity.snapshot.activities[0]?.stopping, true);
    },
  } as unknown as ZenXComputerBackend;
  const computer = new ComputerZenXCapabilityPackage(
    backend,
    undefined,
    true,
    state.activity,
  );
  const started = Date.now();
  const result = await computer.invoke(
    "computer_foreground_click",
    invocation(),
  );
  assert.ok(Date.now() - started >= 900);
  assert.equal((result as { impact: string }).impact, "foreground_takeover");
  assert.equal(state.activity.snapshot.activities.length, 0);
});
