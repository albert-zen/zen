import assert from "node:assert/strict";
import test from "node:test";
import { AppShotIpcController } from "../src/main/app-shot-ipc.js";
import type { PortalAppShotShortcutOptions } from "../src/main/app-shot-portal-shortcut.js";
import type { AppShotEvent } from "../src/app-shot.js";
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

function fixture(platform = "darwin", niri = false, portal = false) {
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
  const abandoned: string[] = [];
  let importWait: Promise<void> | undefined;
  let prepared = 0;
  let focusCount = 0;
  let focused = false;
  const events: AppShotEvent[] = [];
  type ModifierOptions = {
    onTrigger(): void;
    onFailure(error: unknown): void;
    signal: AbortSignal;
  };
  const modifierStarts: ModifierOptions[] = [];
  let modifierStops = 0;
  let activeCaptures = 0;
  let activeSignal: AbortSignal | undefined;
  let startModifier: (
    options: ModifierOptions,
  ) => Promise<{ stop(): Promise<void> }> = async () => ({
    async stop() {
      modifierStops++;
    },
  });
  let activeCapture: () => Promise<AppShotCapture | undefined> = async () =>
    capture;
  const portalStarts: PortalAppShotShortcutOptions[] = [];
  let portalStops = 0;
  const portalHandle = {
    registered: false,
    shortcutDescription: undefined as string | undefined,
    canConfigure: true,
    stop() {
      portalStops++;
    },
    async configure() {
      portalHandle.registered = true;
      portalHandle.shortcutDescription = "Super+F8";
      portalStarts.at(-1)?.onStateChanged?.(portalHandle);
    },
  };
  let manualCapture: () => Promise<AppShotCapture> = async () => capture;
  const controller = new AppShotIpcController<Renderer, object>({
    platform,
    ...(portal
      ? {
          portalSupport: async () => true,
          startPortalShortcut: async (
            options: PortalAppShotShortcutOptions,
          ) => {
            portalStarts.push(options);
            return portalHandle;
          },
        }
      : {}),
    niriBinding: niri
      ? 'Ctrl+Shift+2 repeat=false { spawn "gdbus"; }'
      : undefined,
    startNiriShortcut: niri
      ? async (options) => {
          modifierStarts.push({
            onTrigger: options.onCapture,
            onFailure: (error) =>
              options.onFailure(
                error instanceof Error ? error : new Error("failure"),
              ),
            signal: options.signal,
          });
          return {
            stop() {
              modifierStops++;
            },
          };
        }
      : undefined,
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
        hasNativeActiveCapture: niri || portal,
        async listSources() {
          return [{ id: "source", title: "Window" }];
        },
        async capture() {
          return manualCapture();
        },
        async captureActive(options) {
          activeSignal = options?.signal;
          activeCaptures++;
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
    async importCapture(captured, owner) {
      assert.equal(owner, renderer);
      imports++;
      await importWait;
      return { ...draft, appShotContext: captured.context };
    },
    async abandonCapture(owner, image) {
      assert.equal(owner, renderer);
      abandoned.push(image.id);
    },
    startModifierPair(options) {
      modifierStarts.push(options);
      return startModifier(options);
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
    isFocused() {
      return focused;
    },
    focus() {
      focusCount++;
    },
  });
  return {
    controller,
    portalHandle,
    portalStarts,
    setFocused(value: boolean) {
      focused = value;
    },
    get portalStops() {
      return portalStops;
    },
    abandoned,
    waitForImport(value: Promise<void>) {
      importWait = value;
    },
    renderer,
    caller: () => ({ renderer, frame: renderer.frame }),
    events,
    modifierStarts,
    get modifierStops() {
      return modifierStops;
    },
    get activeSignal() {
      return activeSignal;
    },
    get activeCaptures() {
      return activeCaptures;
    },
    setModifierStart(value: typeof startModifier) {
      startModifier = value;
    },
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
    setActiveCapture(value: () => Promise<AppShotCapture | undefined>) {
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

test("portable chord is opt-in and stale token cannot disarm replacement", async () => {
  const f = fixture();
  assert.equal(f.shortcut, undefined);
  assert.equal(await f.controller.arm(f.caller(), "first", false), "⌘⇧2");
  assert.ok(f.shortcut);
  await f.controller.arm(f.caller(), "new", true);
  assert.deepEqual(f.events, [{ token: "first", disarmed: true }]);
  await f.controller.disarm(f.caller(), "first");
  assert.ok(f.shortcut);
  await f.controller.onShortcut();
  assert.deepEqual(
    f.events.map((event) => event.token),
    ["first", "new"],
  );
  assert.equal(f.focusCount, 1);
  assert.equal(f.imports, 0);
  await f.controller.disarm(f.caller(), "new");
  assert.equal(f.shortcut, undefined);
  assert.equal(f.unregisters, 2);
  const windows = fixture("win32");
  assert.equal(
    await windows.controller.arm(windows.caller(), "x", false, "chord"),
    "Ctrl+Shift+2",
  );
  windows.controller.dispose();
});

test("pending captures are bounded and discarded after disarm or navigation", async () => {
  const f = fixture();
  const wait = deferred<typeof capture>();
  f.setActiveCapture(() => wait.promise);
  await f.controller.arm(f.caller(), "old", false);
  const pending = f.controller.onShortcut();
  await f.controller.onShortcut();
  await f.controller.disarm(f.caller(), "old");
  assert.equal(f.activeSignal?.aborted, true);
  await f.controller.arm(f.caller(), "new", false);
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
  await f.controller.arm(f.caller(), "owner", false);
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

test("both Shift is opt-in on macOS and Windows and can trigger during startup", async () => {
  for (const platform of ["darwin", "win32"]) {
    const f = fixture(platform);
    assert.equal(f.modifierStarts.length, 0);
    let stops = 0;
    f.setModifierStart(async (options) => {
      options.onTrigger();
      return {
        async stop() {
          stops++;
        },
      };
    });
    assert.equal(
      await f.controller.arm(f.caller(), "pair", true, "both-shift"),
      "Left Shift + Right Shift",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0]?.token, "pair");
    assert.ok(f.events[0]?.image);
    assert.equal(f.imports, 0);
    assert.equal(f.shortcut, undefined);
    await f.controller.disarm(f.caller(), "pair");
    assert.equal(stops, 1);
    assert.equal(f.modifierStarts[0]?.signal.aborted, true);
    f.modifierStarts[0]!.onTrigger();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.activeCaptures, 1);
    f.controller.dispose();
  }
});

test("disarm waits for a late startup handle and its stop handshake", async () => {
  const f = fixture();
  const ready = deferred<{ stop(): Promise<void> }>();
  const stopped = deferred<void>();
  let stops = 0;
  f.setModifierStart(() => ready.promise);
  const arming = f.controller.arm(f.caller(), "pair", false, "both-shift");
  const rejected = assert.rejects(arming, /cancelled/u);
  await Promise.resolve();
  let disarmed = false;
  const disarming = f.controller.disarm(f.caller(), "pair").then(() => {
    disarmed = true;
  });
  assert.equal(f.modifierStarts[0]?.signal.aborted, true);
  ready.resolve({
    async stop() {
      stops++;
      await stopped.promise;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(disarmed, false);
  assert.deepEqual(f.events, []);
  stopped.resolve();
  await Promise.all([rejected, disarming]);
  assert.equal(disarmed, true);
});

test("replacing a starting modifier owner stops it before enabling the chord", async () => {
  const f = fixture();
  const ready = deferred<{ stop(): Promise<void> }>();
  let stops = 0;
  f.setModifierStart(() => ready.promise);
  const first = f.controller.arm(f.caller(), "old", false, "both-shift");
  const rejected = assert.rejects(first, /cancelled/u);
  await Promise.resolve();
  const second = f.controller.arm(f.caller(), "new", false, "chord");
  f.modifierStarts[0]!.onTrigger();
  assert.equal(f.activeCaptures, 0);
  assert.equal(f.shortcut, undefined);
  ready.resolve({
    async stop() {
      stops++;
    },
  });
  await Promise.all([rejected, second]);
  assert.equal(stops, 1);
  assert.ok(f.shortcut);
  assert.deepEqual(f.events, [{ token: "old", disarmed: true }]);
  await f.controller.disarm(f.caller(), "old");
  assert.ok(f.shortcut);
  f.controller.dispose();
});

test("modifier failure disarms visibly without a restart loop", async () => {
  const f = fixture();
  await f.controller.arm(f.caller(), "pair", false, "both-shift");
  f.modifierStarts[0]!.onFailure(new Error("helper stopped"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.events, [
    { token: "pair", disarmed: true, error: "helper stopped" },
  ]);
  assert.equal(f.modifierStops, 1);
  assert.equal(f.modifierStarts.length, 1);
  f.modifierStarts[0]!.onTrigger();
  assert.equal(f.activeCaptures, 0);
  f.controller.dispose();
});

test("startup rejection and navigation leave no modifier ownership", async () => {
  const failed = fixture();
  failed.setModifierStart(async () => {
    throw new Error("helper unavailable");
  });
  await assert.rejects(
    failed.controller.arm(failed.caller(), "pair", false, "both-shift"),
    /helper unavailable/u,
  );
  assert.equal(failed.modifierStarts[0]?.signal.aborted, true);
  await failed.controller.onShortcut();
  assert.equal(failed.activeCaptures, 0);
  for (const destroy of [false, true]) {
    const f = fixture();
    await f.controller.arm(f.caller(), "pair", false, "both-shift");
    if (destroy) f.controller.dispose();
    else f.controller.forget(f.renderer);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.modifierStarts[0]?.signal.aborted, true);
    assert.equal(f.modifierStops, 1);
    f.modifierStarts[0]!.onTrigger();
    assert.equal(f.activeCaptures, 0);
  }
});

test("Linux chord opens the chooser without capturing or claiming a foreground window", async () => {
  const f = fixture("linux");
  await assert.rejects(
    f.controller.arm(f.caller(), "pair", false, "both-shift"),
    /macOS and Windows/u,
  );
  assert.equal(f.modifierStarts.length, 0);
  await f.controller.arm(f.caller(), "chooser", true, "chord");
  await f.controller.onShortcut();
  assert.deepEqual(f.events, [{ token: "chooser", openPicker: true }]);
  assert.equal(f.activeCaptures, 0);
  assert.equal(f.prepared, 0);
  assert.equal(f.imports, 0);
  assert.equal(f.focusCount, 1);
  f.controller.dispose();
});

test("invalid shortcut kinds cannot register a global listener", async () => {
  const f = fixture();
  await assert.rejects(
    f.controller.arm(f.caller(), "owner", false, "double-tap"),
    /Invalid/u,
  );
  assert.equal(f.shortcut, undefined);
  assert.equal(f.modifierStarts.length, 0);
});

test("Niri opt-in owns a bus action without registering or writing a compositor shortcut", async () => {
  const f = fixture("linux", true);
  assert.equal(
    (await f.controller.configuration(f.caller())).nativeForeground,
    true,
  );
  assert.match(
    (await f.controller.configuration(f.caller())).niriBinding!,
    /gdbus/,
  );
  await f.controller.arm(f.caller(), "niri", false, "chord");
  assert.equal(f.shortcut, undefined);
  assert.equal(f.modifierStarts.length, 1);
  await f.controller.onShortcut();
  assert.equal(f.activeCaptures, 1);
  assert.equal(f.imports, 0);
  assert.ok(f.events[0]?.image);
  assert.equal(f.events[0]?.openPicker, undefined);
  await f.controller.disarm(f.caller(), "niri");
  assert.equal(f.modifierStarts[0]?.signal.aborted, true);
  assert.equal(f.modifierStops, 1);
  f.modifierStarts[0]?.onTrigger();
  await Promise.resolve();
  assert.equal(f.activeCaptures, 1);
  f.controller.dispose();
});

test("Niri configuration is available only to the trusted main frame", async () => {
  const f = fixture("linux", true);
  await assert.rejects(
    f.controller.configuration({ renderer: f.renderer, frame: {} }),
    /trusted/,
  );
  f.controller.dispose();
});

test("App Shot retires a staged attachment if its owner or review disappears during Attach", async () => {
  for (const changed of ["owner", "review"]) {
    const f = fixture();
    const image = await f.controller.capture(f.caller(), "source", false);
    let finish!: () => void;
    f.waitForImport(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const attaching = f.controller.attach(f.caller(), image.id);
    if (changed === "owner") f.controller.forget(f.renderer);
    else f.controller.discard(f.caller(), image.id);
    finish();
    await assert.rejects(attaching, /changed|discarded/);
    assert.deepEqual(f.abandoned, ["image"]);
    f.controller.dispose();
  }
});

test("Wayland shortcut consent remains disabled until configured, reports the actual chord and closes on revoke", async () => {
  const f = fixture("linux", false, true);
  assert.deepEqual(await f.controller.configuration(f.caller()), {
    nativeForeground: true,
    portalShortcut: true,
  });
  assert.equal(f.portalStarts.length, 0);
  assert.equal(f.activeCaptures, 0);
  const initial = await f.controller.arm(f.caller(), "portal", false, "chord");
  assert.deepEqual(initial, {
    registered: false,
    shortcutDescription: undefined,
    canConfigure: true,
  });
  await f.controller.onShortcut();
  assert.equal(f.activeCaptures, 0);
  const configured = await f.controller.configureShortcut(f.caller(), "portal");
  assert.equal(configured.shortcutDescription, "Super+F8");
  await f.controller.onShortcut();
  assert.equal(f.activeCaptures, 1);
  assert.equal(f.imports, 0);
  await f.controller.disarm(f.caller(), "portal");
  assert.equal(f.portalStops, 1);
  assert.equal(f.portalStarts[0]!.signal!.aborted, true);
  await assert.rejects(
    f.controller.configureShortcut(f.caller(), "portal"),
    /No current/,
  );
  f.controller.dispose();
});

test("Wayland absent capture capability opens picker, while denial never falls back", async () => {
  const f = fixture("linux", false, true);
  f.portalHandle.registered = true;
  await f.controller.arm(f.caller(), "portal", false, "chord");
  f.setActiveCapture(async () => undefined);
  await f.controller.onShortcut();
  assert.equal(f.events.at(-1)?.openPicker, true);
  f.events.length = 0;
  f.setActiveCapture(async () => {
    throw new Error("Desktop denied screenshot");
  });
  await f.controller.onShortcut();
  assert.match(f.events.at(-1)?.error ?? "", /denied/);
  assert.equal(
    f.events.some((event) => event.openPicker),
    false,
  );
  f.controller.dispose();
});

test("Wayland configuration is bound to the exact renderer, token and current owner", async () => {
  const f = fixture("linux", false, true);
  await f.controller.arm(f.caller(), "portal", false, "chord");
  await assert.rejects(
    f.controller.configureShortcut(f.caller(), "other"),
    /No current/,
  );
  const hold = deferred<void>();
  f.portalHandle.configure = () => hold.promise;
  const configuring = f.controller.configureShortcut(f.caller(), "portal");
  f.controller.forget(f.renderer);
  hold.resolve(undefined);
  await assert.rejects(configuring, /cancelled/);
  assert.equal(f.portalStops, 1);
  f.controller.dispose();
});

test("a portal shortcut in the focused ZenX Composer opens one chooser instead of taking pixels", async () => {
  const f = fixture("linux", false, true);
  f.portalHandle.registered = true;
  f.setFocused(true);
  await f.controller.arm(f.caller(), "portal", false, "chord");
  await f.controller.onShortcut();
  assert.equal(f.activeCaptures, 0);
  assert.equal(f.events.at(-1)?.openPicker, true);
  f.controller.dispose();
});
