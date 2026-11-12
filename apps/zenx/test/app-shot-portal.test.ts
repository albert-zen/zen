/** Injected D-Bus regressions. No live portal, native decoder or OS grant is exercised. */
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it, beforeEach, afterEach } from "node:test";
import {
  DBusError,
  Message,
  MessageFlag,
  MessageType,
  Variant,
} from "dbus-next";
import {
  capturePortalActiveAppShot,
  getPortalAppShotSupport,
  type PortalAppShotImage,
  type PortalAppShotOptions,
} from "../src/main/app-shot-portal.js";
const PORTAL = "org.freedesktop.portal.Desktop";
const REQUEST = "org.freedesktop.portal.Request";
const namespace = "/org/freedesktop/portal/desktop/request/1_77/";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
let directory: string;
let path: string;
let uri: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "zenx-portal-test-"));
  path = join(directory, "image.png");
  await fs.writeFile(path, png);
  uri = pathToFileURL(path).href;
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
class Bus extends EventEmitter {
  _connection = Object.assign(new EventEmitter(), {
    stream: new EventEmitter(),
  });
  calls: Message[] = [];
  sent: Message[] = [];
  disconnected = false;
  version: unknown = new Variant("u", 3);
  targets: unknown = new Variant("u", 8);
  errorAt?: string;
  errorType = "AccessDenied";
  screenshot?: (message: Message) => Promise<Message | null>;
  async call(message: Message): Promise<Message | null> {
    this.calls.push(message);
    if (message.member === this.errorAt)
      throw new DBusError(
        `org.freedesktop.DBus.Error.${this.errorType}`,
        "test failure",
      );
    if (message.member === "GetAll")
      return this.reply([
        { version: this.version, AvailableTargets: this.targets },
      ]);
    if (message.member === "GetNameOwner") return this.reply([":1.42"]);
    if (message.member === "Screenshot") {
      if (this.screenshot) return this.screenshot(message);
      const handle = this.handle(message);
      this.response(handle);
      return this.reply([handle]);
    }
    return this.reply([]);
  }
  handle(message: Message): string {
    return namespace + message.body[1].handle_token.value;
  }
  response(
    handle: string,
    status = 0,
    results: unknown = { uri: new Variant("s", uri) },
    sender = ":1.42",
  ) {
    this.emit(
      "message",
      new Message({
        type: MessageType.SIGNAL,
        sender,
        path: handle,
        interface: REQUEST,
        member: "Response",
        body: [status, results],
      }),
    );
  }
  reply(body: unknown[]) {
    return new Message({
      type: MessageType.METHOD_RETURN,
      replySerial: "1",
      destination: ":1.77",
      body,
    });
  }
  send(message: Message) {
    this.sent.push(message);
  }
  disconnect() {
    this.disconnected = true;
  }
}
function image(width = 800, height = 600): PortalAppShotImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: ({ width, height }) => image(width, height),
    toPNG: () => png,
  };
}
function options(
  bus: Bus,
  extra: Partial<PortalAppShotOptions> = {},
): PortalAppShotOptions {
  return {
    appId: "dev.zen.ZenX",
    env: {},
    createBus: () => bus,
    createImage: () => image(),
    callTimeoutMs: 100,
    responseTimeoutMs: 100,
    ...extra,
  };
}
it("captures only target8, authenticates early responses, and retains portal-owned file", async () => {
  const bus = new Bus();
  const result = await capturePortalActiveAppShot(options(bus));
  assert.deepEqual(result, { png, width: 800, height: 600 });
  assert.deepEqual(await fs.readFile(path), png);
  assert.deepEqual(
    bus.calls.map((x) => x.member),
    ["Register", "GetAll", "GetNameOwner", "AddMatch", "Screenshot"],
  );
  const capture = bus.calls.at(-1)!;
  assert.equal(capture.destination, ":1.42");
  assert.equal(capture.body[0], "");
  assert.deepEqual(capture.body[1].target, new Variant("u", 8));
  assert.deepEqual(capture.body[1].interactive, new Variant("b", false));
  assert.deepEqual(capture.body[1].modal, new Variant("b", false));
  assert.equal(bus.sent.length, 0);
  assert.equal(bus.disconnected, true);
  assert.equal(bus.listenerCount("message"), 0);
});
it("supports a valid alternate early request handle and ignores forged signals", async () => {
  const bus = new Bus();
  bus.screenshot = async () => {
    const handle = namespace + "alternate";
    bus.response(handle, 2, {}, ":1.99");
    bus.response(handle);
    return bus.reply([handle]);
  };
  assert.ok(await capturePortalActiveAppShot(options(bus)));
});
it("caps the early response buffer and times out without consuming an untracked response", async () => {
  const bus = new Bus();
  bus.screenshot = async () => {
    for (let i = 0; i < 9; i++) bus.response(namespace + `other${i}`);
    return bus.reply([namespace + "other8"]);
  };
  await assert.rejects(
    capturePortalActiveAppShot(options(bus, { responseTimeoutMs: 5 })),
    /timed out/,
  );
  assert.equal(bus.sent[0]?.path, namespace + "other8");
});
for (const [version, targets] of [
  [2, 8],
  [3, 1],
  [3, undefined],
])
  it(`returns unavailable for version=${version}, targets=${targets}`, async () => {
    const bus = new Bus();
    bus.version = new Variant("u", version);
    bus.targets = targets === undefined ? undefined : new Variant("u", targets);
    assert.equal(await capturePortalActiveAppShot(options(bus)), undefined);
    assert.ok(!bus.calls.some((x) => x.member === "Screenshot"));
    assert.equal(bus.disconnected, true);
  });
