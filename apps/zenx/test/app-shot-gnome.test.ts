import assert from "node:assert/strict";
import { it } from "node:test";
import { checkGnomeAppShotSupport } from "../src/main/app-shot-gnome.js";

it("does not open a bus or capture outside a host GNOME Wayland session", async () => {
  let loaded = false;
  const support = await checkGnomeAppShotSupport(
    { env: { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland" } },
    {
      loadDbus: async () => {
        loaded = true;
        throw new Error("must not load");
      },
    },
  );
  assert.equal(support.status, "unsupported-session");
  assert.equal(loaded, false);
});

import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { Message, MessageLike } from "dbus-next";
import {
  captureGnomeActiveAppShot,
  gnomeAppShotClientName,
  isGnomeAppShotSession,
  GNOME_APP_SHOT_SERVICE,
  GNOME_APP_SHOT_PATH,
  GNOME_APP_SHOT_UUID,
  type GnomeAppShotDependencies,
  type GnomeAppShotImage,
} from "../src/main/app-shot-gnome.js";

const env = {
  XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
  XDG_SESSION_TYPE: "wayland",
};
const owner = ":1.48";
function png(width = 20, height = 10, length = 33) {
  const bytes = Buffer.alloc(length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const metadata = JSON.stringify({
  title: "Document",
  appName: "Editor",
  appIdentifier: "editor.desktop",
  processId: 42,
  bounds: { x: -10, y: 20, width: 20, height: 10 },
});
function image(bytes: Buffer): GnomeAppShotImage {
  return {
    isEmpty: () => false,
    getSize: () => ({
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    }),
    resize: ({ width, height }) => image(png(width, height)),
    toPNG: () => bytes,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class FakeBus extends EventEmitter {
  readonly _connection = Object.assign(new EventEmitter(), {
    stream: new EventEmitter(),
  });
  calls: MessageLike[] = [];
  claims: { name: string; flags: number }[] = [];
  disconnects = 0;
  version = 2;
  claimReply = 1;
  bytes: unknown = png();
  metadata: unknown = metadata;
  hook?: (message: MessageLike) => Promise<Message | null> | undefined;
  reply(message: MessageLike, body: unknown[]): Message {
    return {
      sender:
        message.destination === "org.freedesktop.DBus"
          ? "org.freedesktop.DBus"
          : owner,
      body,
    } as Message;
  }
  async call(message: MessageLike): Promise<Message | null> {
    this.calls.push(message);
    const hooked = this.hook?.(message);
    if (hooked) return hooked;
    if (message.member === "GetNameOwner") return this.reply(message, [owner]);
    if (message.member === "GetAll")
      return this.reply(message, [
        { Version: { signature: "u", value: this.version } },
      ]);
    if (message.member === "Capture")
      return this.reply(message, [this.bytes, this.metadata]);
    throw new Error("Unexpected method " + message.member);
  }
  async requestName(name: string, flags: number) {
    this.claims.push({ name, flags });
    return this.claimReply;
  }
  disconnect() {
    this.disconnects++;
  }
}
function fixture(bus = new FakeBus()) {
  let timeout: (() => void) | undefined;
  let clears = 0;
  const dependencies: GnomeAppShotDependencies = {
    loadDbus: async () =>
      ({
        sessionBus: () => bus,
        Message: class {
          constructor(message: MessageLike) {
            Object.assign(this, message);
          }
        },
        NameFlag: { DO_NOT_QUEUE: 4 },
        RequestNameReply: { PRIMARY_OWNER: 1 },
      }) as unknown as Awaited<
        ReturnType<NonNullable<GnomeAppShotDependencies["loadDbus"]>>
      >,
    createImage: image,
    scheduleTimeout: (callback, milliseconds) => {
      assert.equal(milliseconds, 15_000);
      timeout = callback;
      return () => {
        clears++;
      };
    },
  };
  return {
    bus,
    dependencies,
    expire: () => {
      assert.ok(timeout);
      timeout();
    },
    clears: () => clears,
  };
}

it("accepts only host GNOME Wayland, never stale desktop or sandbox variables", () => {
  assert.equal(isGnomeAppShotSession(env), true);
  for (const patch of [
    { XDG_SESSION_TYPE: "x11" },
    { XDG_SESSION_TYPE: "" },
    { FLATPAK_ID: "app" },
    { SNAP: "1" },
    { XDG_CURRENT_DESKTOP: "GNOMEish" },
  ])
    assert.equal(isGnomeAppShotSession({ ...env, ...patch }), false);
});
it("status only reads exact extension version, with no claim or capture", async () => {
  const f = fixture();
  assert.deepEqual(await checkGnomeAppShotSupport({ env }, f.dependencies), {
    status: "ready",
    interfaceVersion: 2,
  });
  assert.deepEqual(
    f.bus.calls.map((m) => m.member),
    ["GetNameOwner", "GetAll"],
  );
  assert.equal(f.bus.claims.length, 0);
  assert.equal(f.bus.disconnects, 1);
  assert.equal(f.clears(), 1);
});
it("capture pins extension owner and claims a host namespace on the same connection", async () => {
  const f = fixture();
  const capture = await captureGnomeActiveAppShot({ env }, f.dependencies);
  assert.deepEqual(f.bus.claims, [
    { name: gnomeAppShotClientName(), flags: 4 },
  ]);
  assert.equal(f.bus.calls[0]?.body?.[0], GNOME_APP_SHOT_SERVICE);
  assert.equal(f.bus.calls[2]?.destination, owner);
  assert.equal(f.bus.calls[2]?.path, GNOME_APP_SHOT_PATH);
  assert.equal(f.bus.calls[2]?.member, "Capture");
  assert.equal(f.bus.calls[2]?.body, undefined);
  assert.equal(capture.window?.processId, 42);
  assert.equal(capture.window?.bounds.x, -10);
  assert.equal(capture.window?.accessibilityBoundsReliable, true);
  assert.equal(capture.width, 20);
  assert.equal(capture.height, 10);
  assert.notEqual(capture.png, f.bus.bytes);
  (f.bus.bytes as Buffer).fill(0);
  assert.equal(capture.png[0], 137);
  assert.equal(f.bus.disconnects, 1);
  assert.equal(f.bus._connection.listenerCount("end"), 0);
  assert.equal(f.bus._connection.stream.listenerCount("close"), 0);
  f.bus.emit("error", new Error("late error must be absorbed"));
});
it("development uses its separate fixed claim", async () => {
  const f = fixture();
  await captureGnomeActiveAppShot({ env, development: true }, f.dependencies);
  assert.equal(
    f.bus.claims[0]?.name,
    "io.github.albert_zen.ZenX.Development.GnomeCapture",
  );
});
it("only genuine absence maps to unavailable; denial never falls through", async () => {
  for (const type of ["NameHasNoOwner", "AccessDenied"]) {
    const f = fixture();
    f.bus.hook = () =>
      Promise.reject(
        Object.assign(new Error(type), {
          type: "org.freedesktop.DBus.Error." + type,
        }),
      );
    if (type === "NameHasNoOwner")
      assert.deepEqual(
        await checkGnomeAppShotSupport({ env }, f.dependencies),
        { status: "extension-unavailable" },
      );
    else
      await assert.rejects(
        checkGnomeAppShotSupport({ env }, f.dependencies),
        /AccessDenied/,
      );
    assert.equal(f.bus.calls.length, 1);
    assert.equal(f.bus.disconnects, 1);
  }
  const f = fixture();
  f.bus.hook = (message) =>
    message.member === "Capture"
      ? Promise.reject(new Error("Only ZenX may request a snapshot."))
      : undefined;
  await assert.rejects(
    captureGnomeActiveAppShot({ env }, f.dependencies),
    /Only ZenX/,
  );
  assert.deepEqual(
    f.bus.calls.map((m) => m.member),
    ["GetNameOwner", "GetAll", "Capture"],
  );
});
it("incompatible versions, busy claims and forged owners cannot capture", async () => {
  for (const version of [0, 1, 3]) {
    const f = fixture();
    f.bus.version = version;
    assert.equal(
      (await checkGnomeAppShotSupport({ env }, f.dependencies)).status,
      "incompatible-version",
    );
    await assert.rejects(
      captureGnomeActiveAppShot({ env }, f.dependencies),
      /interface version 2/,
    );
    assert.equal(f.bus.claims.length, 0);
  }
  for (const reply of [2, 3, 4]) {
    const f = fixture();
    f.bus.claimReply = reply;
    await assert.rejects(
      captureGnomeActiveAppShot({ env }, f.dependencies),
      /Another ZenX/,
    );
    assert.equal(f.bus.calls.length, 2);
  }
  const f = fixture();
  f.bus.hook = (message) =>
    message.member === "GetAll"
      ? Promise.resolve({ sender: ":1.49", body: [] } as unknown as Message)
      : undefined;
  await assert.rejects(
    captureGnomeActiveAppShot({ env }, f.dependencies),
    /different bus owner/,
  );
  assert.equal(f.bus.claims.length, 0);
});
it("missing identity remains pixel-only; invalid identity and own windows fail", async () => {
  const f = fixture();
  f.bus.metadata = "";
  assert.equal(
    (await captureGnomeActiveAppShot({ env }, f.dependencies)).window,
    undefined,
  );
  for (const value of [
    "{",
    "[]",
    JSON.stringify({ ...JSON.parse(metadata), processId: -1 }),
    "x".repeat(65_537),
  ]) {
    const f = fixture();
    f.bus.metadata = value;
    await assert.rejects(captureGnomeActiveAppShot({ env }, f.dependencies));
  }
  for (const pid of [process.pid, 42]) {
    const f = fixture();
    f.bus.metadata = JSON.stringify({
      ...JSON.parse(metadata),
      processId: pid,
    });
    await assert.rejects(
      captureGnomeActiveAppShot({ env, excludedPids: [42] }, f.dependencies),
      /own application/,
    );
  }
});
it("bounds input before decode and resizes output, without files or buffer aliases", async () => {
  for (const bytes of [
    [],
    Buffer.alloc(5),
    Buffer.alloc(32 * 1024 * 1024 + 1),
    png(32_769, 1),
    png(20_000, 20_000),
  ]) {
    const f = fixture();
    f.bus.bytes = bytes;
    f.dependencies.createImage = () => {
      throw new Error("decoder must not run");
    };
    await assert.rejects(
      captureGnomeActiveAppShot({ env }, f.dependencies),
      /Invalid/,
    );
  }
  const f = fixture();
  f.bus.bytes = png(5000, 3000);
  const result = await captureGnomeActiveAppShot({ env }, f.dependencies);
  assert.deepEqual([result.width, result.height], [2560, 1536]);
  const large = fixture();
  large.bus.bytes = png(20, 10, 20 * 1024 * 1024 + 1);
  await assert.rejects(
    captureGnomeActiveAppShot({ env }, large.dependencies),
    /oversized/,
  );
});
it("pre-abort never loads D-Bus, and abort while pending never returns late pixels", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture();
  await assert.rejects(
    captureGnomeActiveAppShot(
      { env, signal: controller.signal },
      f.dependencies,
    ),
    { name: "AbortError" },
  );
  assert.equal(f.bus.calls.length, 0);
  const captureStarted = deferred<void>(),
    late = deferred<Message>();
  const active = fixture();
  active.bus.hook = (message) => {
    if (message.member !== "Capture") return undefined;
    captureStarted.resolve();
    return late.promise;
  };
  const abort = new AbortController();
  const pending = captureGnomeActiveAppShot(
    { env, signal: abort.signal },
    active.dependencies,
  );
  await captureStarted.promise;
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(active.bus.disconnects, 1);
  late.resolve({ sender: owner, body: [png(), metadata] } as Message);
});
it("deadlines cover loading and calls; clean EOF fails without waiting for a timeout", async () => {
  const f = fixture();
  f.dependencies.loadDbus = () => new Promise(() => undefined);
  const pending = captureGnomeActiveAppShot({ env }, f.dependencies);
  f.expire();
  await assert.rejects(pending, /timed out/);
  for (const event of ["end", "close", "error", "timeout"]) {
    const started = deferred<void>(),
      f = fixture();
    f.bus.hook = () => {
      started.resolve();
      return new Promise(() => undefined);
    };
    const pending = captureGnomeActiveAppShot({ env }, f.dependencies);
    await started.promise;
    if (event === "end") f.bus._connection.emit("end");
    if (event === "close") f.bus._connection.stream.emit("close");
    if (event === "error") f.bus.emit("error", new Error("transport failed"));
    if (event === "timeout") f.expire();
    await assert.rejects(pending, /disconnected|transport failed|timed out/);
    assert.equal(f.bus.disconnects, 1);
    assert.equal(f.bus.claims.length, 0);
  }
});

it("rejects pixels when synchronous native decoding outlasts the deadline", async () => {
  const f = fixture();
  let elapsed = 0;
  f.dependencies.now = () => elapsed;
  f.dependencies.createImage = (bytes) => {
    elapsed = 15_001;
    return image(bytes);
  };
  await assert.rejects(
    captureGnomeActiveAppShot({ env }, f.dependencies),
    /timed out/,
  );
  assert.equal(f.bus.disconnects, 1);
});

// Execute the actual bundled pure service under Node; GJS APIs are not mocked as real capture.
const bundle = new URL("../resources/app-shot-gnome/", import.meta.url);
const service = await import(new URL("captureService.js", bundle).href);
it("bundle manifest, UUID, GNOME versions, service namespace and license are coherent", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("bundle.json", bundle), "utf8"),
  );
  const meta = JSON.parse(
    await readFile(new URL("metadata.json", bundle), "utf8"),
  );
  assert.equal(manifest.uuid, GNOME_APP_SHOT_UUID);
  assert.equal(meta.uuid, manifest.uuid);
  assert.deepEqual(manifest.files, [
    "metadata.json",
    "extension.js",
    "captureService.js",
    "captureFeedback.js",
    "feedbackGeometry.js",
  ]);
  assert.deepEqual(meta["shell-version"], [
    "45",
    "46",
    "47",
    "48",
    "49",
    "50",
    "51",
  ]);
  assert.deepEqual(service.CLIENT_NAMES, [
    gnomeAppShotClientName(),
    gnomeAppShotClientName(true),
  ]);
  const extension = await readFile(new URL("extension.js", bundle), "utf8");
  assert.ok(extension.includes(GNOME_APP_SHOT_SERVICE));
  assert.ok(extension.includes(GNOME_APP_SHOT_PATH));
  assert.match(extension, /screenshot_window\(true, false, stream/);
  assert.match(
    extension,
    /!Main.sessionMode.isLocked\s*&&\s*!Main.sessionMode.isGreeter/,
  );
  assert.match(
    await readFile(new URL("LICENSE", bundle), "utf8"),
    /Copyright \(c\) 2026 T3 Tools Inc\./,
  );
});
it("bundled service enforces allowlist ownership, session rechecks and single capture", async () => {
  let available = true,
    snapshots = 0,
    feedback = 0;
  const waiting = deferred<unknown>();
  const capture = new service.CaptureService({
    getNameOwner: async (name: string) =>
      name === gnomeAppShotClientName() ? ":1.2" : null,
    isAvailable: () => available,
    takeSnapshot: async (animate: boolean) => {
      assert.equal(animate, false);
      snapshots++;
      return waiting.promise;
    },
    getProcessId: () => {
      throw new Error("No feedback requested");
    },
    beginFeedback: () => {
      feedback++;
    },
  });
  await assert.rejects(capture.capture(":1.3"), /Only ZenX/);
  assert.equal(snapshots, 0);
  const pending = capture.capture(":1.2");
  await Promise.resolve();
  await Promise.resolve();
  await assert.rejects(capture.capture(":1.2"), /already in progress/);
  available = false;
  waiting.resolve({ png: png(), metadata });
  await assert.rejects(pending, /unavailable/);
  assert.equal(feedback, 0);
  available = true;
  capture.disable();
  await assert.rejects(capture.capture(":1.2"), /unavailable/);
});
it("bundled service rejects a lock during ownership lookup before taking pixels", async () => {
  let available = true;
  const capture = new service.CaptureService({
    getNameOwner: async () => {
      available = false;
      return ":1.2";
    },
    isAvailable: () => available,
    takeSnapshot: () => {
      throw new Error("must not capture");
    },
  });
  await assert.rejects(capture.capture(":1.2"), /unavailable/);
  assert.equal(
    service.isWaylandSession({ is_wayland_compositor: () => false }),
    false,
  );
  assert.equal(
    service.isWaylandSession({ is_wayland_compositor: () => true }),
    true,
  );
  assert.equal(service.isWaylandSession({}), true); // GNOME 50+ removed the API and X11 compositor.
});
