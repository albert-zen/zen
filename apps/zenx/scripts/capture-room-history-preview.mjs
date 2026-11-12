/** Uses existing Linux Chrome with a fresh synthetic profile, locally or in CI. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { observePreviewChrome } from "./preview-browser-lifecycle.mjs";

const localSynthetic = process.argv[3] === "--local-synthetic";
assert.ok(
  process.argv[3] === undefined || localSynthetic,
  "Only --local-synthetic is accepted as an optional capture mode.",
);
assert.ok(
  process.env.GITHUB_ACTIONS === "true" || localSynthetic,
  "Outside CI, explicitly opt into isolated capture with --local-synthetic.",
);
assert.equal(
  process.platform,
  "linux",
  "This synthetic capture targets Linux.",
);
const directory = path.resolve(process.argv[2] ?? ".room-history-preview");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = {
  scope:
    "Production RoomsPage with responses verified through synthetic journal persistence/restart. No user profile or Agent dispatch. Not native Electron acceptance.",
  browserSandboxDisabled: false,
  cases: [],
  rendererErrors: [],
  externalRequests: [],
};

const measure = `(() => {
  const rows=[...document.querySelectorAll('[data-room-message-id]')];
  const ids=rows.map(e=>e.dataset.roomMessageId);
  const fixture=window.__roomHistoryPreview;
  const expected=fixture.ids.slice(-rows.length);
  const texts=fixture.texts.slice(-rows.length);
  const normalize=s=>s.replace(/\\s+/g,' ').trim();
  const feed=document.querySelector('.rooms-chat-feed');
  const root=document.querySelector('.rooms-chat');
  const bounds=feed.getBoundingClientRect();
  const fullyVisible=row=>{if(!row)return false;const r=row.getBoundingClientRect();return r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1;};
  return {count:rows.length,unique:new Set(ids).size,
    idsMatch:JSON.stringify(ids)===JSON.stringify(expected),
    textsMatch:rows.every((e,i)=>normalize(e.textContent).includes(normalize(texts[i]))),
    rootWidth:root.clientWidth,feedWidth:feed.clientWidth,
    oldestVisible:ids[0]===fixture.ids[0] && rows[0].getBoundingClientRect().top>=bounds.top-1 && rows[0].getBoundingClientRect().top<bounds.bottom,
    latestVisible:ids.at(-1)===fixture.ids.at(-1)&&fullyVisible(rows.at(-1)),
    scrollTop:feed.scrollTop,scrollHeight:feed.scrollHeight,clientHeight:feed.clientHeight,
    viewport:{width:innerWidth,height:innerHeight}};
})()`;

let server;
let child;
let socket;
let profile;
let lifecycle;
const pending = new Map();
let evaluate;
let screenshot;
try {
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
  assert.ok(chrome, "Existing Chrome unavailable; no browser is downloaded.");
  evidence.chrome = chrome;
  evidence.chromeVersion = execFileSync(chrome, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  // Inspect CI's fonts; this process never installs packages or changes security.
  evidence.cjkFonts = execFileSync("fc-list", [":lang=zh", "family"], {
    encoding: "utf8",
    timeout: 10_000,
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  const html = await readFile(path.join(directory, "room-history.html"));
  server = createServer((req, res) => {
    if (
      new URL(req.url, "http://localhost").pathname !== "/room-history.html"
    ) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(path.join(tmpdir(), "zenx-room-history-chrome-"));
  child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  lifecycle = observePreviewChrome(child, profile);
  socket = await lifecycle.connect();
  let id = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.method === "Runtime.exceptionThrown")
      evidence.rendererErrors.push(message.params.exceptionDetails);
    if (message.method === "Network.requestWillBeSent") {
      const requested = message.params.request.url;
      if (/^https?:/u.test(requested) && !requested.startsWith(`${url}/`))
        evidence.externalRequests.push(requested);
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      lifecycle.commandStarted(method);
      const requestId = ++id;
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      pending.set(requestId, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  screenshot = async (name) => {
    const result = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(
      path.join(directory, name),
      Buffer.from(result.data, "base64"),
    );
  };
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(`Fixture condition timed out: ${expression}`);
  };
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    const parameters = { key, code, windowsVirtualKeyCode, modifiers };
    // Match the established production browser-targeted-input.ts semantics.
    // Chromium needs Enter's character payload for native button activation;
    // a keyDown lacking text can report the key without generating the click.
    await send("Input.dispatchKeyEvent", {
      ...parameters,
      type: key === "Enter" ? "keyDown" : "rawKeyDown",
      ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
    });
    await send("Input.dispatchKeyEvent", {
      ...parameters,
      type: "keyUp",
    });
  };
  const click = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
  };
  await send("Page.enable");
  await send("Runtime.enable");
  lifecycle.captureStarted();
  await send("Network.enable");

  // DOM is inspected immediately before each real CDP click. scrollIntoView
  // only exposes the requested target; it does not replace activation/focus.
  const clickSelector = async (selector, index = 0) => {
    const target = await evaluate(
      `(() => { const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,disabled:e.disabled,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}; })()`,
    );
    assert.ok(
      target &&
        !target.disabled &&
        target.width > 0 &&
        target.height > 0 &&
        target.hit,
      `Visible, unobscured target: ${selector}`,
    );
    await click(target.x, target.y);
    await delay(120);
  };
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${url}/room-history.html` });
  await waitFor(
    "document.querySelectorAll('[data-room-message-id]').length === 4",
  );
  const verify = async (name, expectedCount) => {
    const state = await evaluate(measure);
    assert.equal(state.count, expectedCount);
    assert(
      state.rootWidth >= state.viewport.width * 0.95,
      "Production Room root fills its viewport",
    );
    assert(
      state.feedWidth >= state.viewport.width * 0.8,
      "Production feed must not remain in the legacy narrow sidebar column",
    );
    if (name === "oldest")
      assert.equal(
        state.oldestVisible,
        true,
        "Oldest message identifier is visible",
      );
    if (name === "latest")
      assert.equal(
        state.latestVisible,
        true,
        "Latest short synthetic message is fully visible",
      );
    if (name === "oldest")
      assert(
        Math.abs(state.scrollTop) <= 1,
        "Oldest screenshot is at the actual feed top",
      );
    if (name === "latest")
      assert(
        Math.abs(state.scrollHeight - state.clientHeight - state.scrollTop) <=
          1,
        "Latest screenshot is at the actual feed bottom",
      );
    assert.equal(state.unique, expectedCount);
    assert.equal(
      state.idsMatch,
      true,
      "Exact persisted ID order, no omissions or duplicates",
    );
    assert.equal(
      state.textsMatch,
      true,
      "Every displayed body matches the persisted synthetic body",
    );
    const before = state.scrollTop;
    await delay(250);
    const settled = await evaluate(measure);
    assert.equal(settled.count, expectedCount);
    assert(
      Math.abs(settled.scrollTop - before) <= 1,
      "Idle scroll remains stable",
    );
    evidence.cases.push({ name, ...settled, scrollStable: true });
    await screenshot(`${name}.png`);
  };
  await verify("initial", 4);
  let crossed = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    const previous = await evaluate(
      "document.querySelectorAll('[data-room-message-id]').length",
    );
    if (previous === 320) break;
    await clickSelector(".room-load-earlier");
    await waitFor(
      `document.querySelectorAll('[data-room-message-id]').length > ${previous}`,
    );
    await delay(300);
    const count = await evaluate(
      "document.querySelectorAll('[data-room-message-id]').length",
    );
    if (!crossed && count > 256) {
      // Observe the completed user action. Scrolling to the top here is another
      // history-loading gesture, not a neutral screenshot positioning step.
      await verify("cross-256", count);
      crossed = true;
    }
  }
  assert.equal(crossed, true);
  await waitFor(
    "document.querySelectorAll('[data-room-message-id]').length === 320",
  );
  await evaluate("document.querySelector('.rooms-chat-feed').scrollTop = 0");
  await delay(300);
  await verify("oldest", 320);
  await evaluate(
    "document.querySelector('.rooms-chat-feed').scrollTop = document.querySelector('.rooms-chat-feed').scrollHeight",
  );
  await delay(300);
  await verify("latest", 320);
  assert.equal(evidence.rendererErrors.length, 0);
  assert.equal(evidence.externalRequests.length, 0);
  assert(evidence.cjkFonts.length > 0);
  lifecycle.captureFinished("passed");
  evidence.status = "passed";
} catch (error) {
  lifecycle?.captureFinished(
    lifecycle.receipt.captureStatus === "not-started"
      ? "not-started"
      : "failed",
    error,
  );
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  if (evaluate && screenshot) {
    try {
      evidence.failureState = await evaluate(measure);
      await screenshot("failure.png");
    } catch {}
  }
  throw error;
} finally {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(new Error("Preview capture closed."));
  }
  socket?.terminate();
  let stopped = false;
  try {
    stopped = await lifecycle?.close(directory);
  } finally {
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    if (profile && lifecycle?.receipt.cleanupComplete)
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  }
  await writeFile(
    path.join(directory, "measurements.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  if (
    lifecycle &&
    (!stopped || lifecycle.receipt.artifactErrors.length) &&
    evidence.status === "passed"
  )
    throw new Error(
      "Preview Chrome cleanup or artifact persistence incomplete; see lifecycle receipt and stderr.",
    );
}
