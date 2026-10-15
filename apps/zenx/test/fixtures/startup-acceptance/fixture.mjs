// Copied only by prepare-windows-startup-acceptance.mjs, never built or shipped.
import { app, BrowserWindow } from "electron";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const config = JSON.parse(
  readFileSync(
    new URL("./startup-acceptance-config.json", import.meta.url),
    "utf8",
  ),
);
const failure = "Synthetic startup acceptance failure <inert> & visible";
const eventPath = path.join(
  config.evidenceDirectory,
  `events-${process.pid}.jsonl`,
);
let windowsCreated = 0;
function event(type, details = {}) {
  appendFileSync(
    eventPath,
    JSON.stringify({
      type,
      pid: process.pid,
      at: new Date().toISOString(),
      ...details,
    }) + "\n",
  );
}
function identity(window) {
  const bytes = window.getNativeWindowHandle();
  return {
    id: window.id,
    hwnd: (bytes.length === 8
      ? bytes.readBigUInt64LE()
      : BigInt(bytes.readUInt32LE())
    ).toString(),
    windowsCreated,
  };
}
async function captureVisible(window) {
  // did-finish-load can precede the production ready-to-show -> show handler.
  // Observe that real event; never make the fixture itself show the window.
  if (!window.isVisible())
    await once(window, "show", { signal: AbortSignal.timeout(10_000) });
  if (!window.isVisible()) throw new Error("Window is not visible for capture");
  return window.webContents.capturePage();
}
export function observe() {
  event("observer", {
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
  });
  app.on("browser-window-created", (_event, window) => {
    windowsCreated++;
    event("created", identity(window));
    window.webContents.on("console-message", (details) => {
      event("renderer-console", {
        message: details.message,
        level: details.level,
      });
    });
    window.webContents.on(
      "did-fail-load",
      (_event, code, description, url, isMainFrame) => {
        event("page-load-failed", { code, description, url, isMainFrame });
      },
    );
    window.webContents.on("did-finish-load", () => {
      void (async () => {
        const url = window.webContents.getURL();
        const startup = new URL(url).pathname.endsWith("/startup.html");
        if (!startup) return;
        const page = await window.webContents.executeJavaScript(
          `({ role: document.querySelector('main')?.getAttribute('role'), text: document.querySelector('main')?.textContent })`,
        );
        event("startup-page-observed", { ...identity(window), url, ...page });
        const type =
          page.role === "alert" ? "failure-loaded" : "startup-loaded";
        const screenshot = await captureVisible(window);
        writeFileSync(
          path.join(config.evidenceDirectory, `${type}.png`),
          screenshot.toPNG(),
        );
        event(type, {
          ...identity(window),
          ...page,
          visible: window.isVisible(),
        });
      })().catch((error) => event("fixture-error", { message: String(error) }));
    });
  });
  app.on("second-instance", () => {
    event("second-instance-received");
    setImmediate(() =>
      event("second-instance", {
        windows: BrowserWindow.getAllWindows().map(identity),
      }),
    );
  });
  const timer = setInterval(() => {
    if (existsSync(path.join(config.evidenceDirectory, "quit"))) app.quit();
  }, 100);
  timer.unref();
}
export async function gate() {
  event("gate-entered");
  const deadline = Date.now() + 120_000;
  while (!existsSync(path.join(config.evidenceDirectory, "release"))) {
    if (Date.now() >= deadline)
      throw new Error("Startup fixture release timed out");
    await delay(20);
  }
  event("gate-released");
  if (config.mode === "failure") throw new Error(failure);
}
const rendererControls = [".new-thread-action", ".settings-nav-row"];
const rendererObservation = `(() => {
  const bounds = rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  const inViewport = rect => rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  const visible = element => element && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && inViewport(element.getBoundingClientRect());
  const opaqueColor = value => {
    if (!value || value === 'transparent') return false;
    const alpha = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1, -1) : value.startsWith('rgba(') ? value.slice(value.lastIndexOf(',') + 1, -1) : '1';
    return Number.parseFloat(alpha) > 0;
  };
  const controls = ${JSON.stringify(rendererControls)}.map(selector => {
    const element = document.querySelector('#primary-sidebar ' + selector);
    const label = element?.querySelector(':scope > span');
    if (!visible(element) || !visible(label)) return null;
    const style = getComputedStyle(label);
    if (style.visibility !== 'visible' || Number(style.opacity) <= 0 || Number.parseFloat(style.fontSize) <= 0 || !opaqueColor(style.color) || !opaqueColor(style.webkitTextFillColor)) return null;
    // These two product labels have a direct, nonempty text node. Never inspect
    // the button's icon or its other descendants, and never return its text.
    if (label.childNodes.length !== 1 || label.firstChild.nodeType !== Node.TEXT_NODE || !label.firstChild.textContent.trim()) return null;
    const range = document.createRange();
    range.selectNodeContents(label.firstChild);
    const rects = Array.from(range.getClientRects());
    const labelRect = label.getBoundingClientRect();
    if (!rects.length || rects.some(rect => !inViewport(rect) || rect.left < labelRect.left || rect.top < labelRect.top || rect.right > labelRect.right || rect.bottom > labelRect.bottom)) return null;
    if (rects.some(rect => [0.1, 0.5, 0.9].some(fraction => {
      const topmost = document.elementFromPoint(rect.x + rect.width * fraction, rect.y + rect.height / 2);
      return !topmost || !label.contains(topmost);
    }))) return null;
    return { selector, textPresent: true, ...bounds(element.getBoundingClientRect()), textRects: rects.map(bounds), style: { color: style.color, fill: style.webkitTextFillColor, font: style.font, opacity: style.opacity, spacing: style.letterSpacing, transform: style.transform } };
  });
  const shell = document.querySelector('.app-shell');
  return { ready: document.visibilityState === 'visible' && visible(shell) && controls.every(Boolean), width: innerWidth, height: innerHeight, dpr: devicePixelRatio, viewport: visualViewport && { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale, x: visualViewport.offsetLeft, y: visualViewport.offsetTop }, shell: shell && bounds(shell.getBoundingClientRect()), controls };
})()`;

