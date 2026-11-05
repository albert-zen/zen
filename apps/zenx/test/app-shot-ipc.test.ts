import assert from "node:assert/strict";
import test from "node:test";
import { AppShotIpcController } from "../src/main/app-shot-ipc.js";
import type { AppShotCapture, AppShotService } from "../src/main/app-shot.js";
import type { ZenXImageDraft } from "../src/main/image-attachments.js";

const draft = {
  id: "image",
  name: "window.png",
  attachment: { type: "attachment" },
} as ZenXImageDraft;
const capture = {
  name: "window.png",
  bytes: new Uint8Array([1]),
  mediaType: "image/png" as const,
  context: "draft context",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(platform = "darwin") {
  type Renderer = { owned: boolean; url: string; frame: object; calls: number };
  const renderer: Renderer = {
    owned: true,
    url: "file:///zen/index.html",
    frame: {},
    calls: 0,
  };
  let shortcut: (() => void) | undefined;
  let unregisters = 0;
  let imports = 0;
  let prepared = 0;
  let focusCount = 0;
  const events: Array<{
    token: string;
    image?: ZenXImageDraft;
    error?: string;
    disarmed?: true;
  }> = [];
  let activeCapture: () => Promise<typeof capture> = async () => capture;
  let manualCapture: () => Promise<AppShotCapture> = async () => capture;
  const controller = new AppShotIpcController<Renderer, object>({
    platform,
    rendererUrl: "file:///zen/index.html",
    trusted({ renderer: target, frame }) {
      return {
        ownedWindow: target.owned,
        mainFrame: target.frame === frame,
        url: target.url,
      };
    },
    createService(target): AppShotService {
      target.calls++;
      return {
        async listSources() {
          return [{ id: "source", title: "Window" }];
        },
        async capture() {
          return manualCapture();
        },
        async captureActive() {
          return activeCapture();
        },
      };
    },
    async preparePreview(captured) {
      prepared++;
      return {
        ...draft,
        id: `preview-${prepared}`,
        appShotContext: captured.context,
      };
    },
    async importCapture(captured) {
      imports++;
      return { ...draft, appShotContext: captured.context };
    },
    registerShortcut(_key, callback) {
      shortcut = callback;
      return true;
    },
    unregisterShortcut() {
      unregisters++;
      shortcut = undefined;
    },
    sendCaptured(_renderer, payload) {
      events.push(payload);
    },
    focus() {
      focusCount++;
    },
  });
  return {
    controller,
    renderer,
    caller: () => ({ renderer, frame: renderer.frame }),
    events,
    get shortcut() {
      return shortcut;
    },
    get unregisters() {
      return unregisters;
    },
    get imports() {
      return imports;
    },
    get prepared() {
      return prepared;
    },
    get focusCount() {
      return focusCount;
    },
    setActiveCapture(value: () => Promise<typeof capture>) {
      activeCapture = value;
    },
    setManualCapture(value: () => Promise<AppShotCapture>) {
      manualCapture = value;
    },
  };
}

test("only owned exact main frames can stage; only Attach persists", async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.list(f.caller()), [
    { id: "source", title: "Window" },
  ]);
  const image = await f.controller.capture(f.caller(), "source", false);
  assert.equal(image.appShotContext, "draft context");
  assert.equal(f.imports, 0);
  assert.deepEqual(f.controller.read(f.caller(), image.id), capture.bytes);
  const attached = await f.controller.attach(f.caller(), image.id);
  assert.equal(attached.appShotContext, "draft context");
  assert.equal(f.imports, 1);
  assert.throws(
    () => f.controller.read(f.caller(), image.id),
    /missing or stale/u,
  );
  const cancelled = await f.controller.capture(f.caller(), "source", false);
  f.controller.discard(f.caller(), cancelled.id);
  f.controller.discard(f.caller(), cancelled.id);
  assert.throws(
    () => f.controller.read(f.caller(), cancelled.id),
    /missing or stale/u,
  );
  assert.equal(f.imports, 1);
  await assert.rejects(
    f.controller.capture(f.caller(), "source", "yes"),
    /Invalid/u,
  );
  await assert.rejects(
    f.controller.capture(f.caller(), "x".repeat(101), false),
    /Invalid/u,
  );
  for (const invalid of [
    { frame: {}, url: "file:///zen/index.html", owned: true },
    {
      frame: f.renderer.frame,
      url: "file:///zen/index.html?other=1",
      owned: true,
    },
    { frame: f.renderer.frame, url: "file:///zen/index.html", owned: false },
  ]) {
    f.renderer.url = invalid.url;
    f.renderer.owned = invalid.owned;
    await assert.rejects(
      f.controller.list({ renderer: f.renderer, frame: invalid.frame }),
      /trusted/u,
    );
  }
  assert.equal(f.imports, 1);
});

