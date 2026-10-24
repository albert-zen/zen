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
    // Production menu; only the fixture's catalog/picker/dispatch boundary is fake.
    const externalLabel =
      options.lang === "en" ? "Open file externally" : "在外部打开文件";
    const externalSelector = `${fileSelector} button[aria-label="${externalLabel}"]`;
    const clickMenu = async (label) => {
      const point = await evaluate(`(() => {
        const button=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(label)});
        if(!button || button.disabled) throw new Error('Unavailable menu action: '+${JSON.stringify(label)});
        button.scrollIntoView({block:'nearest'});
        const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`);
      await click(point.x, point.y);
      await delay(200);
    };
    await clickSelector(externalSelector);
    await waitFor(`!!document.querySelector('[role="menu"]')`);
    receipt.externalMenu = await evaluate(
      `(() => { const e=document.querySelector('[role="menu"]');const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,labels:[...e.querySelectorAll('strong')].map(x=>x.textContent)}; })()`,
    );
    check(
      receipt,
      "external-menu-bounded",
      receipt.externalMenu.x >= 0 &&
        receipt.externalMenu.y >= 0 &&
        receipt.externalMenu.right <= options.width &&
        receipt.externalMenu.bottom <= options.height,
    );
    await capture("external-open-menu");
    await key("Escape", "Escape", 27);
    await delay(250);
    check(
      receipt,
      "external-menu-escape-restores-focus",
      await evaluate(
        `document.activeElement?.getAttribute('aria-label')===${JSON.stringify(externalLabel)}`,
      ),
    );
    await key("ArrowDown", "ArrowDown", 40);
    await delay(200);
    await clickMenu(
      options.lang === "en"
        ? "Open in default application"
        : "使用默认应用打开",
    );
    await clickSelector(externalSelector);
    await clickMenu(
      options.lang === "en"
        ? "Choose application for Custom application…"
        : "选择 自定义应用 应用…",
    );
    await clickSelector(externalSelector);
    await capture("external-custom-configured");
    await clickMenu(
      options.lang === "en"
        ? "Open with Custom application"
        : "使用 自定义应用 打开",
    );
    receipt.externalCalls = await evaluate(
      "window.__fileSidebarPreview.externalCalls",
    );
    check(
      receipt,
      "external-default-and-custom-use-exact-local-file",
      receipt.externalCalls.filter((c) => c.operation === "synthetic-open")
        .length === 2 &&
        receipt.externalCalls
          .filter((c) => c.operation === "synthetic-open")
          .every(
            (c) =>
              c.host === "local" &&
              c.threadId === "synthetic-file-sidebar-thread" &&
              c.path === "src/long-source.ts",
          ) &&
        receipt.externalCalls.some(
          (c) =>
            c.operation === "synthetic-open" && c.application === "default",
        ) &&
        receipt.externalCalls.some(
          (c) => c.operation === "synthetic-open" && c.application === "custom",
        ),
    );
    check(
      receipt,
      "custom-application-picker-is-simulated",
      receipt.externalCalls.some(
        (c) => c.operation === "synthetic-picker" && c.id === "custom",
      ),
    );
    await evaluate(
      "window.__fileSidebarPreview.externalState.rejectRemote=true",
    );
    await clickSelector(externalSelector);
    await clickMenu(
      options.lang === "en"
        ? "Open in default application"
        : "使用默认应用打开",
    );
    check(
      receipt,
      "unsupported-remote-error-is-visible-without-fallback",
      await evaluate(
        `document.querySelector(${JSON.stringify(fileSelector)})?.textContent.includes('No local fallback was attempted.') && window.__fileSidebarPreview.externalCalls.filter(c=>c.operation==='synthetic-open').length===2`,
      ),
    );
    await capture("external-unsupported-remote-error");
    receipt.status = receipt.checks.every((check) => check.status === "passed")
      ? receipt.visualFontSupport
        ? "passed"
        : "visual-blocked"
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
  evidence.status = "passed";
  console.log(
    "Captured actual file sidebar EN/ZH desktop/narrow scrolling and tree scope.",
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
