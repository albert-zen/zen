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
const directory = path.resolve(process.argv[2] ?? ".file-sidebar-preview");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = {
  scope:
    "Actual AuxiliaryPanel, file tree, breadcrumb controls and CodeMirror source/Markdown editors. Synthetic memory-only files and scoped APIs; no Host or private profile. Linux Chrome CDP pointer/keyboard input, not native Electron or physical OS acceptance.",
  browserSandboxDisabled: false,
  cases: [],
  rendererErrors: [],
  externalRequests: [],
};

const measure = `(() => {
  const rect = (e) => { if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
  const box = (e) => e && ({...rect(e),clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,scrollTop:e.scrollTop,scrollLeft:e.scrollLeft,overflowX:getComputedStyle(e).overflowX,overflowY:getComputedStyle(e).overflowY});
  const active=document.querySelector('.auxiliary-content[role="tabpanel"]:not([hidden])');
  const editor=active?.querySelector('.cm-editor');
  const scroller=editor?.querySelector('.cm-scroller');
  const location=active?.querySelector('.file-location');
  const toggle=[...document.querySelectorAll('.workspace-navigation-toggle')].find(e=>e.getClientRects().length);
  const nav=document.querySelector('.workspace-file-navigation');
  return {
    activeId:active?.id,
    heading:rect(document.querySelector('.auxiliary-heading')),
    panel:box(document.querySelector('.auxiliary-panel')),
    body:box(document.querySelector('.auxiliary-body')),
    views:box(document.querySelector('.auxiliary-views')),
    active:box(active), location:rect(location), content:box(active?.querySelector('.file-content')),
    editor:box(editor), scroller:box(scroller),
    renderedText:editor?.textContent.slice(-500),
    treeVisible:!!nav?.getClientRects().length, tree:box(nav),
    toggle:rect(toggle), toggleInBreadcrumb:!!location?.contains(toggle),
    toggleInHeading:!!document.querySelector('.auxiliary-heading')?.contains(toggle),
    toggleCount:document.querySelectorAll('.workspace-navigation-toggle').length,
    togglePressed:toggle?.getAttribute('aria-pressed'), toggleLabel:toggle?.getAttribute('aria-label'),
    toggleTitle:toggle?.title, toggleControls:toggle?.getAttribute('aria-controls'),
    treeSelected:nav?.querySelector('[aria-selected="true"]')?.getAttribute('title'),
    treeText:nav?.textContent,
    page:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,scrollX,scrollY},
    viewport:{width:innerWidth,height:innerHeight},
    calls:window.__fileSidebarPreview?.calls,
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

  const html = await readFile(path.join(directory, "file-sidebar.html"));
  server = createServer((req, res) => {
    if (
      new URL(req.url, "http://localhost").pathname !== "/file-sidebar.html"
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
  profile = await mkdtemp(path.join(tmpdir(), "zenx-file-sidebar-chrome-"));
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
  const clickSelector = async (selector) => {
    const point = await evaluate(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)});
      if (!e) throw new Error('Missing pointer target: ' + ${JSON.stringify(selector)});
      const r=e.getBoundingClientRect();
      if (!r.width || !r.height) throw new Error('Hidden pointer target: ' + ${JSON.stringify(selector)});
      const x=r.x+r.width/2, y=r.y+r.height/2;
      const hit=document.elementFromPoint(x,y);
      if (!hit || !e.contains(hit)) throw new Error('Obscured pointer target: ' + ${JSON.stringify(selector)} + '; hit=' + (hit?.className ?? 'none'));
      return {x,y};
    })()`);
    await click(point.x, point.y);
    await delay(180);
  };
  const selectTab = async (id) => {
    // Use actual pointer + arrow-key navigation so overflowed tabs stay reachable.
    await clickSelector(
      '.auxiliary-heading [role="tab"][aria-selected="true"]',
    );
    for (let attempt = 0; attempt < 4; attempt++) {
      if (
        await evaluate(
          `document.querySelector('.auxiliary-heading [aria-selected="true"]')?.id===${JSON.stringify(`aux-tab-${id}`)}`,
        )
      )
        break;
      await key("ArrowRight", "ArrowRight", 39);
      await delay(120);
    }
    await waitFor(
      `document.querySelector('.auxiliary-content[role="tabpanel"]:not([hidden])')?.id===${JSON.stringify(`aux-content-${id}`)}`,
    );
    await delay(200);
  };
  const wheel = async (dx, dy) => {
    const { scroller: r } = await evaluate(measure);
    assert.ok(
      r && r.width > 0 && r.height > 0,
      "An actual editor wheel target exists.",
    );
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      deltaX: dx,
      deltaY: dy,
    });
    await delay(350);
  };
  const fileSelector = '.auxiliary-content[role="tabpanel"]:not([hidden])';
  const sourceId = "file:src/long-source.ts";
  const markdownId = "file:docs/long-notes.md";
  const failures = [];
  const check = (receipt, name, condition, detail) => {
    receipt.checks.push({
      name,
      status: condition ? "passed" : "failed",
      ...(condition ? {} : { detail }),
    });
    if (!condition)
      failures.push(`${receipt.name}: ${name}${detail ? ": " + detail : ""}`);
  };
  const bounded = (receipt, label, state) => {
    const s = state.scroller;
    check(
      receipt,
      `${label}:editor-bounded`,
      !!s &&
        s.height >= 60 &&
        s.y >= state.location.bottom - 1 &&
        s.bottom <= state.panel.bottom + 1 &&
        s.x >= state.panel.x - 1 &&
        s.right <= state.panel.right + 1,
      JSON.stringify({
        scroller: s,
        location: state.location,
        panel: state.panel,
      }),
    );
    check(
      receipt,
      `${label}:page-bounded`,
      state.page.width <= state.viewport.width &&
        state.page.height <= state.viewport.height &&
        state.page.scrollX === 0 &&
        state.page.scrollY === 0,
    );
    for (const name of ["panel", "body", "views", "active", "content"]) {
      const e = state[name];
      check(
        receipt,
        `${label}:${name}-does-not-own-scroll`,
        !!e &&
          e.scrollTop === 0 &&
          e.scrollLeft === 0 &&
          e.scrollHeight <= e.clientHeight + 2,
        JSON.stringify(e),
      );
    }
  };
  const near = (a, b) => Math.abs(a - b) <= 2;
  const toggleSelector = `${fileSelector} .workspace-navigation-toggle`;
  await send("Page.enable");
  await send("Runtime.enable");
  lifecycle.captureStarted();
  await send("Network.enable");
  for (const options of [
    { name: "desktop-en", lang: "en", theme: "dark", width: 1100, height: 760 },
    { name: "narrow-en", lang: "en", theme: "light", width: 390, height: 640 },
    { name: "short-en", lang: "en", theme: "dark", width: 390, height: 400 },
    {
      name: "desktop-zh",
      lang: "zh-CN",
      theme: "light",
      width: 1100,
      height: 760,
    },
  ]) {
    const receipt = { ...options, checks: [] };
    evidence.cases.push(receipt);
    receipt.visualFontSupport =
      options.lang === "en" || evidence.cjkFonts.length > 0;
    const capture = (state) =>
      screenshot(
        `${options.name}${receipt.visualFontSupport ? "" : "-font-unverified"}-${state}.png`,
      );
    await send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const destination = `${url}/file-sidebar.html?${new URLSearchParams({ lang: options.lang, theme: options.theme })}`;
    await send("Page.navigate", { url: destination });
    await waitFor(
      `location.href===${JSON.stringify(destination)} && document.body?.dataset.previewReady==='true' && document.querySelector('.auxiliary-content:not([hidden]) .cm-scroller')`,
    );
    await delay(350);
    receipt.initial = await evaluate(measure);
    await capture("source-start");
    check(
      receipt,
      "toggle-in-breadcrumb-not-tab-header",
      receipt.initial.toggleInBreadcrumb && !receipt.initial.toggleInHeading,
    );
    check(receipt, "one-shared-tree-toggle", receipt.initial.toggleCount === 1);
    check(
      receipt,
      "toggle-labelled-and-linked",
      !!receipt.initial.toggleLabel &&
        receipt.initial.toggleLabel === receipt.initial.toggleTitle &&
        receipt.initial.toggleControls === "workspace-file-navigation",
    );
    check(
      receipt,
      "tree-initially-visible",
      receipt.initial.treeVisible && receipt.initial.togglePressed === "true",
    );
    bounded(receipt, "source-start", receipt.initial);
    await wheel(0, 720);
    receipt.sourceScrolled = await evaluate(measure);
    check(
      receipt,
      "source-wheel-scrolls-editor",
      receipt.sourceScrolled.scroller.scrollTop > 100,
    );
    check(
      receipt,
      "source-wheel-keeps-breadcrumb-fixed",
      near(receipt.sourceScrolled.location.y, receipt.initial.location.y),
    );
    bounded(receipt, "source-wheel", receipt.sourceScrolled);
    await wheel(680, 0);
    receipt.sourceWide = await evaluate(measure);
    check(
      receipt,
      "wide-source-scrolls-horizontally",
      receipt.sourceWide.scroller.scrollLeft > 100 &&
        receipt.sourceWide.scroller.scrollWidth >
          receipt.sourceWide.scroller.clientWidth,
    );
    await capture("source-wide-scrolled");

    // Tab switching preserves both axes; hiding the tree is shared across file tabs.
    await selectTab(markdownId);
    await selectTab(sourceId);
    receipt.sourceRestored = await evaluate(measure);
    check(
      receipt,
      "source-tab-restores-both-scroll-axes",
      near(
        receipt.sourceRestored.scroller.scrollTop,
        receipt.sourceWide.scroller.scrollTop,
      ) &&
        near(
          receipt.sourceRestored.scroller.scrollLeft,
          receipt.sourceWide.scroller.scrollLeft,
        ),
    );
    await clickSelector(toggleSelector);
    receipt.sourceTreeHidden = await evaluate(measure);
    check(
      receipt,
      "tree-hides-from-breadcrumb",
      !receipt.sourceTreeHidden.treeVisible &&
        receipt.sourceTreeHidden.togglePressed === "false",
    );
    check(
      receipt,
      "source-toggle-retains-reading-position",
      near(
        receipt.sourceTreeHidden.scroller.scrollTop,
        receipt.sourceWide.scroller.scrollTop,
      ),
    );
    bounded(receipt, "source-tree-hidden", receipt.sourceTreeHidden);
    await capture("source-tree-hidden");
    await selectTab(markdownId);
    receipt.markdownStart = await evaluate(measure);
    check(
      receipt,
      "hidden-tree-scope-shared-across-files",
      !receipt.markdownStart.treeVisible &&
        receipt.markdownStart.togglePressed === "false",
    );
    check(
      receipt,
      "markdown-toggle-in-breadcrumb",
      receipt.markdownStart.toggleInBreadcrumb &&
        receipt.markdownStart.toggleCount === 1,
    );
    bounded(receipt, "markdown-start", receipt.markdownStart);
    await wheel(0, 900);
    receipt.markdownScrolled = await evaluate(measure);
    check(
      receipt,
      "markdown-wheel-scrolls-editor",
      receipt.markdownScrolled.scroller.scrollTop > 100,
    );
    check(
      receipt,
      "markdown-wheel-keeps-breadcrumb-fixed",
      near(
        receipt.markdownScrolled.location.y,
        receipt.markdownStart.location.y,
      ),
    );
    bounded(receipt, "markdown-wheel", receipt.markdownScrolled);
    await capture("markdown-scrolled");
    await selectTab(sourceId);
    await selectTab(markdownId);
    receipt.markdownRestored = await evaluate(measure);
    check(
      receipt,
      "markdown-tab-restores-reading-position",
      near(
        receipt.markdownRestored.scroller.scrollTop,
        receipt.markdownScrolled.scroller.scrollTop,
      ),
    );
    await clickSelector(toggleSelector);
    await clickSelector(toggleSelector);
    receipt.markdownToggleRestored = await evaluate(measure);
    check(
      receipt,
      "markdown-toggle-roundtrip-retains-position",
      near(
        receipt.markdownToggleRestored.scroller.scrollTop,
        receipt.markdownRestored.scroller.scrollTop,
      ),
    );

    // Keyboard navigation must reach the actual final lines, not a clipped parent.
    await clickSelector(`${fileSelector} .cm-scroller`);
    await key("End", "End", 35, 2);
    await delay(400);
    receipt.markdownEnd = await evaluate(measure);
    check(
      receipt,
      "keyboard-reaches-markdown-end",
      receipt.markdownEnd.renderedText.includes("LAST_MARKDOWN_SECTION") &&
        receipt.markdownEnd.scroller.scrollTop >
          receipt.markdownScrolled.scroller.scrollTop,
    );
    bounded(receipt, "markdown-end", receipt.markdownEnd);
    await capture("markdown-end");
    await selectTab("custom:overview");
    receipt.nonFile = await evaluate(measure);
    check(
      receipt,
      "non-file-tab-has-no-tree-or-toggle",
      !receipt.nonFile.treeVisible && receipt.nonFile.toggleCount === 0,
    );
    await capture("non-file-tab");
    await selectTab(sourceId);
    check(
      receipt,
      "file-tree-state-survives-non-file-tab",
      !(await evaluate(measure)).treeVisible,
    );
    await clickSelector(toggleSelector);
    receipt.sourceTreeRestored = await evaluate(measure);
    check(
      receipt,
      "source-tree-roundtrip-restores-position",
      near(
        receipt.sourceTreeRestored.scroller.scrollTop,
        receipt.sourceWide.scroller.scrollTop,
      ) &&
        near(
          receipt.sourceTreeRestored.scroller.scrollLeft,
          receipt.sourceWide.scroller.scrollLeft,
        ),
    );
    await clickSelector(`${fileSelector} .cm-scroller`);
    await key("End", "End", 35, 2);
    await delay(400);
    receipt.sourceEnd = await evaluate(measure);
    check(
      receipt,
      "keyboard-reaches-source-end",
      receipt.sourceEnd.renderedText.includes("LAST_SOURCE_LINE") &&
        receipt.sourceEnd.scroller.scrollTop >
          receipt.sourceWide.scroller.scrollTop,
    );
    bounded(receipt, "source-end", receipt.sourceEnd);
    await capture("source-end");
    check(
      receipt,
      "all-file-reads-stay-in-synthetic-thread",
      receipt.sourceEnd.calls.every(
        (call) => call.threadId === "synthetic-file-sidebar-thread",
      ),
    );
    receipt.status = receipt.checks.every((check) => check.status === "passed")
      ? receipt.visualFontSupport
        ? "passed"
        : "visual-blocked"
      : "failed";
  }

  for (const lang of ["en", "zh-CN"]) {
    const receipt = { name: `local-paths-${lang}`, checks: [] };
    evidence.cases.push(receipt);
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const destination = `${url}/file-sidebar.html?${new URLSearchParams({ lang, theme: lang === "en" ? "dark" : "light", links: "true" })}`;
    await send("Page.navigate", { url: destination });
    await waitFor(
      `location.href===${JSON.stringify(destination)} && document.body?.dataset.previewReady==='true' && document.querySelector('[data-local-path-preview] a')`,
    );
    await screenshot(`local-paths-${lang}-before.png`);
    check(
      receipt,
      "links-use-existing-file-flow",
      await evaluate(
        `document.querySelectorAll('[data-local-path-preview] a').length===5`,
      ),
    );
    const before = await evaluate(`window.__fileSidebarPreview.calls.length`);
    await delay(250);
    check(
      receipt,
      "render-does-not-read-files",
      await evaluate(`window.__fileSidebarPreview.calls.length===${before}`),
    );
    const webSelector =
      '[data-local-path-preview] a[href^="http://127.0.0.1:"]';
    check(
      receipt,
      "inline-web-link-retains-code-style",
      await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(webSelector)})?.querySelector('code'))`,
      ),
    );
    await clickSelector(webSelector);
    check(
      receipt,
      "inline-web-pointer-routes-exactly-once",
      await evaluate(
        `window.__fileSidebarPreview.calls.filter(c=>c.method==='browser').length===1`,
      ),
    );
    await evaluate(
      `document.querySelector(${JSON.stringify(webSelector)}).focus()`,
    );
    await key("Enter", "Enter", 13);
    check(
      receipt,
      "inline-web-pointer-and-keyboard-route-once-each",
      await evaluate(
        `window.__fileSidebarPreview.calls.filter(c=>c.method==='browser').length===2 && window.__fileSidebarPreview.calls.filter(c=>c.method==='browser').every(c=>c.threadId==='synthetic-file-sidebar-thread' && c.path==='http://127.0.0.1:40123/review?q=one#details')`,
      ),
    );
    await screenshot(`inline-web-links-${lang}-activated.png`);
    await clickSelector("[data-local-path-preview] a");
    await waitFor(
      `document.querySelector('.auxiliary-content:not([hidden]) .cm-editor') && document.querySelector('.auxiliary-content:not([hidden])')?.id.includes('long-notes')`,
    );
    receipt.after = await evaluate(measure);
    await screenshot(`local-paths-${lang}-opened.png`);
    check(
      receipt,
      "click-opens-requested-markdown-file",
      receipt.after.activeId.includes("long-notes"),
    );
    check(
      receipt,
      "same-thread-file-ownership",
      receipt.after.calls.every(
        (call) => call.threadId === "synthetic-file-sidebar-thread",
      ),
    );
    await clickSelector(
      "[data-local-path-preview] .markdown-code-actions button",
    );
    await waitFor(
      `document.querySelector('.auxiliary-content:not([hidden])')?.id.includes('long-source')`,
    );
    check(
      receipt,
      "text-path-action-opens-requested-file",
      await evaluate(
        `document.querySelector('.auxiliary-content:not([hidden])')?.id.includes('long-source')`,
      ),
    );
    check(
      receipt,
      "text-path-copy-remains-separate",
      await evaluate(
        `document.querySelectorAll('[data-local-path-preview] .markdown-code-actions button').length===2 && document.querySelector('[data-local-path-preview] pre code').textContent==='/synthetic/file-sidebar-preview/src/long-source.ts'`,
      ),
    );
    await screenshot(`local-paths-${lang}-text-block-opened.png`);
    receipt.status = receipt.checks.every((check) => check.status === "passed")
      ? "passed"
      : "failed";
  }
  // Diagnostic-only matrix: real components, no production-style overrides.
  // Darwin is a renderer marker; this remains Linux Chromium, not macOS acceptance.
  for (const targetWidth of [256, 384]) {
    const receipt = {
      name: `tree-open-cjk-${targetWidth}`,
      checks: [],
      platformScope: "darwin renderer marker on Linux Chrome",
    };
    evidence.cases.push(receipt);
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const destination = `${url}/file-sidebar.html?lang=zh-CN&theme=light&diagnostic=true`;
    await send("Page.navigate", { url: destination });
    await waitFor(
      `location.href===${JSON.stringify(destination)} && document.body?.dataset.previewReady==='true' && document.querySelector('.auxiliary-content:not([hidden]) .cm-scroller')`,
    );
    const titlebarLayout = `(() => {
      const bar=document.querySelector('.window-titlebar');
      const session=document.querySelector('.window-titlebar-session');
      const panel=document.querySelector('.auxiliary-panel');
      const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};};
      return {bar:rect(bar),session:rect(session),panel:rect(panel),workspaceWidth:getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--workspace-panel-width'),transitionDuration:getComputedStyle(bar).transitionDuration};
    })()`;
    receipt.titlebarBeforeReady = await evaluate(titlebarLayout);
    // Wait for actual layout animation settlement, retaining pointer hit tests.
    await waitFor(`(() => {
      const bar=document.querySelector('.window-titlebar').getBoundingClientRect();
      const panel=document.querySelector('.auxiliary-panel').getBoundingClientRect();
      const session=document.querySelector('.window-titlebar-session').getBoundingClientRect();
      const width=parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--workspace-panel-width'));
      const last=window.__fileTitlebarReady;
      const stable=bar.right<=panel.left+1 && session.right<=panel.left+1 && Math.abs(width-panel.width)<=1 && last && Math.abs(last.right-bar.right)<0.5;
      window.__fileTitlebarReady={right:bar.right,count:stable?last.count+1:0};
      return window.__fileTitlebarReady.count>=3;
    })()`);
    receipt.titlebarAfterReady = await evaluate(titlebarLayout);
    await selectTab(markdownId);
    // Resize through the actual public separator, never mutate CSS or scrollTop.
    await clickSelector(".auxiliary-panel > .browser-panel-resizer");
    for (let i = 0; i < 4; i++) await key("ArrowLeft", "ArrowLeft", 37);
    await delay(250);
    const initial = await evaluate(measure);
    const separator = await evaluate(
      `(() => { const r=document.querySelector('.workspace-file-resizer').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    );
    const destinationX = separator.x + initial.scroller.width - targetWidth;
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...separator,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...separator,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: destinationX,
      y: separator.y,
      button: "left",
      buttons: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: destinationX,
      y: separator.y,
      button: "left",
      clickCount: 1,
    });
    await delay(350);
    await evaluate(`(() => {
      window.__fileWheelDiagnostics=[];
      document.addEventListener('wheel', event => {
        const entry={target:event.target?.className, deltaX:event.deltaX, deltaY:event.deltaY, defaultPreventedAtCapture:event.defaultPrevented, path:event.composedPath().filter(e=>e instanceof Element).map(e=>e.tagName+'.'+e.className)};
        window.__fileWheelDiagnostics.push(entry);
        setTimeout(()=>{entry.defaultPreventedAfterDispatch=event.defaultPrevented;}, 0);
      }, {capture:true, passive:true});
    })()`);
    const diagnostics = `(() => {
      const active=document.querySelector('.auxiliary-content[role="tabpanel"]:not([hidden])');
      const scroller=active.querySelector('.cm-scroller');
      const rect=scroller.getBoundingClientRect();
      const styles=e=>{const s=getComputedStyle(e);return {tag:e.tagName,className:e.className,focusVisible:e.matches(':focus-visible'),outline:s.outline,border:s.border,overflowX:s.overflowX,overflowY:s.overflowY,width:s.width,height:s.height,minWidth:s.minWidth,minHeight:s.minHeight,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,scrollTop:e.scrollTop};};
      const chain=[];for(let e=scroller;e;e=e.parentElement)chain.push(styles(e));
      return {activeElement:document.activeElement?.outerHTML.slice(0,500),chain,editorNodes:[...active.querySelectorAll('.markdown-live-editor,.cm-editor,.cm-scroller,.cm-content')].map(styles),hitStack:document.elementsFromPoint(rect.x+rect.width/2,rect.y+rect.height/2).map(e=>e.tagName+'.'+e.className),wheelEvents:window.__fileWheelDiagnostics};
    })()`;
    receipt.before = await evaluate(measure);
    receipt.beforeDiagnostics = await evaluate(diagnostics);
    check(
      receipt,
      "tree-remains-open",
      receipt.before.treeVisible && receipt.before.togglePressed === "true",
    );
    check(
      receipt,
      "requested-content-width",
      Math.abs(receipt.before.scroller.width - targetWidth) <= 3,
      JSON.stringify(receipt.before.scroller),
    );
    bounded(receipt, "before", receipt.before);
    await screenshot(`${receipt.name}-before.png`);
    await wheel(0, 720);
    receipt.unfocusedWheel = await evaluate(measure);
    receipt.unfocusedDiagnostics = await evaluate(diagnostics);
    check(
      receipt,
      "wheel-before-editor-focus",
      receipt.unfocusedWheel.scroller.scrollTop >
        receipt.before.scroller.scrollTop + 100,
    );
    await clickSelector(`${fileSelector} .cm-scroller`);
    receipt.focusedDiagnostics = await evaluate(diagnostics);
    await screenshot(`${receipt.name}-focused.png`);
    await wheel(0, 720);
    receipt.focusedWheel = await evaluate(measure);
    receipt.focusedWheelDiagnostics = await evaluate(diagnostics);
    check(
      receipt,
      "wheel-after-editor-focus",
      receipt.focusedWheel.scroller.scrollTop >
        receipt.unfocusedWheel.scroller.scrollTop + 100,
    );
    bounded(receipt, "after-wheel", receipt.focusedWheel);
    await screenshot(`${receipt.name}-scrolled.png`);
    // CodeMirror sees the actual Linux browser platform, so use Ctrl+End.
    await key("End", "End", 35, 2);
    await delay(400);
    receipt.end = await evaluate(measure);
    receipt.endDiagnostics = await evaluate(diagnostics);
    check(
      receipt,
      "keyboard-reaches-end",
      receipt.end.renderedText.includes("LAST_MARKDOWN_SECTION") &&
        receipt.end.scroller.scrollTop >
          receipt.focusedWheel.scroller.scrollTop,
    );
    check(receipt, "tree-still-open-after-navigation", receipt.end.treeVisible);
    bounded(receipt, "end", receipt.end);
    await screenshot(`${receipt.name}-end.png`);
    receipt.status = receipt.checks.every((check) => check.status === "passed")
      ? "passed"
      : "failed";
  }
  evidence.failures = failures;
  assert.equal(evidence.rendererErrors.length, 0, "No renderer exceptions.");
  assert.equal(evidence.externalRequests.length, 0, "No external requests.");
  assert.ok(
    evidence.cjkFonts.length > 0,
    "CI has no CJK font; Chinese screenshots cannot pass acceptance.",
  );
  assert.deepEqual(
    failures,
    [],
    "Actual file viewport interactions must pass.",
  );
  lifecycle.captureFinished("passed");
  evidence.status = "passed";
  console.log(
    "Captured actual file sidebar EN/ZH desktop/narrow scrolling and tree scope.",
  );
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
