/** Existing-Chrome CDP helper for synthetic renderer fixture capture in CI. */
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
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
      // Capture may opt into the CI runner's existing virtual display.
      ...(process.env.ZENX_PREVIEW_HEADFUL === "1" ? [] : ["--headless=new"]),
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
  let stderr = "";
  child.stderr.on("data", (value) => {
    stderr += value;
  });
  let socket;
  const pending = new Map();
  const errors = [];
  try {
    let port;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Chrome exited: ${stderr}`);
      try {
        port = Number(
          (
            await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
          ).split("\n")[0],
        );
        if (port) break;
      } catch {}
      await delay(50);
    }
    if (!port)
      throw new Error(`Chrome debugging endpoint did not start: ${stderr}`);
    const pages = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    const target = pages.find((page) => page.type === "page");
    if (!target) throw new Error("No page target from existing Chrome");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, "open");
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
  } finally {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Browser closed"));
    }
    socket?.close();
    child.kill("SIGTERM");
    server.close();
    await writeFile(path.join(directory, "chrome.log"), stderr);
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
