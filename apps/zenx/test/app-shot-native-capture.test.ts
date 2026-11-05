import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APP_SHOT_MAX_NODES,
  APP_SHOT_MAX_TEXT,
  captureWindowsActiveAppShot,
  parseAppShotRegionImage,
  readCapturedAppShotAccessibility,
  runAppShotNative,
  sameAppShotIdentity,
  type AppShotCaptureIdentity,
  type AppShotNativeChild,
  type AppShotWindowsCaptureDependencies,
} from "../src/main/app-shot-native-capture.js";
import {
  appShotAccessibleElements,
  readAppShotAccessibilityWithApi as readAccessibilityWithApi,
  type AppShotAccessibilityApi,
  type AppShotAccessibilityElement,
} from "../src/main/app-shot-accessibility.js";
import {
  readAppShotWindowsForegroundWithApi,
  type AppShotWindowsApi,
} from "../src/main/app-shot-windows-foreground.js";

const identity: AppShotCaptureIdentity = {
  platform: "win32",
  windowId: 42,
  windowTitle: "Synthetic draft",
  pid: process.pid + 1,
  bounds: { x: -1600, y: 20, width: 1200, height: 800 },
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n8kAAAAASUVORK5CYII=",
  "base64",
);
const image = { png, width: 1, height: 1 };

function fakeChild(exitOnKill: boolean | "SIGKILL" = true) {
  let message: (value: unknown) => void = () => {};
  let exit: () => void = () => {};
  let kills = 0;
  const sent: unknown[] = [];
  const signals: string[] = [];
  const child: AppShotNativeChild = {
    send: (request, callback) => {
      sent.push(request);
      callback();
    },
    onMessage: (listener) => {
      message = listener;
    },
    onExit: (listener) => {
      exit = listener;
    },
    kill: (signal = "SIGTERM") => {
      kills++;
      signals.push(signal);
      if (exitOnKill === true || exitOnKill === signal) exit();
    },
  };
  return {
    child,
    sent,
    signals,
    get kills() {
      return kills;
    },
    message: (value: unknown) => message(value),
    exit: () => exit(),
  };
}

function captureDependencies() {
  let captureCalls = 0;
  let axCalls = 0;
  const reads: AppShotCaptureIdentity[] = [];
  const dependencies: AppShotWindowsCaptureDependencies = {
    getForeground: async () => reads.shift() ?? identity,
    screenToDipRect: (window, bounds) => {
      assert.equal(window, null);
      assert.deepEqual(bounds, identity.bounds);
      return { x: -800, y: 10, width: 600, height: 400 };
    },
    captureRegion: async (region) => {
      captureCalls++;
      assert.deepEqual(region, { x: -800, y: 10, width: 600, height: 400 });
      return image;
    },
    readAccessibility: async (capturedIdentity) => {
      axCalls++;
      assert.deepEqual(capturedIdentity, {
        ...identity,
        bounds: { x: -800, y: 10, width: 600, height: 400 },
      });
      return { text: "Synthetic application text", truncated: false };
    },
  };
  return {
    dependencies,
    reads,
    get captureCalls() {
      return captureCalls;
    },
    get axCalls() {
      return axCalls;
    },
  };
}

