/** Uses the existing Ubuntu CI Chrome, never a user profile or downloaded browser. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { observePreviewChrome } from "./preview-browser-lifecycle.mjs";

assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "This capture runs only in GitHub Actions; open the HTML manually elsewhere.",
);
assert.equal(process.platform, "linux", "This fixture targets Ubuntu CI.");
const directory = path.resolve(
  process.argv[2] ?? ".foreground-activity-preview",
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = {
  scope:
    "Production foregroundActivityHtml renderer in its existing synthetic fixture: active/stopping, Chinese/English. Static browser screenshots only; not OS focus, native Stop-click, display-sleep/lock or termination evidence. Lifecycle semantics are separately tested with production classes and synthetic children; no user computer, real app, profile or paid API.",
  browserSandboxDisabled: false,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  cases: [],
  rendererErrors: [],
  externalRequests: [],
};

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

  assert.ok(
    evidence.cjkFonts.length > 0,
    "CJK fonts must be installed before foreground fixture capture",
  );

  const html = await readFile(path.join(directory, "foreground-activity.html"));
  server = createServer((req, res) => {
    if (
      new URL(req.url, "http://localhost").pathname !==
      "/foreground-activity.html"
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
  profile = await mkdtemp(
    path.join(tmpdir(), "zenx-foreground-activity-chrome-"),
  );
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
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(50);
    }
    throw new Error(`Fixture condition timed out: ${expression}`);
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  lifecycle.captureStarted();
  for (const view of [
    {
      name: "active-zh",
      language: "zh-CN",
      stopping: false,
      width: 1280,
      height: 800,
    },
    {
      name: "stopping-zh",
      language: "zh-CN",
      stopping: true,
      width: 1280,
      height: 800,
    },
    {
      name: "active-en-narrow",
      language: "en",
      stopping: false,
      width: 390,
      height: 640,
    },
    {
      name: "stopping-en-narrow",
      language: "en",
      stopping: true,
      width: 390,
      height: 640,
    },
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: view.width,
      height: view.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", {
      url: `${url}/foreground-activity.html?language=${view.language}&stopping=${view.stopping ? 1 : 0}`,
    });
    await waitFor(
      `location.search.includes('stopping=${view.stopping ? 1 : 0}') && document.querySelector('#status-preview')?.contentDocument?.querySelector('#status')?.dataset.stopping === '${view.stopping}'`,
    );
    await evaluate(
      `Promise.all([document.fonts.ready,document.querySelector('#status-preview').contentDocument.fonts.ready]).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))`,
    );
    const state = await evaluate(`(() => {
      const frame=document.querySelector('#status-preview');
      const doc=frame.contentDocument, button=doc.querySelector('#stop'), status=doc.querySelector('#status');
      return {label:status.textContent,disabled:button.disabled,stopping:status.dataset.stopping,sourceHash:document.querySelector('meta[name="zenx-preview-source-sha256"]').content};
    })()`);
    assert.equal(state.stopping, String(view.stopping));
    assert.equal(state.disabled, view.stopping);
    assert.match(state.sourceHash, /^[a-f0-9]{64}$/);
    await screenshot(`${view.name}.png`);
    evidence.cases.push({ ...view, ...state });
  }
  assert.deepEqual(evidence.rendererErrors, []);
  assert.deepEqual(evidence.externalRequests, []);
  evidence.status = "passed";
  lifecycle.captureFinished("passed");
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
      evidence.failureState = await evaluate(
        "({url:location.href,text:document.body.textContent})",
      );
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
