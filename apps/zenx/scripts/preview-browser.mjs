/** Existing-Chrome CDP helper for synthetic renderer fixture capture in CI. */
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { observePreviewChrome } from "./preview-browser-lifecycle.mjs";
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function withPreviewBrowser(directory, run) {
  let chrome;
  for (const candidate of [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean)) {
    try {
      await access(candidate, constants.X_OK);
      chrome = candidate;
      break;
    } catch {}
  }
  if (!chrome)
    throw new Error(
      "Existing Chrome executable unavailable; no browser is downloaded by this fixture.",
    );
  const profile = await mkdtemp(path.join(tmpdir(), "zenx-preview-chrome-"));
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, "http://localhost").pathname.slice(1);
    if (!/^[a-z0-9-]+\.html$/u.test(name)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(await readFile(path.join(directory, name)));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(
    chrome,
    [
      "--headless=new",
      // Explicit test-device emulation, as in Playwright's Chromium launcher.
      // Chromium web_preferences.mojom defines hover=2 and fine pointer=4:
      // https://github.com/chromium/chromium/blob/main/third_party/blink/public/mojom/webpreferences/web_preferences.mojom
      ...(process.env.ZENX_PREVIEW_DESKTOP_INPUT === "1"
        ? [
            "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2",
          ]
        : []),
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const lifecycle = observePreviewChrome(child, profile);
  let socket;
  const pending = new Map();
  const errors = [];
  try {
    socket = await lifecycle.connect();
    let id = 0;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.method === "Runtime.exceptionThrown")
        errors.push(message.params.exceptionDetails);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error)
        request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        lifecycle.commandStarted(method);
        const requestId = ++id;
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`CDP timeout: ${method}`));
        }, 15000);
        pending.set(requestId, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send("Page.enable");
    await send("Runtime.enable");
    lifecycle.captureStarted();
    await run({
      send,
      evaluate,
      url,
      errors,
      screenshot: async (name) => {
        const result = await send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        await writeFile(
          path.join(directory, name),
          Buffer.from(result.data, "base64"),
        );
      },
    });
    if (errors.length)
      throw new Error(`Renderer exceptions: ${JSON.stringify(errors)}`);
    lifecycle.captureFinished("passed");
  } catch (error) {
    lifecycle.captureFinished(
      lifecycle.receipt.captureStatus === "not-started"
        ? "not-started"
        : "failed",
      error,
    );
    throw error;
  } finally {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Browser closed"));
    }
    socket?.terminate();
    let stopped = false;
    try {
      stopped = await lifecycle.close(directory);
    } finally {
      server.closeAllConnections();
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
      if (lifecycle.receipt.cleanupComplete)
        await rm(profile, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
    }
    if (
      (!stopped || lifecycle.receipt.artifactErrors.length) &&
      lifecycle.receipt.captureStatus === "passed"
    )
      throw new Error(
        "Preview Chrome cleanup or artifact persistence incomplete; see lifecycle receipt and stderr.",
      );
  }
}