describe("disposable native App Shot worker", () => {
  it("sends once after ready and kills once on a result", async () => {
    const fake = fakeChild();
    const pending = runAppShotNative(
      "foreground",
      { synthetic: true },
      { fork: () => fake.child },
    );
    assert.equal(fake.sent.length, 0);
    fake.message("ready");
    fake.message("ready");
    assert.deepEqual(fake.sent, [{ synthetic: true }]);
    fake.message({ type: "result", value: identity });
    fake.exit();
    assert.deepEqual(await pending, identity);
    assert.equal(fake.kills, 1);
  });

  it("bounds native startup, rejects malformed messages, and disposes crashes", async () => {
    const stalled = fakeChild();
    await assert.rejects(
      runAppShotNative(
        "region",
        {},
        { fork: () => stalled.child, timeoutMs: 5 },
      ),
      /timed out/,
    );
    assert.equal(stalled.kills, 1);
    for (const value of [null, { type: "result", value: "too early" }]) {
      const fake = fakeChild();
      const pending = runAppShotNative(
        "foreground",
        {},
        { fork: () => fake.child },
      );
      fake.message(value);
      await assert.rejects(pending, /invalid data/);
      assert.equal(fake.kills, 1);
    }
    const crashed = fakeChild();
    const pending = runAppShotNative(
      "foreground",
      {},
      { fork: () => crashed.child },
    );
    crashed.exit();
    await assert.rejects(pending, /exited/);
    assert.equal(crashed.kills, 0);
  });

  it("kills on cancellation and masks native error details", async () => {
    const fake = fakeChild();
    const controller = new AbortController();
    const pending = runAppShotNative(
      "region",
      {},
      {
        fork: () => fake.child,
        signal: controller.signal,
      },
    );
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(fake.kills, 1);
    const failed = fakeChild();
    const result = runAppShotNative("region", {}, { fork: () => failed.child });
    failed.message("ready");
    failed.message({ type: "error", message: "private title or path" });
    await assert.rejects(result, {
      message: "App Shot native operation failed",
    });
    assert.equal(failed.kills, 1);
  });

  it("does not spawn after cancellation and kills on send failure", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runAppShotNative(
        "region",
        {},
        {
          signal: controller.signal,
          fork: () => {
            throw new Error("must not spawn");
          },
        },
      ),
      /cancelled/,
    );
    const fake = fakeChild();
    fake.child.send = (_request, callback) =>
      callback(new Error("private data"));
    const pending = runAppShotNative("region", {}, { fork: () => fake.child });
    fake.message("ready");
    await assert.rejects(pending, /request failed/);
    assert.equal(fake.kills, 1);
  });
  it("waits for actual exit before accepting a result and ignores late output", async () => {
    const fake = fakeChild(false);
    let settled = false;
    const pending = runAppShotNative(
      "foreground",
      {},
      {
        fork: () => fake.child,
      },
    ).then((value) => {
      settled = true;
      return value;
    });
    fake.message("ready");
    fake.message({ type: "result", value: identity });
    fake.message({ type: "result", value: "late" });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(fake.signals, ["SIGTERM"]);
    fake.exit();
    assert.deepEqual(await pending, identity);
  });

  it("escalates a stalled owned child and preserves the original failure", async () => {
    const fake = fakeChild("SIGKILL");
    await assert.rejects(
      runAppShotNative(
        "region",
        {},
        {
          fork: () => fake.child,
          timeoutMs: 5,
          shutdownGraceMs: 5,
        },
      ),
      { message: "App Shot native helper timed out" },
    );
    assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
  });

  it("reports unconfirmed shutdown instead of accepting a result", async () => {
    const fake = fakeChild(false);
    const pending = runAppShotNative(
      "region",
      {},
      {
        fork: () => fake.child,
        shutdownGraceMs: 5,
      },
    );
    fake.message("ready");
    fake.message({ type: "result", value: "must not be accepted" });
    await assert.rejects(pending, /shutdown could not be confirmed/);
    assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
    fake.exit();
  });

  it("cancellation during shutdown still prevents result delivery", async () => {
    const fake = fakeChild(false);
    const controller = new AbortController();
    const pending = runAppShotNative(
      "region",
      {},
      {
        fork: () => fake.child,
        signal: controller.signal,
      },
    );
    const rejected = assert.rejects(pending, /cancelled/);
    fake.message("ready");
    fake.message({ type: "result", value: "must not be accepted" });
    controller.abort();
    fake.exit();
    await rejected;
    assert.deepEqual(fake.signals, ["SIGTERM"]);
  });
});

