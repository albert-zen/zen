// Copied only by prepare-windows-startup-acceptance.mjs, never built or shipped.
import { app, BrowserWindow } from "electron";
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
export function observe() {
  event("observer", {
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
  });
  app.on("browser-window-created", (_event, window) => {
    windowsCreated++;
    event("created", identity(window));
    window.webContents.on("console-message", (_event, details) => {
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
        const screenshot = await window.webContents.capturePage();
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
export function completed(hostStatus) {
  event("bootstrap-completed", { hostStatus });
  void (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const window = BrowserWindow.getAllWindows()[0];
      if (
        window &&
        !window.webContents.isLoadingMainFrame() &&
        new URL(window.webContents.getURL()).pathname.endsWith("/index.html")
      ) {
        const mounted = await window.webContents.executeJavaScript(
          "document.querySelector('#root')?.childElementCount > 0",
        );
        if (mounted) {
          const screenshot = await window.webContents.capturePage();
          writeFileSync(
            path.join(config.evidenceDirectory, "renderer-loaded.png"),
            screenshot.toPNG(),
          );
          event("renderer-loaded", {
            ...identity(window),
            hostStatus,
            visible: window.isVisible(),
          });
          return;
        }
      }
      await delay(50);
    }
    throw new Error("Normal renderer did not mount");
  })().catch((error) => event("fixture-error", { message: String(error) }));
}