// Pure validation of the actual presented bitmap, not a DOM-only paint claim.
export function rendererFrameEvidence(image, observation) {
  if (!observation?.ready || image.isEmpty()) return null;
  const size = image.getSize(1);
  const bytes = image.toBitmap({ scaleFactor: 1 });
  if (
    size.width <= 0 ||
    size.height <= 0 ||
    bytes.length !== size.width * size.height * 4
  )
    return null;
  if (
    ![observation.width, observation.height, observation.dpr].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  if (observation.controls?.length !== rendererControls.length) return null;
  const controls = [];
  for (let index = 0; index < rendererControls.length; index++) {
    const control = observation.controls[index];
    if (
      !control ||
      control.selector !== rendererControls[index] ||
      control.textPresent !== true
    )
      return null;
    if (!control.textRects?.length) return null;
    let contrast = 255,
      contrastingPixels = 0;
    for (const rect of control.textRects) {
      if (
        ![
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          control.x,
          control.y,
          control.width,
          control.height,
        ].every(Number.isFinite) ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x < control.x ||
        rect.y < control.y ||
        rect.x + rect.width > control.x + control.width ||
        rect.y + rect.height > control.y + control.height
      )
        return null;
      const scaleX = size.width / observation.width,
        scaleY = size.height / observation.height;
      // Round inward so an adjacent icon/border cannot enter the text crop.
      const x = Math.ceil(rect.x * scaleX),
        y = Math.ceil(rect.y * scaleY);
      const right = Math.floor((rect.x + rect.width) * scaleX),
        bottom = Math.floor((rect.y + rect.height) * scaleY);
      if (
        x < 0 ||
        y < 0 ||
        right > size.width ||
        bottom > size.height ||
        right <= x ||
        bottom <= y
      )
        return null;
      let count = 0,
        dominant;
      const colors = new Map();
      const rows = new Set(),
        columns = new Set();
      const minimum = [255, 255, 255],
        maximum = [0, 0, 0];
      // Determine the dominant opaque color from the entire text crop. Its
      // first pixel may be a glyph/isolated defect, never assume background.
      for (let row = y; row < bottom; row++)
        for (let column = x; column < right; column++) {
          const offset = (row * size.width + column) * 4;
          if (bytes[offset + 3] === 0) continue;
          const key =
            (bytes[offset] << 16) |
            (bytes[offset + 1] << 8) |
            bytes[offset + 2];
          let color = colors.get(key);
          if (!color) {
            color = {
              rgb: [bytes[offset], bytes[offset + 1], bytes[offset + 2]],
              count: 0,
            };
            colors.set(key, color);
          }
          color.count++;
          if (!dominant || color.count > dominant.count) dominant = color;
          for (let channel = 0; channel < 3; channel++) {
            minimum[channel] = Math.min(
              minimum[channel],
              bytes[offset + channel],
            );
            maximum[channel] = Math.max(
              maximum[channel],
              bytes[offset + channel],
            );
          }
        }
      if (!dominant) return null;
      for (let row = y; row < bottom; row++)
        for (let column = x; column < right; column++) {
          const offset = (row * size.width + column) * 4;
          if (bytes[offset + 3] === 0) continue;
          const difference = Math.max(
            ...dominant.rgb.map((value, channel) =>
              Math.abs(value - bytes[offset + channel]),
            ),
          );
          if (difference >= 24) {
            count++;
            rows.add(row);
            columns.add(column);
          }
        }
      const rangeContrast = Math.max(
        ...maximum.map((value, channel) => value - minimum[channel]),
      );
      if (rangeContrast < 24 || count < 8 || rows.size < 2 || columns.size < 2)
        return null;
      contrast = Math.min(contrast, rangeContrast);
      contrastingPixels += count;
    }
    controls.push({
      selector: control.selector,
      textPresent: true,
      contrast,
      contrastingPixels,
    });
  }
  return { width: size.width, height: size.height, controls };
}

export function captureRenderedApp(window, deadline) {
  const contents = window.webContents;
  return new Promise((resolve, reject) => {
    let done = false,
      subscribed = false,
      busy = false,
      pending;
    let indexUrl,
      baseline,
      sequence = 0,
      pollTimer,
      pollResume,
      rejectedFrameSaved = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      pollResume?.();
      contents.removeListener("did-start-navigation", navigated);
      contents.removeListener("render-process-gone", gone);
      window.removeListener("closed", closed);
      if (subscribed) {
        try {
          contents.endFrameSubscription();
        } catch (cleanupError) {
          error ??= cleanupError;
        }
      }
      if (error) reject(error);
      else resolve(value);
    };
    const navigated = (details) => {
      if (details.isMainFrame && indexUrl !== undefined)
        finish(new Error("Renderer navigated during presentation acceptance"));
    };
    const gone = () =>
      finish(new Error("Renderer exited during presentation acceptance"));
    const closed = () =>
      finish(new Error("Window closed during presentation acceptance"));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Normal renderer did not present visible product controls before deadline",
          ),
        ),
      Math.max(0, deadline - Date.now()),
    );
    const drain = async () => {
      if (busy || done) return;
      busy = true;
      try {
        while (pending && !done) {
          const frame = pending;
          pending = undefined;
          const observation =
            await contents.executeJavaScript(rendererObservation);
          if (done) return;
          if (Date.now() >= deadline)
            throw new Error("Renderer presentation exceeded original deadline");
          if (contents.getURL() !== frame.url || contents.isLoadingMainFrame())
            throw new Error("Renderer changed during presentation acceptance");
          if (!window.isVisible())
            throw new Error("Renderer window is not visible");
          // A newer presentation invalidates this image even if its older pixels
          // happen to match the newer DOM. Geometry, DPR and text style must also
          // remain identical on both sides of the candidate presentation.
          baseline = observation;
          const stable =
            frame.sequence === sequence &&
            JSON.stringify(frame.before) === JSON.stringify(observation);
          const evidence = stable
            ? rendererFrameEvidence(frame.image, observation)
            : null;
          if (evidence) {
            finish(undefined, {
              image: frame.image,
              evidence: { source: "frame-subscription", ...evidence },
            });
            return;
          }
          if (
            observation?.ready &&
            !rejectedFrameSaved &&
            !frame.image.isEmpty()
          ) {
            writeFileSync(
              path.join(
                config.evidenceDirectory,
                "renderer-first-rejected.png",
              ),
              frame.image.toPNG({ scaleFactor: 1 }),
            );
            rejectedFrameSaved = true;
          }
        }
      } catch (error) {
        finish(error);
      } finally {
        busy = false;
      }
    };
    contents.on("did-start-navigation", navigated);
    contents.once("render-process-gone", gone);
    window.once("closed", closed);
    void (async () => {
      // Establish a ready DOM baseline before observing any candidate frame.
      // A read-only poll does not request paint or alter focus/style/timing.
      while (!done) {
        const url = contents.getURL();
        if (
          !contents.isLoadingMainFrame() &&
          new URL(url).pathname.endsWith("/index.html")
        ) {
          indexUrl ??= url;
          if (url !== indexUrl)
            throw new Error(
              "Renderer document changed before presentation acceptance",
            );
          baseline = await contents.executeJavaScript(rendererObservation);
          if (done) return;
          if (contents.getURL() !== url || contents.isLoadingMainFrame())
            throw new Error("Renderer changed during baseline observation");
          if (baseline?.ready) break;
        }
        await new Promise((resume) => {
          pollResume = resume;
          pollTimer = setTimeout(
            resume,
            Math.min(50, Math.max(0, deadline - Date.now())),
          );
        });
        pollResume = undefined;
        pollTimer = undefined;
      }
      if (done) return;
      if (Date.now() >= deadline)
        throw new Error("Renderer baseline exceeded original deadline");
      subscribed = true;
      contents.beginFrameSubscription(false, (image) => {
        if (done) return;
        sequence++;
        try {
          const url = contents.getURL();
          if (contents.isLoadingMainFrame() || url !== indexUrl)
            throw new Error(
              "Renderer document changed during presentation acceptance",
            );
          pending = { image, url, sequence, before: baseline };
          void drain();
        } catch (error) {
          finish(error);
        }
      });
    })().catch(finish);
  });
}

export function completed(hostStatus) {
  event("bootstrap-completed", { hostStatus });
  void (async () => {
    const deadline = Date.now() + 30_000;
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Normal renderer window is missing");
    const { image, evidence } = await captureRenderedApp(window, deadline);
    writeFileSync(
      path.join(config.evidenceDirectory, "renderer-loaded.png"),
      image.toPNG({ scaleFactor: 1 }),
    );
    event("renderer-loaded", {
      ...identity(window),
      hostStatus,
      visible: window.isVisible(),
      presentation: evidence,
    });
  })().catch((error) => event("fixture-error", { message: String(error) }));
}