describe("verified Windows region capture", () => {
  it("uses DPI conversion and explicitly returns region pixels, with text opt-in", async () => {
    const fake = captureDependencies();
    const result = await captureWindowsActiveAppShot({}, fake.dependencies);
    assert.equal(result.captureKind, "screen-region");
    assert.equal(result.png, png);
    assert.deepEqual(result.identity, identity);
    assert.equal(result.accessibility, undefined);
    assert.equal(fake.captureCalls, 1);
    assert.equal(fake.axCalls, 0);
    const withText = await captureWindowsActiveAppShot(
      { includeAccessibility: true },
      fake.dependencies,
    );
    assert.equal(withText.accessibility?.text, "Synthetic application text");
    assert.equal(fake.axCalls, 1);
  });

  it("rejects self/excluded windows before pixels and never retargets", async () => {
    const fake = captureDependencies();
    await assert.rejects(
      captureWindowsActiveAppShot(
        { excludedWindowIds: [42] },
        fake.dependencies,
      ),
      /external/,
    );
    fake.reads.push({ ...identity, pid: process.pid });
    await assert.rejects(
      captureWindowsActiveAppShot({}, fake.dependencies),
      /external/,
    );
    assert.equal(fake.captureCalls, 0);
    assert.equal(fake.axCalls, 0);
  });

  it("rejects oversized physical bounds before DPI conversion or pixels", async () => {
    const fake = captureDependencies();
    fake.reads.push({
      ...identity,
      bounds: { x: 0, y: 0, width: 8193, height: 8192 },
    });
    await assert.rejects(
      captureWindowsActiveAppShot({}, fake.dependencies),
      /pixel budget/,
    );
    assert.equal(fake.captureCalls, 0);
    assert.equal(fake.axCalls, 0);
  });

  it("does not observe the foreground after an already-cancelled request", async () => {
    const fake = captureDependencies();
    fake.dependencies.getForeground = async () => {
      throw new Error("must not read");
    };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      captureWindowsActiveAppShot(
        { signal: controller.signal },
        fake.dependencies,
      ),
      /cancelled/,
    );
    assert.equal(fake.captureCalls, 0);
  });

  it("checks HWND, PID, title and full bounds before and after pixels", async () => {
    const changes = [
      { windowId: 43 },
      { pid: identity.pid + 1 },
      { windowTitle: "Other" },
      { bounds: { ...identity.bounds, x: identity.bounds.x + 1 } },
    ];
    for (const change of changes) {
      const fake = captureDependencies();
      fake.reads.push(identity, { ...identity, ...change });
      await assert.rejects(
        captureWindowsActiveAppShot({}, fake.dependencies),
        /changed before/,
      );
      assert.equal(fake.captureCalls, 0);
      fake.reads.push(identity, identity, { ...identity, ...change });
      await assert.rejects(
        captureWindowsActiveAppShot(
          { includeAccessibility: true },
          fake.dependencies,
        ),
        /changed during/,
      );
      assert.equal(fake.axCalls, 0);
    }
    assert.equal(sameAppShotIdentity(identity, { ...identity, pid: 0 }), false);
  });

  it("rejects changes during optional text and keeps pixels when AX is unavailable", async () => {
    const fake = captureDependencies();
    fake.reads.push(identity, identity, identity, { ...identity, windowId: 9 });
    await assert.rejects(
      captureWindowsActiveAppShot(
        { includeAccessibility: true },
        fake.dependencies,
      ),
      /changed during/,
    );
    fake.dependencies.readAccessibility = async () => {
      throw new Error("No grant");
    };
    const result = await captureWindowsActiveAppShot(
      { includeAccessibility: true },
      fake.dependencies,
    );
    assert.equal(result.accessibility, undefined);
    assert.equal(result.png, png);
  });

  it("verifies PNG receipt dimensions and rejects malformed/oversized output", () => {
    assert.equal(
      parseAppShotRegionImage({ ...image, png: png.toString("base64") }).width,
      1,
    );
    assert.throws(
      () =>
        parseAppShotRegionImage({
          width: 2,
          height: 1,
          png: png.toString("base64"),
        }),
      /dimensions/,
    );
    assert.throws(
      () => parseAppShotRegionImage({ width: 1, height: 1, png: "@@@@" }),
      /invalid image/,
    );
    assert.throws(
      () => parseAppShotRegionImage({ width: 100000, height: 100000, png: "" }),
      /invalid image/,
    );
  });
});

describe("read-only Windows foreground API", () => {
  it("reads the same handle and rejects a mid-read foreground switch", () => {
    let changed = false;
    let calls = 0;
    const api: AppShotWindowsApi = {
      getForegroundWindow: () => (changed && calls++ > 0 ? 99n : 42n),
      getWindowText: () => identity.windowTitle,
      getWindowRect: () => identity.bounds,
      getWindowThreadAndProcessId: () => ({
        threadId: 1,
        processId: identity.pid,
      }),
      getProcessImagePath: () => "C:\\Synthetic\\editor.exe",
    };
    assert.equal(
      readAppShotWindowsForegroundWithApi(api).applicationName,
      "editor.exe",
    );
    changed = true;
    assert.throws(() => readAppShotWindowsForegroundWithApi(api), /changed/);
    api.getForegroundWindow = () => 0n;
    assert.throws(
      () => readAppShotWindowsForegroundWithApi(api),
      /unavailable/,
    );
    api.getForegroundWindow = () => 9007199254740993n;
    assert.throws(
      () => readAppShotWindowsForegroundWithApi(api),
      /unavailable/,
    );
  });
});

function readAppShotAccessibilityWithApi(
  api: AppShotAccessibilityApi,
  identity: Parameters<typeof readAccessibilityWithApi>[1],
  isAppNotFoundError?: Parameters<typeof readAccessibilityWithApi>[2],
) {
  return readAccessibilityWithApi(api, identity, isAppNotFoundError, {
    width: 1200,
    height: 800,
  });
}

