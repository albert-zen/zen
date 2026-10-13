import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { ForegroundActivity } from "./foreground-activity.js";
import {
  ElectronForegroundActivityPresenter,
  foregroundOverlayBounds,
} from "./foreground-activity-electron.js";
import { startWindowsForegroundInputProbe } from "./windows-foreground-input-probe.js";

/** Owned native fixture. It never grants product foreground-control consent. */
export async function verifyForegroundActivityOverlay(preloadPath: string) {
  const cdp = await verifyForegroundActivityCdpOverlay(preloadPath);
  const osRoutedInput =
    process.platform === "win32"
      ? await verifyWindowsForegroundActivityInput(preloadPath)
      : {
          status: "not_verified",
          reason:
            "External-app OS-input phase is not implemented on this platform; CDP evidence only",
        };
  return { ...cdp, osRoutedInput };
}

async function verifyForegroundActivityCdpOverlay(
  preloadPath: string,
): Promise<{
  displays: number;
  focusedFixturePreserved: true;
  stopConfirmed: true;
  cleanedUp: true;
}> {
  const keepAlive = () => {};
  app.on("window-all-closed", keepAlive);
  const fixture = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const overlays: BrowserWindow[] = [];
  let activity: ForegroundActivity | undefined;
  let release: (() => void) | undefined;
  const errors: unknown[] = [];
  const presenter = new ElectronForegroundActivityPresenter({
    createWindow: (options) => {
      const window = new BrowserWindow(options);
      overlays.push(window);
      return window;
    },
    screen,
    ipcMain,
    preloadPath,
    language: () => "en",
    onStop: (ids) => activity!.stop(ids),
    onUnavailable: (error) => activity!.unavailable(error),
  });
  activity = new ForegroundActivity({
    presenter,
    agentName: () => "Native fixture",
    report: (error) => errors.push(error),
  });
  try {
    await fixture.loadURL(
      "data:text/html,<title>ZenX foreground overlay fixture</title><input id='field' autofocus value='Focus guard'>",
    );
    fixture.show();
    fixture.focus();
    await waitFor(() => fixture.isFocused(), "owned fixture focus");
    const cursorBefore = screen.getCursorScreenPoint();
    const invocation = {
      callId: "owned-overlay-fixture",
      name: "owned_fixture",
      arguments: {},
      cwd: process.cwd(),
      signal: new AbortController().signal,
    };
    let entered = false;
    let executionError: unknown;
    let cancelled = false;
    const running = activity.run(
      invocation,
      (signal) =>
        new Promise<void>((resolve) => {
          entered = true;
          release = resolve;
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
            },
            { once: true },
          );
        }),
    );
    void running.catch((error: unknown) => {
      executionError = error;
    });
    await waitFor(
      () => entered || executionError !== undefined,
      "rendered foreground indicator",
    );
    if (executionError !== undefined) throw executionError;
    assert.equal(overlays.length, screen.getAllDisplays().length * 2);
    assert.equal(
      fixture.isFocused(),
      true,
      "showInactive must preserve the focused fixture",
    );
    assert.deepEqual(screen.getCursorScreenPoint(), cursorBefore);
    for (const window of overlays) {
      assert.equal(window.isVisible(), true);
      assert.equal(window.isFocusable(), false);
      assert.equal(window.isFocused(), false);
      assert.equal(window.isAlwaysOnTop(), true);
    }
    const status = overlays[1]!;
    const button = await status.webContents.executeJavaScript(
      `(() => { const e = document.getElementById('stop'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: e.textContent }; })()`,
    );
    assert.equal(button.label, "Stop");
    // Target the owned renderer without focusing the non-activating window.
    // sendInputEvent requires OS focus; CDP exercises the trusted preload click
    // path here, but does not prove physical OS pointer pass-through.
    const debugger_ = status.webContents.debugger;
    debugger_.attach("1.3");
    try {
      await debugger_.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        buttons: 1,
        clickCount: 1,
        x: button.x,
        y: button.y,
      });
      await debugger_.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        buttons: 0,
        clickCount: 1,
        x: button.x,
        y: button.y,
      });
    } finally {
      if (!status.isDestroyed() && debugger_.isAttached()) debugger_.detach();
    }
    await waitFor(() => cancelled, "trusted Stop cancellation");
    assert.equal(activity.snapshot.activities.length, 1);
    assert.equal(activity.snapshot.activities[0]?.stopping, true);
    assert.ok(overlays.every((window) => !window.isDestroyed()));
    release?.();
    await running;
    await waitFor(
      () => overlays.every((window) => window.isDestroyed()),
      "native indicator cleanup",
    );
    assert.equal(fixture.isFocused(), true);
    assert.equal(errors.length, 0);
    return {
      displays: screen.getAllDisplays().length,
      focusedFixturePreserved: true,
      stopConfirmed: true,
      cleanedUp: true,
    };
  } finally {
    activity.close();
    release?.();
    if (!fixture.isDestroyed()) fixture.destroy();
    app.removeListener("window-all-closed", keepAlive);
  }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 7_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/** Actual OS hit testing against a different process, not a hardware HID claim. */
