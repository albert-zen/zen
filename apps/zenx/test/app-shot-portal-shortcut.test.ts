/** Synthetic D-Bus only. These tests never connect to a real portal. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { startPortalAppShotShortcut } from "../src/main/app-shot-portal-shortcut.js";

it("does not load D-Bus for an already cancelled owner", async () => {
  const abort = new AbortController();
  abort.abort();
  let loaded = false;
  await assert.rejects(
    startPortalAppShotShortcut(
      {
        signal: abort.signal,
        isCurrentOwner: () => true,
        onCapture() {},
        onFailure() {},
      },
      {
        loadDbus: async () => {
          loaded = true;
          throw new Error("unexpected");
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(loaded, false);
});

import { EventEmitter } from "node:events";
import * as dbus from "dbus-next";
import type { Message, MessageBus } from "dbus-next";
import type {
  PortalAppShotShortcutDependencies,
  PortalAppShotShortcutOptions,
} from "../src/main/app-shot-portal-shortcut.js";
const PATH = "/org/freedesktop/portal/desktop";
const NS = PATH + "/request/1_7/";
const OWNER = ":1.55";
const SHORTCUTS = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST = "org.freedesktop.portal.Request";
const SESSION = "org.freedesktop.portal.Session";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class FakeBus extends EventEmitter {
  _connection = Object.assign(new EventEmitter(), {
    stream: new EventEmitter(),
  });
  calls: Message[] = [];
  sent: Message[] = [];
  disconnected = 0;
  session = "";
  shortcutId = "";
  version = 2;
  status = 0;
  label: string | undefined = "Super+Print";
  alternateHandle = false;
  hold: string | undefined;
  held = deferred<void>();
  release = deferred<Message>();
  responseHook?: (request: Message, path: string, body: unknown[]) => void;
  callHook?: (request: Message) => void;
  async call(message: Message): Promise<Message> {
    this.calls.push(message);
    this.callHook?.(message);
    const reply = (body: unknown[]) =>
      new dbus.Message({
        type: dbus.MessageType.METHOD_RETURN,
        replySerial: "1",
        destination: ":1.7",
        sender: OWNER,
        body,
      });
    let response: unknown[] | undefined;
    let path = "";
    switch (message.member) {
      case "GetNameOwner":
        return reply([OWNER]);
      case "Get":
        return reply([new dbus.Variant("u", this.version)]);
      case "CreateSession": {
        this.session =
          PATH + "/session/1_7/" + message.body[0].session_handle_token.value;
        response = [0, { session_handle: new dbus.Variant("s", this.session) }];
        break;
      }
      case "BindShortcuts": {
        this.shortcutId = message.body[1][0][0];
        response = [
          this.status,
          { shortcuts: new dbus.Variant("a(sa{sv})", this.bindings()) },
        ];
        break;
      }
    }
    if (response) {
      path =
        NS +
        (this.alternateHandle ? "actual_" : "") +
        message.body.at(-1).handle_token.value;
      if (this.responseHook) this.responseHook(message, path, response);
      else this.signal(REQUEST, "Response", "ua{sv}", response, path);
    }
    if (message.member === this.hold) {
      this.held.resolve(undefined);
      return this.release.promise;
    }
    return reply(response ? [path] : []);
  }
  bindings() {
    return [
      [
        this.shortcutId,
        this.label === undefined
          ? {}
          : { trigger_description: new dbus.Variant("s", this.label) },
      ],
    ];
  }
  signal(
    iface: string,
    member: string,
    signature: string,
    body: unknown[],
    path = PATH,
    sender = OWNER,
  ) {
    this.emit(
      "message",
      new dbus.Message({
        type: dbus.MessageType.SIGNAL,
        path,
        sender,
        interface: iface,
        member,
        signature,
        body,
      }),
    );
  }
  activate(
    sender = OWNER,
    session = this.session,
    id = this.shortcutId,
    signature = "osta{sv}",
  ) {
    this.signal(
      SHORTCUTS,
      "Activated",
      signature,
      [session, id, 1, {}],
      PATH,
      sender,
    );
  }
  send(message: Message) {
    this.sent.push(message);
  }
  disconnect() {
    this.disconnected++;
  }
}
function fixture() {
  const bus = new FakeBus();
  const abort = new AbortController();
  let current = true;
  let captures = 0;
  const failures: Error[] = [];
  const states: unknown[] = [];
  const timers = new Set<{ callback: () => void; milliseconds: number }>();
  const options: PortalAppShotShortcutOptions = {
    signal: abort.signal,
    isCurrentOwner: () => current,
    onCapture: () => {
      captures++;
    },
    onFailure: (error) => failures.push(error),
    onStateChanged: (state) => states.push(state),
  };
  const dependencies: PortalAppShotShortcutDependencies = {
    sandboxed: false,
    loadDbus: async () => ({
      ...dbus,
      sessionBus: () => bus as unknown as MessageBus,
    }),
    scheduleTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
  };
  return {
    bus,
    abort,
    options,
    dependencies,
    failures,
    states,
    timers,
    get captures() {
      return captures;
    },
    stale() {
      current = false;
    },
    start() {
      return startPortalAppShotShortcut(options, dependencies);
    },
  };
}
it("binds once, reports the actual desktop chord, and closes its session idempotently", async () => {
  const f = fixture();
  const handle = await f.start();
  assert.equal(handle.registered, true);
  assert.equal(handle.shortcutDescription, "Super+Print");
  assert.equal(handle.canConfigure, true);
  assert.equal(f.bus.calls[0]?.body[0], "io.github.albert_zen.ZenX");
  assert.equal(
    f.bus.calls.filter((x) => x.member === "BindShortcuts").length,
    1,
  );
  const bind = f.bus.calls.find((x) => x.member === "BindShortcuts")!;
  assert.equal(bind.body[1][0][1].preferred_trigger.value, "CTRL+SHIFT+2");
  assert.match(f.bus.shortcutId, /^zen-app-shot-/);
  assert.equal(
    f.bus.calls.some((x) => x.member === "ConfigureShortcuts"),
    false,
  );
  f.bus.activate();
  assert.equal(f.captures, 1);
  handle.stop();
  handle.stop();
  assert.equal(handle.registered, false);
  assert.equal(handle.shortcutDescription, undefined);
  assert.equal(f.bus.disconnected, 1);
  assert.equal(f.bus.sent.filter((x) => x.interface === SESSION).length, 1);
  assert.equal(f.bus.listenerCount("message"), 0);
  assert.equal(f.bus._connection.listenerCount("end"), 0);
  assert.equal(f.bus._connection.stream.listenerCount("close"), 0);
  assert.equal(f.timers.size, 0);
  f.bus.emit("error", new Error("late"));
  assert.equal(f.failures.length, 0);
});
it("handles an early response for the actual returned handle", async () => {
  const f = fixture();
  f.bus.alternateHandle = true;
  const handle = await f.start();
  assert.equal(handle.registered, true);
  handle.stop();
});
it("denial remains disabled, retains the session, and configures only on explicit action", async () => {
  const f = fixture();
  f.bus.status = 1;
  const handle = await f.start();
  assert.equal(handle.registered, false);
  assert.equal(handle.shortcutDescription, undefined);
  assert.equal(f.bus.disconnected, 0);
  f.bus.activate();
  assert.equal(f.captures, 0);
  await handle.configure();
  assert.equal(
    f.bus.calls.filter((x) => x.member === "ConfigureShortcuts").length,
    1,
  );
  assert.equal(handle.registered, false);
  f.bus.signal(SHORTCUTS, "ShortcutsChanged", "oa(sa{sv})", [
    f.bus.session,
    f.bus.bindings(),
  ]);
  assert.equal(handle.shortcutDescription, "Super+Print");
  assert.equal(handle.registered, true);
  f.bus.activate();
  assert.equal(f.captures, 1);
  f.bus.label = undefined;
  f.bus.signal(SHORTCUTS, "ShortcutsChanged", "oa(sa{sv})", [
    f.bus.session,
    f.bus.bindings(),
  ]);
  assert.equal(handle.registered, false);
  assert.equal(handle.shortcutDescription, undefined);
  assert.equal(f.states.length, 2);
  handle.stop();
});
it("missing or empty actual descriptions never claim an armed shortcut", async () => {
  for (const label of [undefined, "   "]) {
    const f = fixture();
    f.bus.label = label;
    const handle = await f.start();
    assert.equal(handle.registered, false);
    f.bus.activate();
    assert.equal(f.captures, 0);
    handle.stop();
  }
});
it("v1 refuses ConfigureShortcuts without destroying the existing binding", async () => {
  const f = fixture();
  f.bus.version = 1;
  const handle = await f.start();
  assert.equal(handle.canConfigure, false);
  await assert.rejects(handle.configure(), /desktop's shortcut settings/);
  assert.equal(handle.registered, true);
  assert.equal(
    f.bus.calls.some((x) => x.member === "ConfigureShortcuts"),
    false,
  );
  handle.stop();
});
it("pins sender, session, shortcut ID and activation signature", async () => {
  const f = fixture();
  const handle = await f.start();
  f.bus.activate(":1.99");
  f.bus.activate(OWNER, "wrong");
  f.bus.activate(OWNER, f.bus.session, "wrong");
  f.bus.activate(OWNER, f.bus.session, f.bus.shortcutId, "s");
  assert.equal(f.captures, 0);
  f.bus.activate();
  assert.equal(f.captures, 1);
  handle.stop();
});
it("does not accept a spoofed consent response", async () => {
  const f = fixture();
  f.bus.responseHook = (request, path, body) => {
    f.bus.signal(REQUEST, "Response", "ua{sv}", body, path, ":1.99");
    f.bus.signal(
      REQUEST,
      "Response",
      "ua{sv}",
      request.member === "BindShortcuts" ? [1, {}] : body,
      path,
    );
  };
  const handle = await f.start();
  assert.equal(handle.registered, false);
  handle.stop();
});
it("an old composer cannot capture or open configuration and closes the session", async () => {
  const f = fixture();
  const handle = await f.start();
  f.stale();
  f.bus.activate();
  assert.equal(f.captures, 0);
  assert.equal(handle.registered, false);
  await assert.rejects(handle.configure(), /owner is no longer current/);
  assert.equal(f.bus.disconnected, 1);
  assert.equal(f.failures.length, 0);
});
it("cancels BindShortcuts consent, closes both native objects and never arms from a late reply", async () => {
  const f = fixture();
  f.bus.hold = "BindShortcuts";
  const pending = f.start();
  await f.bus.held.promise;
  f.abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(
    f.bus.sent.map((x) => x.interface),
    [REQUEST, SESSION],
  );
  f.bus.release.resolve(
    new dbus.Message({
      type: dbus.MessageType.METHOD_RETURN,
      replySerial: "1",
      body: [NS + "late"],
    }),
  );
  f.bus.activate();
  assert.equal(f.captures, 0);
  assert.equal(f.bus.disconnected, 1);
});
it("closes the predicted session when CreateSession has not returned", async () => {
  const f = fixture();
  f.bus.hold = "CreateSession";
  const pending = f.start();
  await f.bus.held.promise;
  f.abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(
    f.bus.sent.find((x) => x.interface === SESSION)?.path,
    f.bus.session,
  );
});
it("stale startup ownership cannot return a live handle", async () => {
  const f = fixture();
  f.bus.callHook = (call) => {
    if (call.member === "BindShortcuts") f.stale();
  };
  await assert.rejects(f.start(), /owner is no longer current/);
  assert.equal(f.bus.disconnected, 1);
  assert.equal(f.failures.length, 0);
});
it("bounded consent timeout closes its request and session without restart", async () => {
  const f = fixture();
  const consent = deferred<void>();
  f.bus.responseHook = (request, path, body) => {
    if (request.member === "BindShortcuts") consent.resolve(undefined);
    else f.bus.signal(REQUEST, "Response", "ua{sv}", body, path);
  };
  const pending = f.start();
  await consent.promise;
  // Allow the method reply to install the separate 120-second consent timer.
  for (
    let i = 0;
    i < 20 && ![...f.timers].some((x) => x.milliseconds === 120_000);
    i++
  )
    await Promise.resolve();
  const timer = [...f.timers].find((x) => x.milliseconds === 120_000);
  assert.ok(timer);
  timer.callback();
  await assert.rejects(pending, /timed out/);
  assert.deepEqual(
    f.bus.sent.map((x) => x.interface),
    [REQUEST, SESSION],
  );
  assert.equal(f.bus.disconnected, 1);
  assert.equal(f.timers.size, 0);
});
for (const failure of ["error", "end", "close", "owner", "session"] as const) {
  it(`fails a live owner once on ${failure} and does not restart`, async () => {
    const f = fixture();
    const handle = await f.start();
    const calls = f.bus.calls.length;
    if (failure === "error") f.bus.emit("error", new Error("lost"));
    if (failure === "end") f.bus._connection.emit("end");
    if (failure === "close") f.bus._connection.stream.emit("close");
    if (failure === "owner")
      f.bus.signal(
        "org.freedesktop.DBus",
        "NameOwnerChanged",
        "sss",
        ["org.freedesktop.portal.Desktop", OWNER, ":1.66"],
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
      );
    if (failure === "session")
      f.bus.signal(SESSION, "Closed", "", [], f.bus.session);
    f.bus.activate();
    f.bus.emit("error", new Error("late"));
    assert.equal(f.failures.length, 1);
    assert.equal(f.bus.disconnected, 1);
    assert.equal(handle.registered, false);
    assert.equal(f.captures, 0);
    assert.equal(f.bus.calls.length, calls);
  });
}
it("isolates production/development app identities and lets sandboxes provide identity", async () => {
  const prod = fixture();
  const p = await prod.start();
  const dev = fixture();
  dev.options.development = true;
  const d = await dev.start();
  assert.equal(
    dev.bus.calls[0]?.body[0],
    "io.github.albert_zen.ZenX.Development",
  );
  assert.notEqual(dev.bus.shortcutId, prod.bus.shortcutId);
  p.stop();
  d.stop();
  const sandbox = fixture();
  sandbox.dependencies.sandboxed = true;
  const s = await sandbox.start();
  assert.equal(
    sandbox.bus.calls.some((x) => x.member === "Register"),
    false,
  );
  s.stop();
});
it("rejects malformed session handles and does not call BindShortcuts", async () => {
  const f = fixture();
  f.bus.responseHook = (_request, path) =>
    f.bus.signal(
      REQUEST,
      "Response",
      "ua{sv}",
      [0, { session_handle: new dbus.Variant("s", "/outside/session") }],
      path,
    );
  await assert.rejects(f.start(), /Invalid shortcut session handle/);
  assert.equal(
    f.bus.calls.some((x) => x.member === "BindShortcuts"),
    false,
  );
  assert.equal(f.bus.disconnected, 1);
});
it("bounds module loading and cancels without ever creating a bus", async () => {
  const f = fixture();
  const module =
    deferred<
      Awaited<
        ReturnType<NonNullable<PortalAppShotShortcutDependencies["loadDbus"]>>
      >
    >();
  f.dependencies.loadDbus = () => module.promise;
  const pending = f.start();
  const timer = [...f.timers][0];
  assert.equal(timer?.milliseconds, 5_000);
  timer!.callback();
  await assert.rejects(pending, /timed out/);
  assert.equal(f.bus.calls.length, 0);
  module.resolve({
    ...dbus,
    sessionBus: () => {
      throw new Error("late bus creation");
    },
  });
  await Promise.resolve();
});
