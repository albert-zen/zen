import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Display,
  IpcMain,
  Screen,
} from "electron";
import {
  ElectronForegroundActivityPresenter,
  foregroundActivityChannels,
  foregroundOverlayBounds,
} from "../src/main/foreground-activity-electron.js";
import {
  ForegroundActivity,
  type ForegroundActivitySnapshot,
} from "../src/main/foreground-activity.js";
import {
  ComputerZenXCapabilityPackage,
  type ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";

class FakeContents extends EventEmitter {
  readonly mainFrame = { url: "" };
  url = "";
  states: { version: number; agentLabel: string; stopping: boolean }[] = [];
  acknowledge = true;
  getURL() {
    return this.url;
  }
  setWindowOpenHandler() {}
  constructor(readonly ipc: EventEmitter) {
    super();
  }
  send(
    _channel: string,
    state: { version: number; agentLabel: string; stopping: boolean },
  ) {
    this.states.push(state);
    if (this.acknowledge)
      queueMicrotask(() =>
        this.ipc.emit(
          foregroundActivityChannels.painted,
          { sender: this, senderFrame: this.mainFrame },
          state.version,
        ),
      );
  }
}
class FakeWindow extends EventEmitter {
  readonly webContents: FakeContents;
  destroyed = false;
  shown = 0;
  ignored = false;
  bounds: unknown;
  level: string | undefined;
  failLoad = false;
  constructor(
    readonly options: BrowserWindowConstructorOptions,
    ipc: EventEmitter,
  ) {
    super();
    this.webContents = new FakeContents(ipc);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.shown > 0 && !this.destroyed;
  }
  setIgnoreMouseEvents(value: boolean) {
    this.ignored = value;
  }
  setAlwaysOnTop(_value: boolean, level: string) {
    this.level = level;
  }
  setVisibleOnAllWorkspaces() {}
  setHiddenInMissionControl() {}
  setBounds(bounds: unknown) {
    this.bounds = bounds;
  }
  showInactive() {
    this.shown++;
  }
  async loadURL(url: string) {
    if (this.failLoad) throw new Error("load rejected");
    this.webContents.url = url;
    this.webContents.mainFrame.url = url;
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
}
const display = (id: number, x = 0): Display =>
  ({
    id,
    bounds: { x, y: 0, width: 1440, height: 900 },
    workArea: { x, y: 24, width: 1440, height: 876 },
  }) as Display;
const state = (
  ids: string[],
  stopping = false,
): ForegroundActivitySnapshot => ({
  activities: ids.map((id) => ({ id, agentName: id, stopping })),
});
function fixture(
  failLoad = false,
  onUnavailable?: (error: unknown) => void,
  acknowledge = true,
) {
  const windows: FakeWindow[] = [];
  const ipc = new EventEmitter();
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: (): Display[] => displays,
  });
  let displays = [display(1), display(2, -1440)];
  const stops: (readonly string[])[] = [];
  const errors: unknown[] = [];
  const presenter = new ElectronForegroundActivityPresenter({
    createWindow: (options) => {
      const window = new FakeWindow(options, ipc);
      window.failLoad = failLoad;
      window.webContents.acknowledge = acknowledge;
      windows.push(window);
      return window as unknown as BrowserWindow;
    },
    screen: screen as unknown as Screen,
    ipcMain: ipc as unknown as IpcMain,
    preloadPath: "/owned/foreground-activity.cjs",
    language: () => "en",
    platform: "win32",
    onStop: (ids) => stops.push(ids),
    onUnavailable: (error) => {
      errors.push(error);
      onUnavailable?.(error);
    },
  });
  return {
    presenter,
    windows,
    ipc,
    screen,
    stops,
    errors,
    replaceDisplays(value: Display[]) {
      displays = value;
    },
  };
}

test("native overlays cover every current display without activating and isolate their renderer", async () => {
  const f = fixture();
  await f.presenter.update(state(["Atlas"]));
  assert.equal(f.windows.length, 4);
  for (const window of f.windows) {
    assert.equal(window.shown, 1);
    assert.equal(window.options.focusable, false);
    assert.equal(window.options.acceptFirstMouse, !window.ignored);
    assert.equal(window.options.skipTaskbar, true);
    assert.equal(window.options.transparent, true);
    assert.equal(window.options.webPreferences?.sandbox, true);
    assert.equal(window.options.webPreferences?.nodeIntegration, false);
    assert.equal(window.options.webPreferences?.contextIsolation, true);
    assert.equal(
      window.options.webPreferences?.preload,
      "/owned/foreground-activity.cjs",
    );
  }
  assert.deepEqual(
    f.windows.map((window) => window.ignored),
    [true, false, true, false],
  );
  assert.deepEqual(f.windows[2]!.bounds, {
    x: -1440,
    y: 0,
    width: 1440,
    height: 900,
  });
  assert.deepEqual(f.windows[3]!.bounds, {
    x: -960,
    y: 32,
    width: 480,
    height: 64,
  });
  await f.presenter.update(state([]));
  assert.ok(f.windows.every((window) => window.destroyed));
  f.presenter.close();
  assert.equal(f.ipc.listenerCount(foregroundActivityChannels.stop), 0);
  assert.equal(f.screen.listenerCount("display-added"), 0);
});