for (const member of ["Register", "GetAll"])
  it(`propagates ${member} denial instead of fallback`, async () => {
    const bus = new Bus();
    bus.errorAt = member;
    await assert.rejects(
      capturePortalActiveAppShot(options(bus)),
      /test failure/,
    );
    assert.equal(bus.disconnected, true);
  });
it("ignores only unavailable registration and detects missing Screenshot interface", async () => {
  const bus = new Bus();
  bus.errorAt = "Register";
  bus.errorType = "UnknownMethod";
  assert.ok(await capturePortalActiveAppShot(options(bus)));
  const absent = new Bus();
  absent.errorAt = "GetAll";
  absent.errorType = "UnknownInterface";
  assert.equal(await capturePortalActiveAppShot(options(absent)), undefined);
});
it("does not register sandbox identities", async () => {
  const bus = new Bus();
  await capturePortalActiveAppShot(
    options(bus, { env: { FLATPAK_ID: "dev.zen.ZenX" } }),
  );
  assert.equal(bus.calls[0]?.member, "GetAll");
});
it("rejects malformed variants", async () => {
  const bus = new Bus();
  bus.targets = new Variant("s", "8");
  await assert.rejects(capturePortalActiveAppShot(options(bus)), /properties/);
});
for (const status of [1, 2])
  it(`does not fallback or send Close after completed status ${status}`, async () => {
    const bus = new Bus();
    bus.screenshot = async (m) => {
      const handle = bus.handle(m);
      bus.response(handle, status, {});
      return bus.reply([handle]);
    };
    await assert.rejects(
      capturePortalActiveAppShot(options(bus)),
      status === 1 ? { name: "AbortError" } : /did not allow/,
    );
    assert.equal(bus.sent.length, 0);
  });
