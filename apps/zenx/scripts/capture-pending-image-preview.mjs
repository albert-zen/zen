/** Bounded synthetic browser acceptance. Chromium sandbox stays enabled. */
import assert from "node:assert/strict";
import {
  measureImageVisibility,
  captureExitCode,
} from "./pending-image-visibility.mjs";
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
  path.join(os.tmpdir(), "zenx-pending-image-sandboxed-"),
);
const server = createServer(async (req, res) => {
  if (new URL(req.url, "http://127.0.0.1").pathname !== "/pending-image.html") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(await readFile(path.join(directory, "pending-image.html")));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/pending-image.html`;
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
    await evaluate(
      `(${selector}).scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'})`,
    );
    await evaluate(
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
    );
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
    evaluate(`(() => ({
    stage: document.querySelector('[data-stage]')?.getAttribute('data-stage'),
    pending: document.querySelector('.pending-send-row')?.getAttribute('data-send-state') ?? null,
    draftImages: document.querySelectorAll('.draft-image img').length,
    pendingImages: document.querySelectorAll('.pending-send-row .message-images img').length,
    messageImages: document.querySelectorAll('.message-images img').length,
    brokenImages: [...document.querySelectorAll('img')].filter(e => !e.complete || !e.naturalWidth).length,
    overflow: document.documentElement.scrollWidth > innerWidth
  }))()`);
  await send("Page.enable");
  await send("Runtime.enable");
  lifecycle.captureStarted();
  for (const [lang, theme, width, height] of [
    ["en", "light", 1100, 820],
    ["zh-CN", "dark", 390, 600],
    ["zh-CN", "dark", 1100, 820],
    ["en", "light", 390, 600],
  ])
    for (const count of [1, 2]) {
      const scene = `${lang}-${theme}-${width}-${count}-images`;
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const sceneUrl = `${url}?lang=${lang}&theme=${theme}&images=${count}`;
      await send("Page.navigate", { url: sceneUrl });
      await wait(
        `location.href===${JSON.stringify(sceneUrl)}&&!!document.querySelector('.composer')`,
      );
      const snapshots = [];
      const record = async (
        stage,
        pending,
        draftImages,
        pendingImages,
        messageImages,
      ) => {
        await wait(
          `document.querySelector('[data-stage]')?.getAttribute('data-stage') === ${JSON.stringify(stage)}`,
        );
        await wait(
          `[...document.querySelectorAll('img')].every(e => e.complete && e.naturalWidth > 0)`,
        );
        await evaluate("document.fonts.ready");
        await evaluate(
          "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
        );
        const state = await snapshot();
        assert.equal(state.pending, pending);
        assert.equal(state.draftImages, draftImages);
        assert.equal(state.pendingImages, pendingImages);
        assert.equal(state.messageImages, messageImages);
        assert.equal(state.brokenImages, 0);
        assert.equal(state.overflow, false);
        // Narrow failure states can scroll. Prove each image is reachable and
        // actually painted, not merely decoded in an offscreen/hidden DOM node.
        state.imageGeometry = [];
        const imageSelector = ".draft-image img, .message-images img";
        const imageCount = draftImages + messageImages;
        for (let index = 0; index < imageCount; index++) {
          await evaluate(
            `document.querySelectorAll(${JSON.stringify(imageSelector)})[${index}].scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'})`,
          );
          await evaluate(
            "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
          );
          const geometry = await evaluate(
            `(${measureImageVisibility.toString()})(document.querySelectorAll(${JSON.stringify(imageSelector)})[${index}])`,
          );
          state.imageGeometry.push(geometry);
          assert.equal(
            geometry.visible,
            true,
            `${scene}/${stage} image ${index}: ${JSON.stringify(geometry)}`,
          );
          await screenshot(
            `${scene}-${snapshots.length}-${stage}-image-${index}.png`,
          );
        }
        await screenshot(`${scene}-${snapshots.length}-${stage}.png`);
        snapshots.push(state);
      };
      const action = (name) =>
        click(`document.querySelector('[data-fixture="${name}"]')`);
      const submit = () =>
        click(`document.querySelector('.composer-send-control button')`);
      await record("draft", null, count, 0, 0);
      await submit();
      await record("sending", "sending", 0, count, count);
      await click(
        `document.querySelector('.pending-send-row .image-thumbnail')`,
      );
      await wait(`!!document.querySelector('[role="dialog"]')`);
      await wait(
        `document.querySelector('[role="dialog"] img')?.complete && document.querySelector('[role="dialog"] img')?.naturalWidth > 0`,
      );
      await evaluate(
        "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
      );
      const previewGeometry = await evaluate(
        `(${measureImageVisibility.toString()})(document.querySelector('[role="dialog"] img'))`,
      );
      assert.equal(
        previewGeometry.visible,
        true,
        JSON.stringify(previewGeometry),
      );
      await screenshot(`${scene}-preview.png`);
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await wait(`!document.querySelector('[role="dialog"]')`);
      assert.ok(
        await evaluate(
          `document.activeElement?.classList.contains('image-thumbnail')`,
        ),
      );
      await action("admitted");
      await record("admitted", "admitted", 0, count, count);
      await action("canonical");
      await record("canonical", null, 0, 0, count);
      await action("reset");
      await record("draft", null, count, 0, 0);
      await submit();
      await record("sending", "sending", 0, count, count);
      await action("unconfirmed");
      await record("unconfirmed", "unconfirmed", 0, count, count);
      await action("reset");
      await record("draft", null, count, 0, 0);
      await submit();
      await record("sending", "sending", 0, count, count);
      await action("notSent");
      await record("notSent", "notSent", count, count, count);
      cases.push({ lang, theme, width, height, count, snapshots });
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
          "Synthetic production ThreadView, composer reducers and generated PNG browser fixture. Not full App, packaged, native Host, macOS or Windows acceptance.",
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
  process.exitCode = captureExitCode(lifecycle.receipt.captureStatus, closed);
}