test("Stop rejects foreign windows, child frames, changed URLs, edge windows and unknown versions", async () => {
  const f = fixture();
  await f.presenter.update(state(["a", "b"]));
  const edge = f.windows[0]!.webContents;
  const status = f.windows[1]!.webContents;
  const version = status.states.at(-1)!.version;
  const send = (sender: unknown, senderFrame: unknown, value = version) =>
    f.ipc.emit(foregroundActivityChannels.stop, { sender, senderFrame }, value);
  send(new FakeContents(f.ipc), status.mainFrame);
  send(status, { url: status.mainFrame.url });
  send(edge, edge.mainFrame);
  send(status, status.mainFrame, version - 1);
  const original = status.mainFrame.url;
  status.mainFrame.url = "https://untrusted.example";
  send(status, status.mainFrame);
  status.mainFrame.url = original;
  assert.equal(f.stops.length, 0);
  send(status, status.mainFrame);
  assert.deepEqual(f.stops, [["a", "b"]]);
  await f.presenter.update(state(["b"]));
  send(status, status.mainFrame);
  assert.deepEqual(
    f.stops[1],
    ["b"],
    "a settled, but b was also displayed in the older version",
  );
  send(status, status.mainFrame, status.states.at(-1)!.version);
  assert.deepEqual(f.stops[2], ["b"]);
  f.presenter.close();
});

test("closed native indicator cancels instead of silently recreating during input", async () => {
  const f = fixture();
  await f.presenter.update(state(["a"]));
  f.windows[0]!.destroy();
  assert.equal(f.errors.length, 1);
  assert.ok(f.windows.every((window) => window.destroyed));
  await assert.rejects(f.presenter.update(state(["a"])), /indicator was lost/);
  assert.equal(f.windows.length, 4);
  await f.presenter.update(state([]));
  await f.presenter.update(state(["new invocation"]));
  assert.equal(f.windows.length, 8);
  f.presenter.close();
});

test("a failed load fails closed and destroys every partial overlay", async () => {
  const f = fixture(true);
  await assert.rejects(f.presenter.update(state(["a"])), /load rejected/);
  assert.equal(f.errors.length, 1);
  assert.ok(f.windows.every((window) => window.destroyed));
  f.presenter.close();
});

test("display removal and geometry changes refresh current identities without focus", async () => {
  const f = fixture();
  await f.presenter.update(state(["a"]));
  const secondary = f.windows.slice(2);
  f.replaceDisplays([display(1, 120)]);
  await f.presenter.update(state(["a"]));
  assert.ok(secondary.every((window) => window.destroyed));
  assert.deepEqual(f.windows[0]!.bounds, {
    x: 120,
    y: 0,
    width: 1440,
    height: 900,
  });
  assert.equal(f.errors.length, 0);
  f.replaceDisplays([display(3, -900)]);
  await f.presenter.update(state(["a"]));
  assert.ok(f.windows.slice(0, 4).every((window) => window.destroyed));
  assert.equal(f.windows.length, 6);
  f.presenter.close();
});

test("status remains in the requested monitor for narrow and negative-origin displays", () => {
  assert.deepEqual(
    foregroundOverlayBounds(
      {
        bounds: { x: -280, y: -600, width: 280, height: 600 },
        workArea: { x: -280, y: -580, width: 280, height: 580 },
      },
      "status",
    ),
    { x: -280, y: -572, width: 280, height: 64 },
  );
});