async function verifyWindowsForegroundActivityInput(preloadPath: string) {
  const keepAlive = () => {};
  app.on("window-all-closed", keepAlive);
  const windows: BrowserWindow[] = [];
  const failures: unknown[] = [];
  const stops: string[][] = [];
  let activity: ForegroundActivity | undefined;
  let release: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let originalFailure: unknown;
  let native:
    Awaited<ReturnType<typeof startWindowsForegroundInputProbe>> | undefined;
  try {
    native = await startWindowsForegroundInputProbe();
    assert.notEqual(native.ready.guardPid, process.pid);
    const presenter = new ElectronForegroundActivityPresenter({
      createWindow(options) {
        const window = new BrowserWindow(options);
        windows.push(window);
        return window;
      },
      screen,
      ipcMain,
      preloadPath,
      language: () => "en",
      onStop(ids) {
        stops.push([...ids]);
        activity!.stop(ids);
      },
      onUnavailable(error) {
        activity!.unavailable(error);
      },
    });
    activity = new ForegroundActivity({
      presenter,
      agentName: () => "Native OS-input fixture",
      report: (error) => failures.push(error),
    });
    let entered = false;
    let aborts = 0;
    let executionError: unknown;
    running = activity.run(
      {
        callId: "owned-native-input-fixture",
        name: "owned_fixture",
        arguments: {},
        cwd: process.cwd(),
        signal: new AbortController().signal,
      },
      (signal) =>
        new Promise<void>((resolve) => {
          entered = true;
          release = resolve;
          signal.addEventListener("abort", () => {
            aborts++;
          });
        }),
    );
    void running.catch((error: unknown) => {
      executionError = error;
    });
    await waitFor(
      () => entered || executionError !== undefined,
      "external-guard overlay paint",
    );
    if (executionError !== undefined) throw executionError;
    const owner = activity.snapshot.activities[0]!.id;
    const edge = await native.clickEdge();
    assert.equal(aborts, 0);
    assert.equal(stops.length, 0);
    assert.equal(activity.snapshot.activities.length, 1);
    const expected = foregroundOverlayBounds(
      screen.getPrimaryDisplay(),
      "status",
    );
    const status = windows.find((window) => {
      const bounds = window.getBounds();
      return (
        bounds.x === expected.x &&
        bounds.y === expected.y &&
        bounds.width === expected.width &&
        bounds.height === expected.height
      );
    });
    assert.ok(status, "primary-display status window must exist");
    // Read geometry only. Delivery below is SendInput through the OS, not CDP.
    const point: { x: number; y: number } =
      await status.webContents.executeJavaScript(
        `(() => { const r = document.getElementById('stop').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
    const bounds = status.getContentBounds();
    const physical = screen.dipToScreenPoint({
      x: Math.round(bounds.x + point.x),
      y: Math.round(bounds.y + point.y),
    });
    const stop = await native.clickStop(
      physical,
      status.getNativeWindowHandle(),
    );
    await waitFor(() => aborts === 1, "one OS-routed Stop click");
    assert.deepEqual(stops, [[owner]]);
    assert.equal(activity.snapshot.activities.length, 1);
    assert.equal(activity.snapshot.activities[0]!.stopping, true);
    assert.ok(windows.every((window) => !window.isFocused()));
    release?.();
    await running;
    await waitFor(
      () => windows.every((window) => window.isDestroyed()),
      "OS-input overlay cleanup",
    );
    const final = await native.finish();
    assert.equal(failures.length, 0);
    return {
      status: "passed",
      kind: "windows-os-routed-input",
      hardwareInput: false,
      positiveControl: native.ready,
      edge,
      stop,
      final,
      stopCallbacks: stops.length,
      aborts,
      displays: screen
        .getAllDisplays()
        .map(({ id, bounds, scaleFactor }) => ({ id, bounds, scaleFactor })),
    };
  } catch (cause) {
    originalFailure = cause;
    throw cause;
  } finally {
    activity?.close();
    release?.();
    if (running) await running.catch(() => undefined);
    try {
      await native?.close(originalFailure);
    } finally {
      app.removeListener("window-all-closed", keepAlive);
    }
  }
}
