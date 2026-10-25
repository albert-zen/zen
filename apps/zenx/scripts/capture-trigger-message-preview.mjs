/** Uses the existing Ubuntu CI Chrome, never a user profile or downloaded browser. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";

assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "This capture runs only in GitHub Actions; open the HTML manually elsewhere.",
);
assert.equal(process.platform, "linux", "This fixture targets Ubuntu CI.");
const directory = path.resolve(process.argv[2] ?? ".trigger-message-preview");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = {
  scope:
    "Actual ThreadView and TriggersPanel with synthetic definitions/history; no Host, scheduling, private settings, mutations or persistence. Not native Electron or full App acceptance.",
  browserSandboxDisabled: false,
  cases: [],
  rendererErrors: [],
  externalRequests: [],
};

const measure = `(() => ({viewport:{width:innerWidth,height:innerHeight}, bubbles:document.querySelectorAll('.trigger-message-row .user-bubble').length, editor:!!document.querySelector('.trigger-editor'), overflow:document.documentElement.scrollWidth>innerWidth, focus:{tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label')}, calls:window.__triggerPreview.calls}))()`;

let server;
let child;
let socket;
let profile;
let stderr = "";
let spawnError;
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

  const html = await readFile(path.join(directory, "trigger-message.html"));
  server = createServer((req, res) => {
    if (
      new URL(req.url, "http://localhost").pathname !== "/trigger-message.html"
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
  profile = await mkdtemp(path.join(tmpdir(), "zenx-trigger-message-chrome-"));
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
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stderr.on("data", (data) => {
    stderr = (stderr + String(data)).slice(-65_536);
  });
  let port;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Existing Chrome exited before capture: ${stderr}`);
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
  assert.ok(port, `Existing Chrome did not become ready: ${stderr}`);
  const pages = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  const target = pages.find((page) => page.type === "page");
  assert.ok(target, "Existing Chrome exposed a page target.");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
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
  for (const options of [
    {
      name: "desktop-en",
      lang: "en",
      theme: "dark",
      width: 1100,
      height: 800,
      panel: "0",
    },
    {
      name: "panel-zh",
      lang: "zh-CN",
      theme: "light",
      width: 390,
      height: 700,
      panel: "1",
    },
    {
      name: "short-en",
      lang: "en",
      theme: "dark",
      width: 620,
      height: 480,
      panel: "0",
    },
  ]) {
    const receipt = { ...options, states: [] };
    evidence.cases.push(receipt);
    const capture = async (name) => {
      await delay(150);
      const filename = `${options.name}-${name}.png`;
      const observation = await evaluate(measure);
      assert.equal(observation.overflow, false, "No horizontal overflow");
      receipt.states.push({ name, filename, observation });
      await screenshot(filename);
    };
    await send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", {
      url: `${url}/trigger-message.html?${new URLSearchParams({ lang: options.lang, theme: options.theme, panel: options.panel })}`,
    });
    await waitFor(
      "!!document.querySelector('.trigger-message-row .user-bubble')",
    );
    await evaluate("document.fonts.ready");
    assert.equal(
      await evaluate(
        "!!document.querySelector('.trigger-message-row .host-message-toggle')",
      ),
      false,
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.trigger-message-row .user-bubble').textContent.includes('[ZenX trigger wakeup]')",
      ),
      false,
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.trigger-message-row .message-actions').previousElementSibling.classList.contains('user-bubble')",
      ),
      true,
    );
    assert.equal(
      await evaluate(
        "(() => { const r=document.querySelector('.trigger-message-row .user-bubble').getBoundingClientRect(); return r.width>100 && r.height>100 && r.top<innerHeight && r.bottom>0; })()",
      ),
      true,
      "Message has visible nonzero layout",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.trigger-message-row time').dateTime === '2026-10-25T06:00:00.000Z'",
      ),
      true,
      "Protocol timestamps retain exact expected UTC instant",
    );
    await capture("01-message");
    await clickSelector(".trigger-message-row .message-source-link");
    await waitFor(
      "!!document.querySelector('.preview-source .trigger-editor')",
    );
    await capture("02-source");
    assert.equal(
      await evaluate(
        "window.__triggerPreview.calls.some(x=>!['list','threads','workspaces'].includes(x))",
      ),
      false,
    );
    receipt.status = "captured";
  }
  assert.equal(evidence.rendererErrors.length, 0, "No renderer exceptions.");
  assert.equal(evidence.externalRequests.length, 0, "No external requests.");
  assert.ok(
    evidence.cjkFonts.length > 0,
    "CI has no CJK-capable font. Chinese screenshots are not visual acceptance; no font installation was attempted.",
  );
  evidence.status = "passed";
  console.log(
    "Captured actual ThreadView and TriggersPanel EN/ZH desktop/panel observations.",
  );
} catch (error) {
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
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    for (
      let attempt = 0;
      attempt < 50 && child.exitCode === null && child.signalCode === null;
      attempt++
    )
      await delay(100);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  server?.close();
  await writeFile(
    path.join(directory, "measurements.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await writeFile(path.join(directory, "chrome.log"), stderr);
  if (profile)
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
}