test("shortcut is opt-in, only macOS, and stale token cannot disarm replacement", async () => {
  const f = fixture();
  assert.equal(f.shortcut, undefined);
  assert.equal(f.controller.arm(f.caller(), "first", false), "⌘⇧2");
  assert.ok(f.shortcut);
  f.controller.arm(f.caller(), "new", true);
  assert.deepEqual(f.events, [{ token: "first", disarmed: true }]);
  f.controller.disarm(f.caller(), "first");
  assert.ok(f.shortcut);
  await f.controller.onShortcut();
  assert.deepEqual(
    f.events.map((event) => event.token),
    ["first", "new"],
  );
  assert.equal(f.focusCount, 1);
  assert.equal(f.imports, 0);
  f.controller.disarm(f.caller(), "new");
  assert.equal(f.shortcut, undefined);
  assert.equal(f.unregisters, 1);
  assert.throws(
    () => fixture("win32").controller.arm(f.caller(), "x", false),
    /macOS/u,
  );
});

test("pending captures are bounded and discarded after disarm or navigation", async () => {
  const f = fixture();
  const wait = deferred<typeof capture>();
  f.setActiveCapture(() => wait.promise);
  f.controller.arm(f.caller(), "old", false);
  const pending = f.controller.onShortcut();
  await f.controller.onShortcut();
  f.controller.disarm(f.caller(), "old");
  f.controller.arm(f.caller(), "new", false);
  assert.deepEqual(f.events, []);
  wait.resolve(capture);
  await pending;
  assert.equal(f.events.length, 0);
  assert.equal(f.imports, 0);
  assert.equal(f.focusCount, 0);
  const second = deferred<typeof capture>();
  f.setActiveCapture(() => second.promise);
  const navigating = f.controller.onShortcut();
  f.controller.forget(f.renderer);
  second.resolve(capture);
  await navigating;
  assert.equal(f.events.length, 0);
  assert.equal(f.shortcut, undefined);
});

test("capture failures report to the current owner only", async () => {
  const f = fixture();
  f.setActiveCapture(async () => {
    throw new Error("window unavailable");
  });
  f.controller.arm(f.caller(), "owner", false);
  await f.controller.onShortcut();
  assert.deepEqual(f.events, [{ token: "owner", error: "window unavailable" }]);
  assert.equal(f.focusCount, 1);
  f.controller.dispose();
  assert.equal(f.shortcut, undefined);
});

test("staging is limited to four previews per renderer and 40 MiB total", async () => {
  const f = fixture();
  const staged: ZenXImageDraft[] = [];
  for (let i = 0; i < 4; i++)
    staged.push(await f.controller.capture(f.caller(), "source", false));
  await assert.rejects(
    f.controller.capture(f.caller(), "source", false),
    /Too many pending/u,
  );
  assert.equal(f.prepared, 4);
  f.controller.discard(f.caller(), staged[0]!.id);
  await f.controller.capture(f.caller(), "source", false);
  assert.equal(f.imports, 0);
  f.controller.forget(f.renderer);
  assert.throws(
    () => f.controller.read(f.caller(), staged[1]!.id),
    /missing or stale/u,
  );
  const big = fixture();
  big.setManualCapture(async () => ({
    ...capture,
    bytes: new Uint8Array(11 * 1024 * 1024),
  }));
  for (let i = 0; i < 3; i++)
    await big.controller.capture(big.caller(), "source", false);
  await assert.rejects(
    big.controller.capture(big.caller(), "source", false),
    /Too many pending/u,
  );
  assert.equal(big.prepared, 3);
  big.controller.dispose();
});

test("staged bytes expire after five minutes without touching permanent storage", async () => {
  const f = fixture();
  const original = Date.now;
  const start = original();
  try {
    Date.now = () => start;
    const image = await f.controller.capture(f.caller(), "source", false);
    Date.now = () => start + 5 * 60_000 + 1;
    assert.throws(
      () => f.controller.read(f.caller(), image.id),
      /missing or stale/u,
    );
    assert.equal(f.imports, 0);
  } finally {
    Date.now = original;
    f.controller.dispose();
  }
});
