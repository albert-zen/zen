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
const directory = path.resolve(process.argv[2] ?? ".settings-audit-preview");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = {
  scope:
    "Actual production SettingsView; synthetic providers/catalog only. No Host, credentials, private settings, live provider, mutations or persistence. Settings scaffold, not full App/onboarding/native Electron. Observations are not desired-UX assertions.",
  browserSandboxDisabled: false,
  cases: [],
  rendererErrors: [],
  externalRequests: [],
};

const measure = `(() => {
  const rect = e => { if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
  const editor=document.querySelector('.provider-editor');
  const scroll=document.querySelector('.page-scroll');
  const active=document.activeElement;
  return {viewport:{width:innerWidth,height:innerHeight}, editor:rect(editor), editorRole:editor?.getAttribute('role'), focusInEditor:!!editor?.contains(active), focus:{tag:active?.tagName,text:active?.textContent?.slice(0,120),label:active?.getAttribute('aria-label'),id:active?.id},
    scroll:{top:scroll?.scrollTop,height:scroll?.clientHeight,total:scroll?.scrollHeight},
    providerCards:document.querySelectorAll('.provider-profile-card').length, modelRows:document.querySelectorAll('.provider-model-row').length,
    save:rect(document.querySelector('.provider-editor-actions [type="submit"]')),
    discovery:rect(document.querySelector('.available-model-picker')),
    errorSummary:document.querySelector('.provider-editor-error-summary')?.textContent,
    capabilitySummaries:[...document.querySelectorAll('.provider-model-capabilities summary')].map(e=>e.textContent),
    dialogs:document.querySelectorAll('[role="dialog"]').length,
    overflow:document.documentElement.scrollWidth>innerWidth,
    calls:window.__settingsAudit.calls,
  };
})()`;

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

  const html = await readFile(path.join(directory, "settings-audit.html"));
  server = createServer((req, res) => {
    if (
      new URL(req.url, "http://localhost").pathname !== "/settings-audit.html"
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
  profile = await mkdtemp(path.join(tmpdir(), "zenx-settings-audit-chrome-"));
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
      `(() => { const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:e.disabled}; })()`,
    );
    assert.ok(target && !target.disabled, `Available target: ${selector}`);
    await click(target.x, target.y);
    await delay(120);
  };
  for (const options of [
    { name: "desktop-en", lang: "en", theme: "dark", width: 1100, height: 760 },
    {
      name: "narrow-zh",
      lang: "zh-CN",
      theme: "light",
      width: 390,
      height: 640,
    },
  ]) {
    const receipt = { ...options, states: [] };
    evidence.cases.push(receipt);
    const capture = async (name) => {
      await delay(150);
      const filename = `${options.name}-${name}.png`;
      receipt.states.push({
        name,
        filename,
        observation: await evaluate(measure),
      });
      await screenshot(filename);
    };
    await send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const navigate = async (initialFailure = false) => {
      const destination = `${url}/settings-audit.html?${new URLSearchParams({ lang: options.lang, theme: options.theme, initialFailure: initialFailure ? "1" : "0" })}`;
      await send("Page.navigate", { url: destination });
      await waitFor(
        `location.href===${JSON.stringify(destination)} && ${initialFailure ? "!!document.querySelector('.page-loading [role=alert]')" : "document.querySelectorAll('.provider-profile-card').length===4"}`,
      );
      await evaluate("document.fonts.ready");
    };
    await navigate(true);
    assert.equal(
      await evaluate("!!document.querySelector('.loading-ring')"),
      false,
      "Settled failure stops loading",
    );
    await capture("00-initial-load-failure");
    await clickSelector(".page-loading button");
    await waitFor(
      "document.querySelectorAll('.provider-profile-card').length===4",
    );
    assert.equal(
      await evaluate(
        "window.__settingsAudit.calls.filter(x=>x==='settings-get').length",
      ),
      2,
      "One explicit retry, no loop",
    );
    await waitFor(
      `document.querySelector('.settings-view')?.textContent.includes(${JSON.stringify(options.lang === "zh-CN" ? "模型与服务商" : "Models & providers")})`,
    );
    await capture("00b-explicit-retry-success");
    await capture("01-models-overview");
    await clickSelector(".provider-profile-actions button:first-child", 3);
    await waitFor(
      "document.querySelectorAll('.provider-model-row').length===12",
    );
    await capture("02-edit-from-last-provider");
    await evaluate(
      `(() => { const name = document.querySelector('.provider-editor input[id$="-displayName"]'); name.focus(); name.select(); })()`,
    );
    await send("Input.insertText", { text: "Synthetic unsaved provider" });
    await waitFor(
      `document.querySelector('.provider-editor input[id$="-displayName"]').value === "Synthetic unsaved provider"`,
    );
    receipt.editorIsolation = await evaluate(`(() => {
      const editor = document.querySelector('.provider-editor');
      const name = editor.querySelector('input[id$="-displayName"]');
      const before = name.value;
      const actions = [...document.querySelectorAll('.provider-profile-actions button')];
      actions.forEach(button => button.click());
      return {allDisabled: actions.every(button => button.disabled), allExplained: actions.every(button => !!document.getElementById(button.getAttribute('aria-describedby'))?.textContent), sameEditor: document.querySelector('.provider-editor') === editor, namePreserved: name.value === before};
    })()`);
    assert.deepEqual(receipt.editorIsolation, {
      allDisabled: true,
      allExplained: true,
      sameEditor: true,
      namePreserved: true,
    });
    await capture("02c-preserved-provider-draft");
    await key("Tab", "Tab", 9);
    receipt.keyboardForward = await evaluate(measure);
    await key("Tab", "Tab", 9, 8);
    receipt.keyboardBackward = await evaluate(measure);
    await key("Escape", "Escape", 27);
    await capture("02b-keyboard-escape-observation");
    await evaluate(
      "document.querySelector('.provider-editor').scrollIntoView({block:'start'})",
    );
    await capture("03-editor-top");
    await clickSelector(".provider-model-capabilities summary", 0);
    await capture("04-model-capabilities");
    await clickSelector(".model-catalog-head button");
    await waitFor(
      "document.querySelectorAll('.available-model-option').length===2",
    );
    await capture("05-discovery");
    await clickSelector(".available-model-option input", 1);
    await clickSelector(".available-model-actions .primary-button");
    await waitFor(
      "document.querySelectorAll('.provider-model-row').length===13",
    );
    await clickSelector('.provider-editor-actions [type="submit"]');
    await waitFor("!!document.querySelector('.provider-editor-error-summary')");
    await capture("06-unknown-context-validation");
    await clickSelector(".provider-editor-error-summary a");
    await capture("07-validation-field");
    await clickSelector(".provider-editor-head button");
    await waitFor("!document.querySelector('.provider-editor')");
    await capture("08-cancel-focus");
    assert.equal(
      await evaluate(
        "document.activeElement === document.querySelectorAll('.provider-profile-actions button:first-child')[3]",
      ),
      true,
      "Cancel returns focus to originating provider Edit",
    );
    // Fresh page avoids attributing prior synthetic edits to the add flow.
    await navigate();
    await clickSelector(".provider-section-actions .primary-button");
    await waitFor("!!document.querySelector('.provider-editor')");
    await capture("09-new-provider");
    await clickSelector('.provider-editor-actions [type="submit"]');
    await waitFor("!!document.querySelector('.provider-editor-error-summary')");
    await capture("10-new-provider-validation");
    receipt.status = "captured";
  }
  assert.equal(evidence.rendererErrors.length, 0, "No renderer exceptions.");
  assert.equal(evidence.externalRequests.length, 0, "No external requests.");
  assert.ok(
    evidence.cjkFonts.length > 0,
    "CI has no CJK-capable font. Chinese screenshots are not visual acceptance; no font installation was attempted.",
  );
  evidence.status = "passed";
  console.log("Captured actual Settings EN/ZH desktop/narrow observations.");
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
