/** One sandboxed Chrome, bounded scenes; no aggregate CI dependency or browser download. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { observePreviewChrome } from "./preview-browser-lifecycle.mjs";

// Do not spoof this guard to retry a denied local browser/socket operation.
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Capture runs in GitHub Actions only. Build the HTML locally without starting a browser.",
);
assert.equal(process.platform, "linux", "Existing Ubuntu Chrome required.");
const started = performance.now();
const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const directory = path.resolve(process.argv[2] ?? ".main-ui-preview");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = JSON.parse(
  await readFile(path.join(directory, "source.json"), "utf8"),
);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  source.commit,
  "Rebuild after source commit changes",
);
for (const [file, expected] of Object.entries(source.sources))
  assert.equal(
    hash(await readFile(path.join(root, file))),
    expected,
    `Rebuild changed source: ${file}`,
  );
const files = new Map();
for (const scene of Object.values(source.scenes)) {
  const bytes = await readFile(path.join(directory, scene.html));
  assert.equal(
    hash(bytes),
    scene.sha256,
    `Built HTML matches source receipt: ${scene.html}`,
  );
  files.set(`/${scene.html}`, bytes);
}
if (source.scenes.information) {
  const bytes = await readFile(path.join(directory, "plugin-frame.html"));
  assert.equal(
    hash(bytes),
    source.sources["apps/zenx/src/renderer/public/plugin-frame.html"],
  );
  files.set("/plugin-frame.html", bytes);
}
const evidence = {
  schemaVersion: 1,
  source,
  scope:
    "Fast production-component rendering only. All content and services are synthetic. Not native Electron, OS capture, live Host, end-to-end acceptance or a full regression run.",
  browserSandboxDisabled: false,
  externalRequests: [],
  rendererErrors: [],
  screenshots: {},
  cases: [],
  status: "running",
};
let server, child, socket, lifecycle, profile;
const pending = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  assert(chrome, "Existing Chrome unavailable; no browser is downloaded");
  evidence.chromeVersion = execFileSync(chrome, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  evidence.cjkFonts = execFileSync("fc-list", [":lang=zh", "family"], {
    encoding: "utf8",
    timeout: 10_000,
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert(
    evidence.cjkFonts.length,
    "CJK fonts must be available; do not publish tofu screenshots",
  );
  server = createServer((req, res) => {
    const bytes = files.get(new URL(req.url, "http://localhost").pathname);
    if (!bytes) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(path.join(tmpdir(), "zenx-main-preview-"));
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
  lifecycle = observePreviewChrome(child, profile, { timeoutMs: 20_000 });
  socket = await lifecycle.connect();
  let id = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.method === "Runtime.exceptionThrown")
      evidence.rendererErrors.push(message.params.exceptionDetails);
    if (message.method === "Network.requestWillBeSent") {
      const url = message.params.request.url;
      if (/^https?:/u.test(url) && !url.startsWith(`${origin}/`))
        evidence.externalRequests.push(url);
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      lifecycle.commandStarted(method);
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(Error(`CDP timeout: ${method}`));
      }, 10_000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
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
    for (let i = 0; i < 160; i++) {
      assert.deepEqual(evidence.rendererErrors, [], "Renderer exceptions");
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw Error(`Scene not ready: ${expression}`);
  };
  const click = async (selector) => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    const point = await evaluate(
      `(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2; if(e.disabled||!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Unavailable target'); return {x,y}; })()`,
    );
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        ...point,
        ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }),
      });
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  lifecycle.captureStarted();
  const capture = async (name, options, scene) => {
    await evaluate(
      "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))",
    );
    await delay(200);
    const observation = await evaluate(`(() => {
      const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const selectors={sidebar:'.sidebar',thread:'.thread-view',composer:'.composer',information:'.editable-information-panel',pending:'.queue-shelf',agentName:'.subagent-tree-title'};
      return {url:location.href,viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth,visibleText:document.body.innerText.slice(0,12000),geometry:Object.fromEntries(Object.entries(selectors).map(([k,s])=>[k,rect(document.querySelector(s))])),names:[...document.querySelectorAll('.subagent-tree-title')].map(e=>({text:e.textContent,rect:rect(e),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})),buttons:[...document.querySelectorAll('.queue-shelf button')].map(e=>({label:e.getAttribute('aria-label'),disabled:e.disabled,rect:rect(e),color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor})),active:{tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label')}};
    })()`);
    const result = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(result.data, "base64");
    const filename = `${name}.png`;
    await writeFile(path.join(directory, filename), bytes);
    evidence.screenshots[filename] = hash(bytes);
    evidence.cases.push({
      scene,
      ...options,
      screenshot: filename,
      ...observation,
    });
    await writeFile(
      path.join(directory, "evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  };
  for (const options of [
    {
      name: "desktop-light",
      width: 1280,
      height: 900,
      theme: "light",
      lang: "en",
    },
    {
      name: "desktop-dark",
      width: 1280,
      height: 900,
      theme: "dark",
      lang: "en",
    },
    {
      name: "narrow-light",
      width: 760,
      height: 900,
      theme: "light",
      lang: "en",
    },
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const scene of Object.keys(source.scenes)) {
      const query = new URLSearchParams({
        theme: options.theme,
        lang: options.lang,
        platform: "linux",
      });
      if (scene === "information") query.set("scene", "lineage");
      if (scene === "pending") {
        query.set("many", "");
        if (options.width < 1000) query.set("narrow", "");
      }
      const url = `${origin}/${scene}.html?${query}`;
      await send("Page.navigate", { url });
      await wait(
        `location.href===${JSON.stringify(url)} && !!document.querySelector('#root > *')`,
      );
      if (scene === "main") {
        await click(".thread-row");
        await wait(
          "!!document.querySelector('#thread-browser-toggle') && !!document.querySelector('.composer')",
        );
      } else if (scene === "information") {
        await wait("!!window.__informationFixture");
        await click('[aria-label="Information board"]');
        await wait("!!document.querySelector('.information-widget')");
        await click(".subagent-archived-toggle");
        await wait(
          "document.querySelectorAll('.subagent-tree-title').length>=2",
        );
      } else if (scene === "pending") {
        await wait("!!document.querySelector('.queue-shelf-toggle')");
        if (
          await evaluate(
            "document.querySelector('.queue-shelf-toggle').getAttribute('aria-expanded')==='false'",
          )
        )
          await click(".queue-shelf-toggle");
        await wait(
          "(document.querySelector('.queue-row-edit')?.getBoundingClientRect().width??0)>0",
        );
      }
      await capture(`${scene}-${options.name}`, options, scene);
      if (scene === "pending") {
        const action = await evaluate(
          `(() => {const e=document.querySelector('.queue-row-edit:not(:disabled)'); if(!e)return null; e.scrollIntoView({block:'nearest',inline:'nearest'}); const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2; if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Editable queue action is not visible');return {x,y};})()`,
        );
        assert(action, "An editable user queue row must be rendered");
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...action,
        });
        await capture(`${scene}-${options.name}-hover`, options, scene);
        // Native Tab, not DOM focus(), is what establishes :focus-visible.
        let focused = false;
        for (let index = 0; index < 40; index++) {
          await send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
          });
          await send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
          });
          focused = await evaluate(
            "document.activeElement?.matches('.queue-row-edit:not(:disabled):focus-visible')",
          );
          if (focused) break;
        }
        assert(
          focused,
          "Editable queue action is reachable with a native Tab focus ring",
        );
        await capture(`${scene}-${options.name}-focus`, options, scene);
      }
    }
  }
  assert.deepEqual(
    evidence.externalRequests,
    [],
    "No external resource requests",
  );
  assert.deepEqual(evidence.rendererErrors, [], "No renderer exceptions");
  evidence.status = "passed";
  lifecycle.captureFinished("passed");
} catch (error) {
  evidence.status = "failed";
  evidence.error = String(error?.stack ?? error);
  lifecycle?.captureFinished(
    lifecycle.receipt.captureStatus === "not-started"
      ? "not-started"
      : "failed",
    error,
  );
  throw error;
} finally {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(Error("Browser closed"));
  }
  socket?.terminate();
  try {
    if (lifecycle) {
      const stopped = await lifecycle.close(directory);
      if (lifecycle.receipt.cleanupComplete)
        await rm(profile, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      if (!stopped || lifecycle.receipt.artifactErrors.length) {
        evidence.status = "failed";
        process.exitCode = 1;
      }
    }
  } finally {
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    evidence.captureMs = Math.round(performance.now() - started);
    await writeFile(
      path.join(directory, "evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        status: evidence.status,
        screenshots: Object.keys(evidence.screenshots).length,
        buildMs: source.buildMs,
        captureMs: evidence.captureMs,
      }),
    );
  }
}
