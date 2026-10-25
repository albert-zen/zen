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
const directory = path.resolve(process.argv[2] ?? ".whats-new-preview");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = {
  scope:
    "Actual Sidebar → WhatsNew and shared Dialog, bundled notes and theme. One synthetic Project/Thread; no live Host or private profile. Sidebar is held open by a scaffold: App-wide Escape and navigation integration are not exercised. Linux Chrome CDP keyboard/pointer input, not native Electron or physical OS acceptance.",
  browserSandboxDisabled: false,
  cases: [],
  rendererErrors: [],
  externalRequests: [],
};

const measure = `(() => {
  const rect = (e) => { if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
  const trigger=document.querySelector('.whats-new-trigger');
  const settings=document.querySelector('.settings-nav-row');
  const footer=document.querySelector('.sidebar-footer');
  const dialog=document.querySelector('.whats-new-dialog[data-state="open"]');
  const list=document.querySelector('.whats-new-list');
  const heading=dialog && document.getElementById(dialog.getAttribute('aria-labelledby'));
  return {
    trigger:rect(trigger), triggerText:trigger.textContent.trim(), triggerLabel:trigger.getAttribute('aria-label'), triggerTitle:trigger.title,
    settings:rect(settings), footer:rect(footer), footerRows:footer.children.length,
    siblingButtons:trigger.previousElementSibling===settings && trigger.parentElement.classList.contains('sidebar-settings-row'),
    nestedButtons:!!footer.querySelector('button button'), serviceDot:!!footer.querySelector('.service-status-dot'),
    expanded:trigger.getAttribute('aria-expanded'),
    footerOrder:[...document.querySelector('.sidebar-footer').children].map(e=>e.textContent.trim()),
    dialog:rect(dialog), role:dialog?.getAttribute('role'), title:heading?.textContent,
    list:rect(list), listClientHeight:list?.clientHeight, listScrollHeight:list?.scrollHeight,
    listClientWidth:list?.clientWidth, listScrollWidth:list?.scrollWidth,
    entries:[...document.querySelectorAll('.whats-new-list section')].map(e=>({date:e.querySelector('time').dateTime,items:[...e.querySelectorAll('li')].map(item=>item.textContent)})),
    focusInDialog:!!dialog?.contains(document.activeElement),
    focusOnTrigger:document.activeElement===trigger,
    focusedClass:document.activeElement?.className,
    pageOverflow:document.documentElement.scrollWidth>innerWidth,
    viewport:{width:innerWidth,height:innerHeight}
  };
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

  const html = await readFile(path.join(directory, "whats-new.html"));
  server = createServer((req, res) => {
    if (new URL(req.url, "http://localhost").pathname !== "/whats-new.html") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(path.join(tmpdir(), "zenx-whats-new-chrome-"));
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
  const open = async () => {
    await key("Enter", "Enter", 13);
    await waitFor(
      "!!document.querySelector('.whats-new-dialog[data-state=\"open\"]')",
    );
    await waitFor(
      "document.querySelector('.whats-new-dialog').contains(document.activeElement)",
    );
    await delay(200);
  };
  const closedWithFocus = async () => {
    await waitFor("!document.querySelector('.whats-new-dialog')");
    await waitFor(
      "document.activeElement===document.querySelector('.whats-new-trigger')",
    );
    assert.equal((await evaluate(measure)).expanded, "false");
  };
  await send("Page.enable");
  await send("Runtime.enable");
  lifecycle.captureStarted();
  await send("Network.enable");

  for (const options of [
    { name: "desktop-en", lang: "en", theme: "dark", width: 1100, height: 760 },
    { name: "narrow-en", lang: "en", theme: "light", width: 390, height: 640 },
    {
      name: "short-en",
      lang: "en",
      theme: "dark",
      width: 390,
      height: 320,
    },
    {
      name: "desktop-zh",
      lang: "zh-CN",
      theme: "light",
      width: 1100,
      height: 760,
    },
    {
      name: "narrow-zh",
      lang: "zh-CN",
      theme: "dark",
      width: 390,
      height: 640,
    },
  ]) {
    const receipt = { ...options, checks: [] };
    receipt.visualFontSupport =
      options.lang === "en" || evidence.cjkFonts.length > 0;
    const capture = (state) =>
      screenshot(
        `${options.name}${receipt.visualFontSupport ? "" : "-font-unverified"}-${state}.png`,
      );
    evidence.cases.push(receipt);
    await send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const destination = `${url}/whats-new.html?${new URLSearchParams({
      lang: options.lang,
      theme: options.theme,
    })}`;
    await send("Page.navigate", { url: destination });
    await waitFor(
      `location.href===${JSON.stringify(destination)} && document.body?.dataset.previewReady==='true'`,
    );
    await delay(250);
    receipt.initial = await evaluate(measure);
    assert.equal(receipt.initial.dialog, null, "Never opens automatically.");
    assert.equal(receipt.initial.expanded, "false");
    assert.equal(receipt.initial.siblingButtons, true);
    assert.equal(receipt.initial.footerRows, 1);
    assert.equal(receipt.initial.nestedButtons, false);
    assert.equal(receipt.initial.serviceDot, false);
    assert.equal(receipt.initial.triggerText, "");
    assert.equal(
      receipt.initial.triggerTitle,
      options.lang === "en" ? "What’s New" : "更新内容",
    );
    assert.equal(receipt.initial.triggerLabel, receipt.initial.triggerTitle);
    assert.equal(receipt.initial.settings.height, 34);
    assert.equal(receipt.initial.trigger.height, 34);
    assert.equal(receipt.initial.trigger.y, receipt.initial.settings.y);
    assert.equal(receipt.initial.footer.height, 50);
    assert.ok(receipt.initial.trigger.x >= receipt.initial.settings.right);
    assert.equal(receipt.initial.pageOverflow, false);
    assert.ok(receipt.initial.trigger.height >= 32, "Usable footer target.");
    receipt.checks.push(
      "closed-on-load",
      "single-unchanged-height-footer-row",
      "sibling-icon-after-settings",
      "no-service-dot",
      "localized-tooltip",
    );

    // Reach the actual entry with browser keyboard input, not element.focus().
    let tabCount = 0;
    while (!(await evaluate(measure)).focusOnTrigger && tabCount < 40) {
      await key("Tab", "Tab", 9);
      tabCount++;
    }
    assert.ok((await evaluate(measure)).focusOnTrigger, "Tab reaches entry.");
    // Traversing a Thread opens its information on focus. Allow the real
    // 180 ms blur-dismissal to settle; do not click away or remove its DOM.
    await waitFor("!document.querySelector('.thread-information')");
    assert.ok((await evaluate(measure)).focusOnTrigger, "Entry keeps focus.");
    receipt.tabCount = tabCount;
    receipt.checks.push("keyboard-reachable");
    await capture("entry");
    await open();
    receipt.open = await evaluate(measure);
    assert.equal(receipt.open.expanded, "true");
    assert.equal(receipt.open.role, "dialog");
    assert.equal(
      receipt.open.title,
      options.lang === "en" ? "What’s New" : "更新内容",
    );
    assert.equal(receipt.open.pageOverflow, false);
    assert.ok(receipt.open.entries.length > 0, "Bundled releases are visible.");
    assert.deepEqual(
      receipt.open.entries.map((entry) => entry.date),
      receipt.open.entries
        .map((entry) => entry.date)
        .sort()
        .reverse(),
      "Newest release first.",
    );
    assert.deepEqual(
      receipt.open.entries,
      await evaluate("window.__whatsNewPreview.expectedNotes"),
      "All release notes match the current bundled locale.",
    );
    const bounds = receipt.open.dialog;
    assert.ok(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.right <= options.width &&
        bounds.bottom <= options.height,
      "Dialog remains inside the viewport.",
    );
    assert.ok(
      receipt.open.listScrollWidth <= receipt.open.listClientWidth + 1,
      "Release-note content does not overflow horizontally.",
    );
    receipt.checks.push("enter-opens", "localized-content", "viewport-fit");
    await capture("open");

    // Both focusable elements (close and scrolling list) stay in the modal.
    for (let step = 0; step < 4; step++) {
      await key("Tab", "Tab", 9);
      assert.ok((await evaluate(measure)).focusInDialog, "Tab is contained.");
    }
    for (let step = 0; step < 3; step++) {
      await key("Tab", "Tab", 9, 8);
      assert.ok(
        (await evaluate(measure)).focusInDialog,
        "Shift+Tab is contained.",
      );
    }
    receipt.checks.push("forward-and-backward-focus-contained");
    if (options.name === "short-en") {
      assert.ok(
        receipt.open.listScrollHeight > receipt.open.listClientHeight,
        "The short viewport exercises a real scrolling list.",
      );
      for (let step = 0; step < 3; step++) {
        if (
          await evaluate(
            "document.activeElement===document.querySelector('.whats-new-list')",
          )
        )
          break;
        await key("Tab", "Tab", 9);
      }
      assert.ok(
        await evaluate(
          "document.activeElement===document.querySelector('.whats-new-list')",
        ),
        "The scrolling content is keyboard reachable.",
      );
      await key("PageDown", "PageDown", 34);
      await waitFor("document.querySelector('.whats-new-list').scrollTop>0");
      receipt.scrollTop = await evaluate(
        "document.querySelector('.whats-new-list').scrollTop",
      );
      await capture("scrolled");
      receipt.checks.push("keyboard-scrolls-release-list");
    }
    await key("Escape", "Escape", 27);
    await closedWithFocus();
    receipt.checks.push("escape-closes", "escape-restores-entry-focus");
    await capture("escape");

    await open();
    receipt.checks.push("keyboard-reopens");
    // Click the real overlay, outside the centered dialog.
    await click(5, 5);
    await closedWithFocus();
    receipt.checks.push("outside-click-closes", "outside-restores-entry-focus");

    await open();
    const close = await evaluate(`(() => {
      const r=document.querySelector('.whats-new-header button').getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    await click(close.x, close.y);
    await closedWithFocus();
    receipt.checks.push("close-button-closes", "button-restores-entry-focus");
    await open();
    await capture("reopened");
    receipt.checks.push("reopens-after-all-dismissals");
    await key("Escape", "Escape", 27);
    await closedWithFocus();

    await evaluate("delete document.body.dataset.previewReady");
    await send("Page.reload", { ignoreCache: true });
    await waitFor("document.body?.dataset.previewReady==='true'");
    assert.equal((await evaluate(measure)).dialog, null);
    receipt.checks.push("still-closed-after-reload");
    receipt.interactionStatus = "passed";
    receipt.status = receipt.visualFontSupport ? "passed" : "visual-blocked";
  }
  assert.equal(evidence.rendererErrors.length, 0, "No renderer exceptions.");
  assert.equal(evidence.externalRequests.length, 0, "No external requests.");
  assert.ok(
    evidence.cjkFonts.length > 0,
    "CI has no CJK-capable font. Chinese screenshots are not visual acceptance; no font installation was attempted.",
  );
  lifecycle.captureFinished("passed");
  evidence.status = "passed";
  console.log("Captured actual What's New EN/ZH desktop/narrow interactions.");
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