test("hiding or minimizing the notice cancels input instead of leaving an invisible owner", async () => {
  for (const event of ["hide", "minimize"]) {
    const f = fixture();
    await f.presenter.update(state(["a"]));
    f.windows[1]!.emit(event);
    assert.equal(f.errors.length, 1);
    assert.ok(f.windows.every((window) => window.destroyed));
    f.presenter.close();
  }
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function acknowledge(window: FakeWindow) {
  const contents = window.webContents;
  contents.ipc.emit(
    foregroundActivityChannels.painted,
    { sender: contents, senderFrame: contents.mainFrame },
    contents.states.at(-1)!.version,
  );
}
function clickStop(
  f: ReturnType<typeof fixture>,
  window: FakeWindow,
  version: number,
) {
  f.ipc.emit(
    foregroundActivityChannels.stop,
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    version,
  );
}

test("paint-pending and in-flight old Stop preserve exact old IDs, never newly added owners", async () => {
  const f = fixture();
  await f.presenter.update(state(["a"]));
  const status = f.windows[1]!;
  const oldVersion = status.webContents.states.at(-1)!.version;
  for (const window of f.windows) window.webContents.acknowledge = false;
  const pending = f.presenter.update(state(["a", "b"]));
  await tick();
  clickStop(f, status, oldVersion);
  assert.deepEqual(f.stops, [["a"]]);
  for (const window of f.windows) acknowledge(window);
  await pending;
  clickStop(f, status, oldVersion);
  assert.deepEqual(
    f.stops.at(-1),
    ["a"],
    "old Stop already in transit is still valid after a new ACK",
  );
  for (const window of f.windows) window.webContents.acknowledge = true;
  await f.presenter.update(state(["b", "c"]));
  const stopCount = f.stops.length;
  clickStop(f, status, oldVersion);
  assert.equal(
    f.stops.length,
    stopCount,
    "all owners of the old view settled; do not target b or c",
  );
  f.presenter.close();
});

test("long overlap retains exact old Stop ownership without retaining retired operation IDs", async () => {
  const f = fixture();
  await f.presenter.update(state(["long"]));
  const status = f.windows[1]!;
  const oldestVersion = status.webContents.states.at(-1)!.version;
  for (let index = 0; index < 120; index++) {
    await f.presenter.update(state(["long", `short-${index}`]));
  }
  clickStop(f, status, oldestVersion);
  assert.deepEqual(f.stops.at(-1), ["long"]);
  const recentVersion = status.webContents.states.at(-1)!.version;
  await f.presenter.update(state(["short-119"]));
  const count = f.stops.length;
  clickStop(f, status, oldestVersion);
  assert.equal(f.stops.length, count);
  clickStop(f, status, recentVersion);
  assert.deepEqual(f.stops.at(-1), ["short-119"]);
  f.presenter.close();
});

for (const event of [
  "display-added",
  "display-removed",
  "display-metrics-changed",
] as const) {
  for (const phase of ["pending paint", "cancellation notice"] as const) {
    test(`${event} during ${phase} cancels the old foreground admission before input`, async () => {
      let activity!: ForegroundActivity;
      const f = fixture(
        false,
        (error) => activity.unavailable(error),
        phase !== "pending paint",
      );
      activity = new ForegroundActivity({
        presenter: f.presenter,
        agentName: () => "Fixture",
        report: () => {},
      });
      let dispatched = false;
      const backend = {
        foregroundKeyPress: async () => {
          dispatched = true;
        },
      } as unknown as ZenXComputerBackend;
      const computer = new ComputerZenXCapabilityPackage(
        backend,
        undefined,
        true,
        activity,
      );
      const running = computer.invoke("computer_foreground_key_press", {
        callId: "call",
        name: "computer_foreground_key_press",
        arguments: { key: "enter" },
        cwd: "/fixture",
        signal: new AbortController().signal,
      });
      const rejected = assert.rejects(running, /Displays changed/);
      await tick();
      f.replaceDisplays(
        event === "display-added"
          ? [display(1), display(2), display(3)]
          : event === "display-removed"
            ? [display(1)]
            : [display(1, -100), display(2)],
      );
      f.screen.emit(event);
      assert.equal(
        activity.snapshot.activities[0]?.stopping,
        true,
        "topology cancellation is synchronous, before the old ACK",
      );
      for (const window of f.windows) {
        window.webContents.acknowledge = true;
        if (!window.destroyed && window.webContents.states.length)
          acknowledge(window);
      }
      await rejected;
      assert.equal(dispatched, false);
      activity.close();
    });
  }
  test(`${event} during native work cancels but keeps the owner until actual settlement`, async () => {
    let activity!: ForegroundActivity;
    const f = fixture(false, (error) => activity.unavailable(error));
    activity = new ForegroundActivity({
      presenter: f.presenter,
      agentName: () => "Fixture",
      report: () => {},
    });
    let signal!: AbortSignal;
    let settle!: () => void;
    const running = activity.run(
      {
        callId: "call",
        name: "fixture",
        arguments: {},
        cwd: "/fixture",
        signal: new AbortController().signal,
      },
      (value) => {
        signal = value;
        return new Promise<void>((resolve) => {
          settle = resolve;
        });
      },
    );
    await tick();
    assert.ok(signal);
    f.screen.emit(event);
    assert.equal(signal.aborted, true);
    assert.equal(activity.snapshot.activities[0]?.stopping, true);
    await tick();
    assert.equal(activity.snapshot.activities.length, 1);
    assert.ok(f.windows.some((window) => !window.destroyed));
    settle();
    await running;
    assert.equal(activity.snapshot.activities.length, 0);
    activity.close();
  });
}
