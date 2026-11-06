/** Bounded synthetic browser acceptance. Chromium sandbox stays enabled. */
import assert from "node:assert/strict";
import {
  assertSteerGeometry,
  measureSteerComparison,
  assertSteerDisclosure,
} from "./steer-image-geometry.mjs";
import {
  measureImageVisibility,
  measureBubbleVisibility,
  captureExitCode,
} from "./steer-image-visibility.mjs";
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
  path.join(os.tmpdir(), "zenx-steer-image-sandboxed-"),
);
const server = createServer(async (req, res) => {
  if (new URL(req.url, "http://127.0.0.1").pathname !== "/steer-image.html") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(await readFile(path.join(directory, "steer-image.html")));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/steer-image.html`;
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
let expectedState = null;
let reportFailure;
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
  const waitForVisibleImage = async (selector) => {
    const probe = `(() => { const image = ${selector}; return image ? (${measureImageVisibility.toString()})(image) : null; })()`;
    // Virtual rows can remain transparent while the list measures them. Reuse
    // the bounded wait and the exact strict predicate; never change list CSS.
    await wait(`(${probe})?.visible === true`);
    return await evaluate(probe);
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
    pendingImages: document.querySelectorAll('.pending-steer-panel .message-images img').length,
    pendingBody: document.querySelector('.pending-steer-panel .user-bubble')?.textContent,
    messageImages: document.querySelectorAll('.message-images img').length,
    brokenImages: [...document.querySelectorAll('img')].filter(e => !e.complete || !e.naturalWidth).length,
    overflow: document.documentElement.scrollWidth > innerWidth
  }))()`);
  reportFailure = async (error) => {
    const observed = await snapshot();
    observed.imageGeometry = await evaluate(
      `[...document.querySelectorAll('.draft-image img, .message-images img, [role="dialog"] img')].map(${measureImageVisibility.toString()})`,
    );
    const dom = await evaluate(`(() => ({
      text: document.body.innerText,
      images: [...document.querySelectorAll('img')].map(e => ({src: e.getAttribute('src'), complete: e.complete, naturalWidth: e.naturalWidth, outerHTML: e.outerHTML})),
      threadHTML: document.querySelector('.thread-conversation-surface')?.outerHTML
    }))()`);
    await writeFile(
      path.join(directory, "failure.json"),
      JSON.stringify(
        {
          expected: expectedState,
          observed,
          error: { message: error.message, stack: error.stack },
          dom,
        },
        null,
        2,
      ) + "\n",
    );
    await screenshot("failure.png");
  };
  await send("Page.enable");
  await send("Runtime.enable");
  lifecycle.captureStarted();
  for (const [lang, theme, width, height] of [
    ["zh-CN", "light", 1100, 900],
    ["en", "dark", 390, 700],
  ])
    for (const count of [1, 2])
      for (const body of ["short", "long"])
        for (const state of ["pending", "held", "recall-failure"]) {
          const scene = `${lang}-${theme}-${width}-${count}-${body}-${state}`;
          expectedState = { scene };
          await send("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const sceneUrl = `${url}?lang=${lang}&theme=${theme}&images=${count}&text=${body}&state=${state}`;
          await send("Page.navigate", { url: sceneUrl });
          await wait(
            `location.href === ${JSON.stringify(sceneUrl)} && !!document.querySelector('.pending-steer-panel .image-thumbnail')`,
          );
          // Pending attachment payloads are lazy: make each real thumbnail
          // reachable before waiting for decoding, including clipped shelves.
          await wait(
            `document.querySelectorAll('.message-images .image-thumbnail').length === ${count * 2}`,
          );
          for (let imageIndex = 0; imageIndex < count * 2; imageIndex++) {
            const thumbnail = `document.querySelectorAll('.message-images .image-thumbnail')[${imageIndex}]`;
            await evaluate(
              `(${thumbnail}).scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})`,
            );
            await wait(
              `(${thumbnail}).querySelector('img')?.complete && (${thumbnail}).querySelector('img')?.naturalWidth > 0`,
            );
          }
          await wait(
            `[...document.querySelectorAll('.message-images img')].length === ${count * 2} && [...document.querySelectorAll('.message-images img')].every(e => e.complete && e.naturalWidth > 0)`,
          );
          await evaluate("document.fonts.ready");
          if (state === "recall-failure") {
            await click(
              `document.querySelector('.pending-steer-heading .queue-header-action')`,
            );
            await wait(
              `!!document.querySelector('.pending-steer-panel > [role="status"]')`,
            );
          }
          await evaluate(
            "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
          );
          const disclosureSelector =
            ".pending-steer-panel .pending-steer-message";
          if (body === "long") {
            assert.equal(
              await evaluate(
                `document.querySelector(${JSON.stringify(disclosureSelector)})?.open`,
              ),
              false,
              `${scene}: disclosure starts collapsed`,
            );
            await click(
              `document.querySelector(${JSON.stringify(disclosureSelector + " > summary")})`,
            );
            await wait(
              `document.querySelector(${JSON.stringify(disclosureSelector)})?.open === true`,
            );
          }
          const geometry = await evaluate(
            `(${measureSteerComparison.toString()})(document)`,
          );
          assertSteerDisclosure(geometry, body === "long", scene);
          cases.push({ scene, geometry });
          assertSteerGeometry(geometry, count, scene);
          for (const selector of [
            '[data-sent-message-id="synthetic-normal"] .image-thumbnail img',
            ".pending-steer-panel .image-thumbnail img",
          ]) {
            for (let index = 0; index < count; index++) {
              const target = `document.querySelectorAll(${JSON.stringify(selector)})[${index}]`;
              await evaluate(
                `(${target}).scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})`,
              );
              await waitForVisibleImage(target);
              const owner = selector.startsWith("[data-sent")
                ? "normal"
                : "pending";
              await screenshot(`${scene}-${owner}-image-${index}.png`);
            }
          }
          const bubbleTarget = `document.querySelector('.pending-steer-panel .pending-steer-text')`;
          const bubbleVisibility = [];
          for (const block of ["start", "end"]) {
            await evaluate(
              `(${bubbleTarget}).scrollIntoView({block:${JSON.stringify(block)},inline:'nearest',behavior:'instant'})`,
            );
            const probe = `(${measureBubbleVisibility.toString()})(${bubbleTarget})`;
            await wait(`(${probe}).visible === true`);
            bubbleVisibility.push(await evaluate(probe));
            await screenshot(`${scene}-body-${block}.png`);
          }
          cases.at(-1).bubbleVisibility = bubbleVisibility;
        }
  assert.deepEqual(errors, []);
  lifecycle.captureFinished("passed");
} catch (error) {
  lifecycle.captureFinished("failed", error);
  if (reportFailure) {
    try {
      await reportFailure(error);
    } catch (diagnosticError) {
      errors.push({ diagnosticFailure: String(diagnosticError) });
    }
  }
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
          "Synthetic production ThreadView canonical/pending steer geometry comparison with generated PNGs. Not full App, packaged, native Host, macOS or Windows acceptance.",
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