it("aborts a pending screenshot method with Close for the predicted handle", async () => {
  const bus = new Bus();
  const controller = new AbortController();
  bus.screenshot = async () => {
    controller.abort();
    return new Promise(() => {});
  };
  await assert.rejects(
    capturePortalActiveAppShot(options(bus, { signal: controller.signal })),
    { name: "AbortError" },
  );
  assert.equal(bus.sent[0]?.member, "Close");
  assert.equal(bus.sent[0]?.flags, MessageFlag.NO_REPLY_EXPECTED);
  assert.equal(bus.sent[0]?.path, bus.handle(bus.calls.at(-1)!));
  assert.equal(bus.disconnected, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
it("does not open a bus for pre-aborted capture", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    capturePortalActiveAppShot(
      options(new Bus(), {
        signal: controller.signal,
        createBus: () => {
          throw new Error("unexpected bus");
        },
      }),
    ),
    { name: "AbortError" },
  );
});
it("closes returned request on response timeout and rejects invalid foreign handle safely", async () => {
  const bus = new Bus();
  bus.screenshot = async () => bus.reply([namespace + "changed"]);
  await assert.rejects(
    capturePortalActiveAppShot(options(bus, { responseTimeoutMs: 5 })),
    /timed out/,
  );
  assert.equal(bus.sent[0]?.path, namespace + "changed");
  const invalid = new Bus();
  invalid.screenshot = async () => invalid.reply(["/foreign/request"]);
  await assert.rejects(capturePortalActiveAppShot(options(invalid)), /handle/);
  assert.equal(invalid.sent[0]?.path, invalid.handle(invalid.calls.at(-1)!));
});
it("propagates disconnect and removes listeners", async () => {
  const bus = new Bus();
  bus.screenshot = async () => {
    queueMicrotask(() => bus.emit("error", new Error("disconnected")));
    return new Promise(() => {});
  };
  await assert.rejects(
    capturePortalActiveAppShot(options(bus)),
    /disconnected/,
  );
  assert.equal(bus.listenerCount("message"), 0);
});
for (const event of ["end", "close"])
  it(`rejects clean transport ${event} without waiting for the response deadline`, async () => {
    const bus = new Bus();
    bus.screenshot = async () => {
      queueMicrotask(() =>
        (event === "end" ? bus._connection : bus._connection.stream).emit(
          event,
        ),
      );
      return new Promise(() => {});
    };
    await assert.rejects(
      capturePortalActiveAppShot(options(bus)),
      /disconnected/,
    );
    assert.equal(bus._connection.listenerCount("end"), 0);
    assert.equal(bus._connection.stream.listenerCount("close"), 0);
    assert.equal(bus.disconnected, true);
  });
it("rejects image decoding that outlasts its monotonic deadline before a timer runs", async (t) => {
  // Real file I/O must reach the decoder before this test advances either clock.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bus = new Bus();
  let now = 0;
  let decoded = false;
  await assert.rejects(
    capturePortalActiveAppShot(
      options(bus, {
        now: () => now,
        createImage: () => {
          decoded = true;
          now = 101;
          return image();
        },
      }),
    ),
    /timed out/,
  );
  assert.equal(decoded, true);
  assert.equal(bus.disconnected, true);
  assert.deepEqual(await fs.readFile(path), png);
});
it("rejects a clean disconnect during image decoding instead of delivering pixels", async (t) => {
  // A congested host can spend >100ms in open/stat/read/close. Wall time is
  // not the event under test: let decoding begin before emitting disconnect.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bus = new Bus();
  let decoded = false;
  await assert.rejects(
    capturePortalActiveAppShot(
      options(bus, {
        now: () => 0,
        createImage: () => {
          decoded = true;
          bus._connection.emit("end");
          return image();
        },
      }),
    ),
    /disconnected/,
  );
  assert.equal(decoded, true);
  assert.equal(bus.disconnected, true);
  assert.equal(bus._connection.listenerCount("end"), 0);
  assert.equal(bus._connection.stream.listenerCount("close"), 0);
  assert.deepEqual(await fs.readFile(path), png);
});
for (const failure of ["timeout", "disconnect"])
  it(
    `does not begin decoding after ${failure} while file stat is pending`,
    { timeout: 2_000 },
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const bus = new Bus();
      let now = 0;
      const originalOpen = fs.open;
      let releaseStat!: () => void;
      let enteredStat!: () => void;
      let closedFile!: () => void;
      let decoded = false;
      const statGate = new Promise<void>((resolve) => {
        releaseStat = resolve;
      });
      const statEntered = new Promise<void>((resolve) => {
        enteredStat = resolve;
      });
      const fileClosed = new Promise<void>((resolve) => {
        closedFile = resolve;
      });
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const file = await originalOpen(...args);
        const originalStat = file.stat.bind(file);
        const originalClose = file.close.bind(file);
        t.mock.method(file, "stat", async () => {
          enteredStat();
          await statGate;
          return originalStat();
        });
        t.mock.method(file, "close", async () => {
          await originalClose();
          closedFile();
        });
        return file;
      });
      syncBuiltinESMExports();
      try {
        const rejected = assert.rejects(
          capturePortalActiveAppShot(
            options(bus, {
              now: () => now,
              createImage: () => {
                decoded = true;
                return image();
              },
            }),
          ),
          failure === "timeout" ? /timed out/ : /disconnected/,
        );
        await statEntered;
        if (failure === "disconnect") {
          bus._connection.emit("end");
        } else {
          now = 100;
          t.mock.timers.tick(100);
        }
        await rejected;
        assert.equal(bus.disconnected, true);
        releaseStat();
        await fileClosed;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(decoded, false);
        assert.deepEqual(await fs.readFile(path), png);
      } finally {
        releaseStat();
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    },
  );
for (const invalidUri of [
  "https://example.com/capture.png",
  "file://example.com/capture.png",
])
  it("rejects remote screenshot URIs", async () => {
    const bus = new Bus();
    bus.screenshot = async (m) => {
      const handle = bus.handle(m);
      bus.response(handle, 0, { uri: new Variant("s", invalidUri) });
      return bus.reply([handle]);
    };
    await assert.rejects(capturePortalActiveAppShot(options(bus)));
    assert.deepEqual(await fs.readFile(path), png);
  });