function accessibilityFixture() {
  const window: AppShotAccessibilityElement = {
    name: identity.windowTitle,
    bounds: { ...identity.bounds },
    role: "window",
    children: async () => [
      {
        role: "text",
        name: "Synthetic title",
        value: "Synthetic text",
        bounds: null,
        children: async () => [],
        selector: "must never escape",
        raw: { nativeHandle: "must never escape" },
        actions: ["press"],
      },
    ],
  };
  const app = {
    pid: identity.pid,
    asElement: () => window,
    children: async () => [window],
  };
  const api: AppShotAccessibilityApi = {
    foreground: async () => app,
    byPid: async (pid, options) => {
      assert.equal(pid, identity.pid);
      assert.equal(options.timeout, 0);
      return app;
    },
  };
  return { window, app, api };
}

describe("same-window optional semantic context", () => {
  it("matches PID/title/bounds and exports descriptive actions without native identities", async () => {
    const fake = accessibilityFixture();
    const result = await readAppShotAccessibilityWithApi(fake.api, identity);
    assert.ok(result?.format === "element-tree");
    assert.equal(result.coordinateSpace, "captured-image");
    assert.deepEqual(result.imageSize, { width: 1200, height: 800 });
    assert.equal(result.truncated, false);
    assert.equal(result.root.role, "window");
    assert.equal(result.root.name, identity.windowTitle);
    assert.deepEqual(result.root.bounds, {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
    assert.equal(result.root.children.length, 1);
    const child = result.root.children[0]!;
    assert.equal(child.role, "text");
    assert.equal(child.bounds, null);
    assert.equal(child.name, "Synthetic title");
    assert.equal(child.value, "Synthetic text");
    assert.deepEqual(child.actions, ["press"]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /selector|raw|nativeHandle|must never escape/,
    );
    const mac = await readAppShotAccessibilityWithApi(fake.api, {
      ...identity,
      platform: "darwin",
    });
    assert.deepEqual(mac, result);
    fake.app.pid++;
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
  });

  it("rejects another title, unknown bounds and ambiguous PID-scoped windows", async () => {
    const fake = accessibilityFixture();
    fake.api.foreground = async () => ({
      ...fake.app,
      asElement: () => ({ ...fake.window, name: "Different" }),
    });
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    fake.api.foreground = async () => ({
      ...fake.app,
      asElement: () => ({ ...fake.window, bounds: null }),
    });
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, identity),
      undefined,
    );
    fake.app.children = async () => [fake.window, fake.window];
    assert.equal(
      await readAppShotAccessibilityWithApi(fake.api, {
        ...identity,
        platform: "darwin",
      }),
      undefined,
    );
  });

  it("caps text at 32000 chars and visits at most 10000 nodes without splitting surrogates", async () => {
    const result = await appShotAccessibleElements(
      {
        name: "x".repeat(APP_SHOT_MAX_TEXT - 1) + "😀",
        bounds: null,
        children: async () => [],
      },
      "win32",
      undefined,
    );
    assert.equal(result?.format, "flat-text");
    assert.equal(result?.truncated, true);
    if (result?.format === "flat-text")
      assert.equal(result.text.length, APP_SHOT_MAX_TEXT - 1);
    const nodes = Array.from(
      { length: APP_SHOT_MAX_NODES + 1 },
      (_, index) => ({
        name: index === APP_SHOT_MAX_NODES ? "Must not read" : "",
        bounds: null,
        children: async () => [],
      }),
    );
    const limited = await appShotAccessibleElements(
      { name: null, bounds: null, children: async () => nodes },
      "win32",
      { width: 1, height: 1 },
    );
    assert.equal(limited?.format, "element-tree");
    assert.equal(limited?.truncated, true);
    assert.doesNotMatch(JSON.stringify(limited), /Must not read/);
    const deduped = await appShotAccessibleElements(
      {
        name: "duplicate\0",
        value: "duplicate",
        bounds: null,
        children: async () => [
          {
            name: null,
            value: "child",
            bounds: null,
            children: async () => [],
          },
        ],
      },
      "win32",
      undefined,
    );
    assert.equal(deduped?.format, "flat-text");
    if (deduped?.format === "flat-text")
      assert.equal(deduped.text, "duplicate\nchild");
  });

  it("treats worker failure or invalid identity as screenshot-only", async () => {
    const fake = fakeChild();
    const read = readCapturedAppShotAccessibility(identity, {
      fork: () => fake.child,
    });
    fake.exit();
    assert.equal(await read, undefined);
    assert.equal(
      await readCapturedAppShotAccessibility({ ...identity, pid: 0 }),
      undefined,
    );
  });
});
