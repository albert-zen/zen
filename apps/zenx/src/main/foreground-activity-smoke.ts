import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { ForegroundActivity } from "./foreground-activity.js";
import { ElectronForegroundActivityPresenter } from "./foreground-activity-electron.js";

/** Owned native fixture. It never calls a global input provider or grants consent. */
export async function verifyForegroundActivityOverlay(
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