it("bounds image reads before decoding and never deletes invalid portal files", async () => {
  await fs.truncate(path, 32 * 1024 * 1024 + 1);
  const bus = new Bus();
  await assert.rejects(
    capturePortalActiveAppShot(
      options(bus, {
        createImage: () => {
          throw new Error("must not decode");
        },
      }),
    ),
    /Invalid screenshot file/,
  );
  assert.equal((await fs.stat(path)).size, 32 * 1024 * 1024 + 1);
});
it("rejects non-PNG and empty native images", async () => {
  await fs.writeFile(path, "not a PNG");
  await assert.rejects(
    capturePortalActiveAppShot(options(new Bus())),
    /Invalid or oversized/,
  );
  await fs.writeFile(path, png);
  await assert.rejects(
    capturePortalActiveAppShot(
      options(new Bus(), {
        createImage: () => ({ ...image(), isEmpty: () => true }),
      }),
    ),
    /empty/,
  );
});
it("resizes to upstream bounds and returns no fabricated identity", async () => {
  const result = await capturePortalActiveAppShot(
    options(new Bus(), { createImage: () => image(5120, 3200) }),
  );
  assert.deepEqual(result, { png, width: 2560, height: 1600 });
  assert.equal(Object.hasOwn(result!, "window"), false);
});
it("absorbs a late transport error after owned disconnection", async () => {
  const bus = new Bus();
  await capturePortalActiveAppShot(options(bus));
  assert.doesNotThrow(() =>
    bus.emit("error", new Error("late transport error")),
  );
});
it("observes a rejected method promise even if transport aborts synchronously", async () => {
  const bus = new Bus();
  const controller = new AbortController();
  bus.screenshot = async () => {
    controller.abort();
    throw new Error("transport rejected after abort");
  };
  await assert.rejects(
    capturePortalActiveAppShot(options(bus, { signal: controller.signal })),
    { name: "AbortError" },
  );
  await new Promise((resolve) => setImmediate(resolve));
});
it("closes returned request when cancellation happens while waiting for Response", async () => {
  const bus = new Bus();
  const controller = new AbortController();
  bus.screenshot = async () => {
    setImmediate(() => controller.abort());
    return bus.reply([namespace + "cancel_me"]);
  };
  await assert.rejects(
    capturePortalActiveAppShot(options(bus, { signal: controller.signal })),
    { name: "AbortError" },
  );
  assert.equal(bus.sent[0]?.path, namespace + "cancel_me");
});
it("rejects directory screenshot without deleting portal content", async () => {
  uri = pathToFileURL(directory).href;
  await assert.rejects(
    capturePortalActiveAppShot(options(new Bus())),
    /Invalid screenshot file/,
  );
  assert.deepEqual(await fs.readFile(path), png);
});
it("rejects malformed response and closes request", async () => {
  const bus = new Bus();
  bus.screenshot = async (m) => {
    const handle = bus.handle(m);
    bus.response(handle, 0, []);
    return bus.reply([handle]);
  };
  await assert.rejects(
    capturePortalActiveAppShot(options(bus)),
    /Invalid portal response/,
  );
  assert.equal(bus.sent[0]?.member, "Close");
});

it("preflight reports support without ever requesting pixels or a screenshot handle", async () => {
  const bus = new Bus();
  assert.equal(await getPortalAppShotSupport(options(bus)), true);
  assert.deepEqual(
    bus.calls.map((call) => call.member),
    ["Register", "GetAll"],
  );
  assert.equal(bus.sent.length, 0);
  assert.equal(bus.disconnected, true);
});
it("preflight distinguishes absent capability from denied or malformed properties", async () => {
  const old = new Bus();
  old.version = new Variant("u", 2);
  assert.equal(await getPortalAppShotSupport(options(old)), false);
  const absent = new Bus();
  absent.errorAt = "GetAll";
  absent.errorType = "UnknownInterface";
  assert.equal(await getPortalAppShotSupport(options(absent)), false);
  const denied = new Bus();
  denied.errorAt = "GetAll";
  await assert.rejects(
    getPortalAppShotSupport(options(denied)),
    /test failure/,
  );
  const malformed = new Bus();
  malformed.version = new Variant("s", "3");
  await assert.rejects(
    getPortalAppShotSupport(options(malformed)),
    /properties/,
  );
  for (const bus of [old, absent, denied, malformed]) {
    assert.ok(!bus.calls.some((call) => call.member === "Screenshot"));
    assert.equal(bus.disconnected, true);
  }
});
it("preflight respects cancellation and does not construct a bus after pre-abort", async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(
    getPortalAppShotSupport(
      options(new Bus(), {
        signal,
        createBus: () => {
          throw new Error("unexpected bus");
        },
      }),
    ),
    { name: "AbortError" },
  );
});
