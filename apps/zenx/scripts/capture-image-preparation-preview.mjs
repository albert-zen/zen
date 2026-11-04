/** Bounded synthetic browser acceptance. Chromium sandbox stays enabled. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import os from "node:os";
import { observePreviewChrome } from "./preview-browser-lifecycle.mjs";
const directory = path.resolve(process.argv[2]);
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
await writeFile(
  path.join(directory, "prerequisite.json"),
  JSON.stringify(
    {
      available: Boolean(chrome),
      executable: chrome ?? null,
      browserDownloaded: false,
      chromiumSandboxDisabled: false,
      diagnostic: chrome
        ? "Using an existing installed Chrome executable."
        : "Existing Chrome executable unavailable; no browser is downloaded and no sandbox bypass is attempted.",
    },
    null,
    2,
  ) + "\n",
);
assert.ok(chrome, "Existing installed Chrome executable unavailable");
const profile = await mkdtemp(
  path.join(os.tmpdir(), "zenx-image-prep-sandboxed-"),
);
const server = createServer(async (req, res) => {
  if (
    new URL(req.url, "http://127.0.0.1").pathname !== "/image-preparation.html"
  ) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(await readFile(path.join(directory, "image-preparation.html")));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/image-preparation.html`;
const args = [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "about:blank",
];
const child = spawn(chrome, args, {
  stdio: ["ignore", "ignore", "pipe"],
});
const lifecycle = observePreviewChrome(child, profile);
const cases = [],
  screenshots = [],
  errors = [],
  pending = new Map();
let socket,
  requestId = 0;
try {
  socket = await lifecycle.connect();
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      lifecycle.commandStarted(method);
      const id = ++requestId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(Error(`CDP timeout: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Condition timed out: ${expression}`);
  };
  const click = async (selector) => {
    const p = await evaluate(
      `(() => { const e=${selector}; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        button: "left",
        clickCount: 1,
        ...p,
      });
  };
  const screenshot = async (name) => {
    const result = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(result.data, "base64");
    await writeFile(path.join(directory, name), bytes);
    screenshots.push({
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  const snapshot = () =>
    evaluate(
      `(() => { const thread=document.querySelector('.thread-conversation-surface'); return {noticeCount:document.querySelectorAll('.image-preparation-notice, .image-preparation-fallback').length,threadText:thread?.innerText??null,composerCount:document.querySelectorAll('.composer').length,overflow:document.documentElement.scrollWidth>innerWidth,viewport:{width:innerWidth,height:innerHeight},status:document.querySelector('header [role=status]')?.textContent}; })()`,
    );
  await send("Page.enable");
  await send("Runtime.enable");
  lifecycle.captureStarted();
  for (const [lang, theme, width, height] of [
    ["en", "light", 1100, 820],
    ["zh-CN", "dark", 390, 600],
    ["zh-CN", "dark", 1100, 820],
    ["en", "light", 390, 600],
  ]) {
    const scene = `${lang}-${theme}-${width}`;
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const sceneUrl = `${url}?lang=${lang}&theme=${theme}`;
    await send("Page.navigate", { url: sceneUrl });
    await wait(
      `location.href===${JSON.stringify(sceneUrl)}&&!!document.querySelector('.composer')`,
    );
    await evaluate("document.fonts.ready");
    const snapshots = [];
    for (const label of [
      "Current",
      "Ordinary prepared",
      "Codec unavailable",
      "Mixed outcome",
      "Codec cold selected",
      "Compacted",
      "Later unavailable",
      "Retained only",
      "Other thread",
      "Current",
    ]) {
      await click(
        `[...document.querySelectorAll('header button')].find(e=>e.textContent===${JSON.stringify(label)})`,
      );
      await wait(
        `document.querySelector('header [role=status]')?.textContent===${JSON.stringify(`Synthetic snapshot: ${label}`)}`,
      );
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const state = await snapshot();
      assert.equal(state.noticeCount, 0);
      assert.equal(state.composerCount, 1);
      assert.equal(state.overflow, false);
      assert.ok(state.threadText);
      assert.doesNotMatch(
        state.threadText,
        /model-only|synthetic-original|9999|Model image view|Image unavailable to model|View image sizes|Original-detail|模型图片视图|模型无法查看图片|查看图片尺寸|高细节视图/,
      );
      const name = `${scene}-${snapshots.length}-${label.toLowerCase().replaceAll(" ", "-")}.png`;
      await screenshot(name);
      snapshots.push({ label, ...state });
    }
    cases.push({ lang, theme, width, height, snapshots });
  }
  assert.deepEqual(errors, []);
  lifecycle.captureFinished("passed");
} catch (error) {
  lifecycle.captureFinished("failed", error);
  throw error;
} finally {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(Error("Browser closed"));
  }
  socket?.terminate();
  const closed = await lifecycle.close(directory);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  if (closed) await rm(profile, { recursive: true, force: true });
  await writeFile(
    path.join(directory, "acceptance.json"),
    JSON.stringify(
      {
        ok: lifecycle.receipt.captureStatus === "passed" && closed,
        scope:
          "Synthetic production ThreadView browser fixture. Not full App, packaged, native Host, macOS or Windows acceptance.",
        source: JSON.parse(
          await readFile(path.join(directory, "source.json"), "utf8"),
        ),
        executable: child.spawnfile,
        launchArguments: args.map((a) =>
          a.startsWith("--user-data-dir=")
            ? "--user-data-dir=<isolated synthetic profile>"
            : a,
        ),
        chromiumSandboxDisabled: false,
        cases,
        screenshots,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
}
