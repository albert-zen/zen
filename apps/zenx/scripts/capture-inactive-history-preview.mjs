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
  path.join(os.tmpdir(), "zenx-history-sandboxed-"),
);
const server = createServer(async (req, res) => {
  const name = new URL(req.url, "http://127.0.0.1").pathname.slice(1);
  if (!["history-before.html", "history-after.html"].includes(name)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(await readFile(path.join(directory, name)));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const args = [
  "--headless=new",
  "--disable-features=BackForwardCache",
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
const pending = new Map();
const errors = [],
  cases = [];
let socket,
  requestId = 0;
let contextsCleared = 0;
try {
  socket = await lifecycle.connect();
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.method === "Runtime.executionContextsCleared")
      contextsCleared++;
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
      if (await evaluate(`Boolean(${expression})`)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Condition timed out: ${expression}`);
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("HeapProfiler.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  lifecycle.captureStarted();
  const snapshot = async () => {
    await send("HeapProfiler.collectGarbage");
    await new Promise((r) => setTimeout(r, 300));
    await send("HeapProfiler.collectGarbage");
    return await send("Runtime.getHeapUsage");
  };
  const capture = async (name, threadId) => {
    await evaluate("document.fonts.ready.then(()=>true)");
    await evaluate(
      "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
    );
    await new Promise((r) => setTimeout(r, 250));
    // DOM text can exist before the virtual transcript has laid it out on screen.
    // Inspect text-line rectangles without scrolling or altering the measured UI.
    const visibleText = (id) => {
      const root = document.querySelector(".thread-view");
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.includes(`Synthetic ${id} turn`)) continue;
        const parent = node.parentElement;
        let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        let hidden = false;
        for (let element = parent; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility !== "visible" ||
            Number(style.opacity) === 0
          ) {
            hidden = true;
            break;
          }
          const rect = element.getBoundingClientRect();
          if (/hidden|clip|scroll|auto/.test(style.overflowX)) {
            clip.left = Math.max(clip.left, rect.left);
            clip.right = Math.min(clip.right, rect.right);
          }
          if (/hidden|clip|scroll|auto/.test(style.overflowY)) {
            clip.top = Math.max(clip.top, rect.top);
            clip.bottom = Math.min(clip.bottom, rect.bottom);
          }
        }
        if (hidden) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const left = Math.max(rect.left, clip.left);
          const top = Math.max(rect.top, clip.top);
          const right = Math.min(rect.right, clip.right);
          const bottom = Math.min(rect.bottom, clip.bottom);
          if (right - left < 2 || bottom - top < 2) continue;
          const hit = document.elementFromPoint(
            (left + right) / 2,
            (top + bottom) / 2,
          );
          if (!hit || !(hit === parent || parent.contains(hit))) continue;
          return {
            text: node.textContent.slice(0, 80),
            rect: [rect.x, rect.y, rect.width, rect.height],
            visibleRect: [left, top, right, bottom],
          };
        }
      }
      return null;
    };
    const deadline = performance.now() + 5000;
    let previous = null;
    let renderedText = null;
    while (performance.now() < deadline) {
      const current = await evaluate(
        `(${visibleText.toString()})(${JSON.stringify(threadId)})`,
      );
      if (
        current &&
        previous &&
        current.text === previous.text &&
        [...current.rect, ...current.visibleRect].every(
          (value, index) =>
            Math.abs(
              value - [...previous.rect, ...previous.visibleRect][index],
            ) < 0.5,
        )
      ) {
        renderedText = current;
        break;
      }
      previous = current;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
      renderedText,
      `No stable visible transcript text for ${threadId}`,
    );
    const image = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(image.data, "base64");
    await writeFile(path.join(directory, name), bytes);
    return {
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      renderedText,
    };
  };
  for (const variant of ["before", "after"]) {
    const result = {
      variant,
      measurements: [],
      screenshots: [],
      navigationMs: [],
      status: "running",
    };
    cases.push(result);
    const destination = `${url}/history-${variant}.html`;
    const previousContextsCleared = contextsCleared;
    await send("Page.navigate", { url: destination });
    for (let i = 0; i < 100 && contextsCleared <= previousContextsCleared; i++)
      await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      contextsCleared > previousContextsCleared,
      "navigation clears old renderer contexts with BFCache disabled",
    );
    await wait(
      `location.href===${JSON.stringify(destination)} && document.body?.dataset.fixtureReady==='true' && document.querySelector('[data-thread-id="history-1"] .thread-row')`,
    );
    await evaluate("document.fonts.ready.then(()=>true)");
    result.measurements.push({ visited: 0, ...(await snapshot()) });
    const choose = async (n, waitContent = true) => {
      const selector = `[data-thread-id="history-${n}"] .thread-row`;
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`,
      );
      await evaluate(
        "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
      );
      const point = await evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(!r.width||!r.height||!(h===e||e.contains(h)))throw Error('Thread row is occluded');return{x,y}})()`,
      );
      const start = performance.now();
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          clickCount: 1,
        });
      if (waitContent)
        await wait(
          `document.querySelector('#thread-composer') && document.querySelector('.thread-view')?.textContent.includes('Synthetic history-${n} turn')`,
        );
      result.navigationMs.push({
        thread: n,
        timingScope: waitContent
          ? "click-through-visible-text"
          : "dispatch-only-before-held-recovery",
        elapsedMs: performance.now() - start,
      });
    };
    await choose(1);
    await evaluate("document.querySelector('#thread-composer').focus()");
    await send("Input.insertText", {
      text: "Synthetic unsent draft retained through history eviction",
    });
    await wait(
      "document.querySelector('#thread-composer')?.value==='Synthetic unsent draft retained through history eviction'",
    );
    for (let n = 2; n <= 32; n++) {
      await choose(n);
      if (n === 8 || n === 32) {
        result.measurements.push({ visited: n, ...(await snapshot()) });
        result.screenshots.push(
          await capture(`history-${variant}-${n}.png`, `history-${n}`),
        );
      }
    }
    await choose(1, false);
    await wait("window.__historyAcceptance.recoveryGate.waiting===true");
    await evaluate(
      "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
    );
    result.firstHistoryVisibleWhileRecoveryHeld = await evaluate(
      "document.querySelector('.thread-view')?.textContent.includes('Synthetic history-1 turn') ?? false",
    );
    assert.equal(
      result.firstHistoryVisibleWhileRecoveryHeld,
      variant === "before",
      "only baseline retains first history before a delayed recovery resolves",
    );
    await evaluate("window.__historyAcceptance.recoveryGate.release();true");
    await wait(
      "document.querySelector('.thread-view')?.textContent.includes('Synthetic history-1 turn') && document.querySelector('#thread-composer')?.value==='Synthetic unsent draft retained through history eviction'",
    );
    result.firstHistoryReads = await evaluate(
      "window.__historyAcceptance.reads['history-1']",
    );
    if (variant === "after")
      assert.equal(
        result.firstHistoryReads,
        2,
        "return navigation requests recovery twice including the first visit",
      );
    result.screenshots.push(
      await capture(`history-${variant}-restored-draft.png`, "history-1"),
    );
    const eight = result.measurements.find((m) => m.visited === 8),
      thirtyTwo = result.measurements.find((m) => m.visited === 32);
    result.usedHeapGrowth8to32 = thirtyTwo.usedSize - eight.usedSize;
    result.status = "passed";
  }
  assert.deepEqual(errors, []);
  lifecycle.captureFinished("passed");
} catch (error) {
  lifecycle.captureFinished("failed", error);
  errors.push({ error: String(error.stack ?? error) });
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
          "Sandboxed Chromium production App, synthetic protocol, deterministic text and explicit GC. V8 used heap only; not Electron/native Host, decoded image/GPU attribution or macOS footprint.",
        source: JSON.parse(
          await readFile(path.join(directory, "source.json"), "utf8"),
        ),
        chromiumSandboxDisabled: false,
        backForwardCacheDisabled: true,
        contextsCleared,
        memoryInterpretation:
          "Reported V8 heap measurements require review; flow success is not a claim of memory improvement or native process footprint.",
        cases,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode =
    lifecycle.receipt.captureStatus === "passed" && closed ? 0 : 1;
}
