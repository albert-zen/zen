/**
 * Synthetic dbus-next boundary tests. No session bus, compositor, configuration,
 * physical shortcut, user permission, or native capture is exercised here.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Message } from "dbus-next";
import {
  niriAppShotBinding,
  niriAppShotIdentity,
  startNiriAppShotShortcut,
  type NiriAppShotShortcutDependencies,
  type NiriAppShotShortcutOptions,
} from "../src/main/app-shot-niri-shortcut.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeBus extends EventEmitter {
  readonly _connection = Object.assign(new EventEmitter(), {
    stream: new EventEmitter(),
  });
  readonly requested = deferred<void>();
  readonly names: Array<{ name: string; flags: number }> = [];
  readonly replies: Message[] = [];
  readonly retained: Array<(message: Message) => boolean> = [];
  response = Promise.resolve(1);
  handler: ((message: Message) => boolean) | undefined;
  disconnected = 0;
  removed = 0;

  requestName(name: string, flags: number): Promise<number> {
    this.names.push({ name, flags });
    this.requested.resolve(undefined);
    return this.response;
  }

  addMethodHandler(handler: (message: Message) => boolean): void {
    this.handler = handler;
    this.retained.push(handler);
  }

  removeMethodHandler(handler: (message: Message) => boolean): void {
    assert.equal(handler, this.handler);
    this.handler = undefined;
    this.removed++;
  }

  disconnect(): void {
    this.disconnected++;
  }

  send(message: Message): void {
    this.replies.push(message);
  }

  receive(message: Message): boolean {
    assert.ok(this.handler);
    return this.handler(message);
  }
}

type DbusModule = Awaited<
  ReturnType<NonNullable<NiriAppShotShortcutDependencies["loadDbus"]>>
>;

function fakeModule(bus: FakeBus): DbusModule {
  return {
    sessionBus: () => bus,
    NameFlag: { DO_NOT_QUEUE: 4 },
    RequestNameReply: { PRIMARY_OWNER: 1 },
    MessageType: { ERROR: 3 },
    Message: {
      newMethodReturn: (
        message: Message,
        signature = "",
        body: unknown[] = [],
      ) =>
        ({
          type: 2,
          replySerial: message.serial,
          destination: message.sender,
          signature,
          body,
        }) as unknown as Message,
    },
  } as unknown as DbusModule;
}

function fixture() {
  const bus = new FakeBus();
  const state = { owner: true, captures: 0, loads: 0 };
  const failures: Error[] = [];
  const timers: Array<{
    callback: () => void;
    milliseconds: number;
    cancelled: boolean;
  }> = [];
  const options: NiriAppShotShortcutOptions = {
    isCurrentOwner: () => state.owner,
    onCapture: () => {
      state.captures++;
    },
    onFailure: (error) => failures.push(error),
  };
  const dependencies: NiriAppShotShortcutDependencies = {
    loadDbus: async () => {
      state.loads++;
      return fakeModule(bus);
    },
    scheduleTimeout: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return { bus, state, options, dependencies, timers, failures };
}

function message(changes: Partial<Message> = {}, development = false): Message {
  const identity = niriAppShotIdentity(development);
  return {
    type: 1,
    serial: 45,
    path: identity.objectPath,
    interface: identity.interfaceName,
    member: "Capture",
    signature: "",
    body: [],
    sender: ":1.41",
    ...changes,
  } as Message;
}

describe("Niri App Shot manual binding", () => {
  for (const development of [false, true]) {
    it("uses distinct Zen-owned identities: " + development, () => {
      const identity = niriAppShotIdentity(development);
      const base = development
        ? "io.github.albert_zen.ZenX.Development"
        : "io.github.albert_zen.ZenX";
      const path = development
        ? "/io/github/albert_zen/ZenX/Development/AppShot"
        : "/io/github/albert_zen/ZenX/AppShot";
      assert.deepEqual(identity, {
        busName: base + ".AppShot",
        interfaceName: base + ".AppShot",
        objectPath: path,
      });
      assert.ok(Object.isFrozen(identity));
      const expected = `Ctrl+Shift+2 repeat=false { spawn "gdbus" "call" "--session" "--dest" "${base}.AppShot" "--object-path" "${path}" "--method" "${base}.AppShot.Capture"; }`;
      assert.equal(niriAppShotBinding(development), expected);
      assert.doesNotMatch(niriAppShotBinding(development), /t3|sh -c|exec/i);
    });
  }
});

describe("Niri App Shot explicit bus registration", () => {
  for (const development of [false, true]) {
    it("requests only its name: " + development, async () => {
      const f = fixture();
      assert.equal(f.state.loads, 0);
      const handle = await startNiriAppShotShortcut(
        { ...f.options, development },
        f.dependencies,
      );
      assert.equal(f.state.loads, 1);
      assert.deepEqual(f.bus.names, [
        {
          name: niriAppShotIdentity(development).busName,
          flags: 4,
        },
      ]);
      assert.equal(f.timers[0]?.milliseconds, 5000);
      assert.equal(f.timers[0]?.cancelled, true);
      assert.equal(f.bus.receive(message({}, development)), true);
      assert.equal(f.state.captures, 1);
      assert.equal(f.bus.replies[0]?.replySerial, 45);
      assert.deepEqual(f.bus.replies[0]?.body, []);
      handle.stop();
      handle.stop();
      assert.equal(f.bus.disconnected, 1);
      assert.equal(f.bus.removed, 1);
    });
  }

  it("does not handle another path, interface, or method", async () => {
    const f = fixture();
    const handle = await startNiriAppShotShortcut(f.options, f.dependencies);
    for (const changed of [
      { path: "/other" },
      { interface: "org.example.Other" },
      { member: "Other" },
    ]) {
      assert.equal(f.bus.receive(message(changed)), false);
    }
    assert.equal(f.state.captures, 0);
    assert.deepEqual(f.bus.replies, []);
    handle.stop();
  });

  it("rejects arguments and retains the numeric reply serial", async () => {
    const f = fixture();
    const handle = await startNiriAppShotShortcut(f.options, f.dependencies);
    for (const changed of [{ signature: "s" }, { body: ["unexpected"] }]) {
      assert.equal(f.bus.receive(message(changed)), true);
      const reply = f.bus.replies.at(-1);
      assert.equal(reply?.type, 3);
      assert.equal(reply?.replySerial, 45);
      assert.equal(reply?.errorName, "org.freedesktop.DBus.Error.InvalidArgs");
      assert.deepEqual(reply?.body, ["Capture takes no arguments."]);
    }
    assert.equal(f.state.captures, 0);
    handle.stop();
  });

  it("does not dispatch before becoming the primary owner", async () => {
    const f = fixture();
    const pendingName = deferred<number>();
    f.bus.response = pendingName.promise;
    const pending = startNiriAppShotShortcut(f.options, f.dependencies);
    await f.bus.requested.promise;
    f.bus.receive(message());
    assert.equal(f.state.captures, 0);
    assert.equal(
      f.bus.replies[0]?.errorName,
      "org.freedesktop.DBus.Error.AccessDenied",
    );
    assert.equal(f.bus.disconnected, 0);
    pendingName.resolve(1);
    const handle = await pending;
    f.bus.receive(message());
    assert.equal(f.state.captures, 1);
    handle.stop();
  });

  it("does not load for an obsolete or cancelled owner", async () => {
    const f = fixture();
    f.state.owner = false;
    await assert.rejects(
      startNiriAppShotShortcut(f.options, f.dependencies),
      /owner is no longer current/,
    );
    f.state.owner = true;
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      startNiriAppShotShortcut(
        { ...f.options, signal: abort.signal },
        f.dependencies,
      ),
      { name: "AbortError" },
    );
    assert.equal(f.state.loads, 0);
    assert.deepEqual(f.bus.names, []);
  });

  it("cancels lazy loading without opening the bus", async () => {
    const f = fixture();
    const loading = deferred<DbusModule>();
    const abort = new AbortController();
    const pending = startNiriAppShotShortcut(
      { ...f.options, signal: abort.signal },
      { ...f.dependencies, loadDbus: () => loading.promise },
    );
    const rejected = assert.rejects(pending, { name: "AbortError" });
    abort.abort();
    await rejected;
    loading.resolve(fakeModule(f.bus));
    await Promise.resolve();
    assert.deepEqual(f.bus.names, []);
    assert.equal(f.bus.disconnected, 0);
    assert.deepEqual(f.failures, []);
  });

  it("checks ownership again after lazy loading", async () => {
    const f = fixture();
    const loading = deferred<DbusModule>();
    const pending = startNiriAppShotShortcut(f.options, {
      ...f.dependencies,
      loadDbus: () => loading.promise,
    });
    f.state.owner = false;
    loading.resolve(fakeModule(f.bus));
    await assert.rejects(pending, /owner is no longer current/);
    assert.deepEqual(f.bus.names, []);
  });

  it("cancels pending registration and ignores late success", async () => {
    const f = fixture();
    const pendingName = deferred<number>();
    f.bus.response = pendingName.promise;
    const abort = new AbortController();
    const pending = startNiriAppShotShortcut(
      { ...f.options, signal: abort.signal },
      f.dependencies,
    );
    await f.bus.requested.promise;
    const handler = f.bus.retained[0]!;
    const rejected = assert.rejects(pending, { name: "AbortError" });
    abort.abort();
    await rejected;
    pendingName.resolve(1);
    await Promise.resolve();
    assert.equal(handler(message()), true);
    assert.equal(f.state.captures, 0);
    assert.deepEqual(f.bus.replies, []);
    assert.equal(f.bus.disconnected, 1);
    assert.deepEqual(f.failures, []);
    assert.equal(f.timers[0]?.cancelled, true);
  });

  it("checks ownership again after registration", async () => {
    const f = fixture();
    const pendingName = deferred<number>();
    f.bus.response = pendingName.promise;
    const pending = startNiriAppShotShortcut(f.options, f.dependencies);
    await f.bus.requested.promise;
    f.state.owner = false;
    pendingName.resolve(1);
    await assert.rejects(pending, /owner is no longer current/);
    assert.equal(f.bus.disconnected, 1);
  });

  for (const result of [2, 3, 4]) {
    it("rejects non-primary ownership result " + result, async () => {
      const f = fixture();
      f.bus.response = Promise.resolve(result);
      await assert.rejects(
        startNiriAppShotShortcut(f.options, f.dependencies),
        /Another ZenX instance/,
      );
      assert.equal(f.bus.disconnected, 1);
      assert.equal(f.timers[0]?.cancelled, true);
      assert.deepEqual(f.failures, []);
    });
  }

  it("bounds registration to five seconds and does not queue", async () => {
    const f = fixture();
    f.bus.response = deferred<number>().promise;
    const pending = startNiriAppShotShortcut(f.options, f.dependencies);
    await f.bus.requested.promise;
    const rejected = assert.rejects(pending, /registration timed out/);
    assert.equal(f.timers[0]?.milliseconds, 5000);
    f.timers[0]!.callback();
    await rejected;
    assert.equal(f.bus.disconnected, 1);
    assert.equal(f.bus.removed, 1);
    assert.deepEqual(f.failures, []);
  });

  it("cleans up module or name-request failures", async () => {
    const f = fixture();
    await assert.rejects(
      startNiriAppShotShortcut(f.options, {
        ...f.dependencies,
        loadDbus: async () => {
          throw new Error("module unavailable");
        },
      }),
      /module unavailable/,
    );
    f.bus.requestName = () => {
      throw new Error("request failed");
    };
    await assert.rejects(
      startNiriAppShotShortcut(f.options, f.dependencies),
      /request failed/,
    );
    assert.equal(f.bus.disconnected, 1);
    assert.equal(f.timers[0]?.cancelled, true);
  });

  it("rejects startup bus errors and absorbs later errors", async () => {
    const f = fixture();
    f.bus.response = deferred<number>().promise;
    const pending = startNiriAppShotShortcut(f.options, f.dependencies);
    await f.bus.requested.promise;
    const rejected = assert.rejects(pending, /bus unavailable/);
    f.bus.emit("error", new Error("bus unavailable"));
    await rejected;
    f.bus.emit("error", new Error("late error"));
    assert.equal(f.bus.disconnected, 1);
    assert.deepEqual(f.failures, []);
  });

  it("closes before notifying a live bus failure", async () => {
    const f = fixture();
    const handle = await startNiriAppShotShortcut(
      {
        ...f.options,
        onFailure: (error) => {
          assert.equal(f.bus.disconnected, 1);
          f.failures.push(error);
        },
      },
      f.dependencies,
    );
    f.bus.emit("error", new Error("connection lost"));
    f.bus.emit("error", new Error("late error"));
    handle.stop();
    assert.equal(f.failures.length, 1);
    assert.match(f.failures[0]!.message, /connection lost/);
    assert.equal(f.bus.disconnected, 1);
  });

  it("rechecks ownership after disconnect before notification", async () => {
    const f = fixture();
    await startNiriAppShotShortcut(f.options, f.dependencies);
    f.bus.disconnect = () => {
      f.bus.disconnected++;
      f.state.owner = false;
    };
    f.bus.emit("error", new Error("connection lost"));
    assert.deepEqual(f.failures, []);
    assert.equal(f.bus.disconnected, 1);
  });

  it("suppresses failure callbacks for an obsolete owner", async () => {
    const f = fixture();
    await startNiriAppShotShortcut(f.options, f.dependencies);
    f.state.owner = false;
    f.bus.emit("error", new Error("connection lost"));
    assert.deepEqual(f.failures, []);
    assert.equal(f.bus.disconnected, 1);
  });

  it("stops rather than capturing for an obsolete owner", async () => {
    const f = fixture();
    await startNiriAppShotShortcut(f.options, f.dependencies);
    f.state.owner = false;
    f.bus.receive(message());
    assert.equal(f.state.captures, 0);
    assert.equal(
      f.bus.replies[0]?.errorName,
      "org.freedesktop.DBus.Error.AccessDenied",
    );
    assert.equal(f.bus.disconnected, 1);
  });

  it("fails closed if the owner fence throws", async () => {
    const f = fixture();
    const handle = await startNiriAppShotShortcut(f.options, f.dependencies);
    f.options.isCurrentOwner = () => {
      throw new Error("owner unavailable");
    };
    f.bus.receive(message());
    assert.equal(f.state.captures, 0);
    assert.equal(f.bus.disconnected, 1);
    assert.deepEqual(f.failures, []);
    handle.stop();
  });

  it("contains a synchronous dispatch failure", async () => {
    const f = fixture();
    await startNiriAppShotShortcut(
      {
        ...f.options,
        onCapture: () => {
          throw new Error("dispatch failed");
        },
      },
      f.dependencies,
    );
    assert.equal(f.bus.receive(message()), true);
    assert.equal(f.failures.length, 1);
    assert.match(f.failures[0]!.message, /dispatch failed/);
    assert.equal(f.bus.disconnected, 1);
  });

  it("contains errors thrown by failure notification", async () => {
    const f = fixture();
    await startNiriAppShotShortcut(
      {
        ...f.options,
        onFailure: () => {
          throw new Error("notification failed");
        },
      },
      f.dependencies,
    );
    assert.doesNotThrow(() =>
      f.bus.emit("error", new Error("connection lost")),
    );
    assert.equal(f.bus.disconnected, 1);
  });

  it("ignores retained callbacks after stop or cancellation", async () => {
    for (const stopWithSignal of [false, true]) {
      const f = fixture();
      const abort = new AbortController();
      const handle = await startNiriAppShotShortcut(
        { ...f.options, signal: abort.signal },
        f.dependencies,
      );
      const handler = f.bus.retained[0]!;
      if (stopWithSignal) abort.abort();
      else handle.stop();
      assert.equal(handler(message()), true);
      f.bus.emit("error", new Error("late error"));
      assert.equal(f.state.captures, 0);
      assert.deepEqual(f.bus.replies, []);
      assert.deepEqual(f.failures, []);
      assert.equal(f.bus.disconnected, 1);
      handle.stop();
    }
  });
});

for (const event of ["end", "close"] as const) {
  it(`disarms once on a clean session bus ${event}, without restart`, async () => {
    const f = fixture();
    const handle = await startNiriAppShotShortcut(f.options, f.dependencies);
    const source =
      event === "end" ? f.bus._connection : f.bus._connection.stream;
    source.emit(event);
    source.emit(event);
    handle.stop();
    assert.equal(f.failures.length, 1);
    assert.match(f.failures[0]!.message, /disconnected/);
    assert.equal(f.bus.disconnected, 1);
    assert.equal(f.state.loads, 1);
    assert.equal(f.bus._connection.listenerCount("end"), 0);
    assert.equal(f.bus._connection.stream.listenerCount("close"), 0);
  });
  it(`rejects startup promptly on clean session bus ${event}`, async () => {
    const f = fixture();
    f.bus.response = deferred<number>().promise;
    const pending = startNiriAppShotShortcut(f.options, f.dependencies);
    await f.bus.requested.promise;
    const rejected = assert.rejects(pending, /disconnected/);
    (event === "end" ? f.bus._connection : f.bus._connection.stream).emit(
      event,
    );
    await rejected;
    assert.deepEqual(f.failures, []);
    assert.equal(f.bus.disconnected, 1);
  });
}
