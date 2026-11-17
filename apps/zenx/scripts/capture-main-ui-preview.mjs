import { sidebarIdentityCase } from "./sidebar-identity-cases.mjs";
import { fontProbeHTML, probePreviewFonts } from "./preview-font-probe.mjs";
import { fontRevision, fontAssets } from "./prepare-preview-fonts.mjs";
import {
  captureDesktopReading,
  captureReadingReentry,
} from "./reading-main-ui-preview.mjs";
import { captureQueueReading } from "./queue-reading-main-ui-preview.mjs";
import { captureInlineTrace } from "./inline-trace-main-ui-preview.mjs";
/** One sandboxed Chrome, bounded scenes; no aggregate CI dependency or browser download. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { observePreviewChrome } from "./preview-browser-lifecycle.mjs";
import {
  captureDesktopNavigation,
  captureChildSidebar,
  captureChildNavigation,
  captureBusyChild,
} from "./navigation-main-ui-preview.mjs";

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
const captureProfile = process.argv[3] ?? "fine";
const ordinaryTitles = process.env.ZENX_SIDEBAR_ORDINARY_TITLES === "1";
assert(
  !ordinaryTitles || captureProfile === "fine",
  "Ordinary title probe uses existing fine navigation capture",
);
const desktopQueue = captureProfile === "desktop-queue";
const desktopResultFile = captureProfile === "desktop-reading-result-file";
let desktopReading = captureProfile === "desktop-reading";
if (desktopResultFile) desktopReading = true;
const desktopRoom = captureProfile === "desktop-room";
const desktopReentry = captureProfile === "desktop-reading-reentry";
const desktopNested = captureProfile === "desktop-reading-nested-output";
const desktopChildSidebar = captureProfile === "desktop-child-sidebar";
const desktopChildNavigation = captureProfile === "desktop-child-navigation";
const desktopBusyChild = captureProfile === "desktop-busy-child";
const desktopCombinedAttention =
  captureProfile === "desktop-combined-attention";
const identityCaseName = process.env.ZENX_SIDEBAR_IDENTITY_CASE;
assert(
  !identityCaseName || desktopCombinedAttention,
  "Identity cases require existing exact-head combined profile",
);
const identityCase = identityCaseName
  ? sidebarIdentityCase(identityCaseName)
  : null;
const combinedAttentionCapture = desktopCombinedAttention
  ? (await import("./navigation-main-ui-preview.mjs")).captureCombinedAttention
  : null;
if (desktopCombinedAttention)
  assert.equal(
    typeof combinedAttentionCapture,
    "function",
    "Combined capture helper required",
  );
// Older profiles must not load this separately scoped receipt/capture helper.
const roomCapture = desktopRoom
  ? await import("./room-file-owner-main-ui-preview.mjs")
  : null;
const desktopOnly = desktopQueue || desktopReading;
const otherPointer =
  desktopRoom ||
  desktopReentry ||
  desktopNested ||
  desktopChildSidebar ||
  desktopChildNavigation ||
  desktopBusyChild ||
  desktopCombinedAttention
    ? "fine"
    : captureProfile;
const pointer = desktopOnly ? "fine" : otherPointer;
assert(["fine", "coarse"].includes(pointer), "Pointer must be fine or coarse");
const coarse = pointer === "coarse";
const evidenceFile = coarse ? "evidence-coarse.json" : "evidence.json";
const diagnosticsDirectory = coarse
  ? path.join(directory, "coarse")
  : directory;
await mkdir(diagnosticsDirectory, { recursive: true });
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
if (desktopResultFile) {
  const { verifyResultFileSource } =
    await import("./result-file-main-ui-preview.mjs");
  verifyResultFileSource(
    source,
    process.env.ZENX_RESULT_FILE_EXPECTED_HEAD,
    execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim() === "",
  );
}
if (desktopRoom || source.scenes?.room) {
  assert(
    desktopRoom,
    "A Room bundle requires the desktop-room profile before loading",
  );
  roomCapture.assertRoomReceipt(source, process.env.ZENX_ROOM_EXPECTED_HEAD);
}
for (const [file, expected] of Object.entries(source.sources))
  assert.equal(
    hash(await readFile(path.join(root, file))),
    expected,
    `Rebuild changed source: ${file}`,
  );
if (coarse)
  assert(source.scenes.pending, "Coarse capture requires the pending bundle");
if (desktopRoom) {
  assert.equal(
    source.commit,
    process.env.ZENX_ROOM_EXPECTED_HEAD,
    "Room capture is bound to the fixed PR head",
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    source.tree,
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "",
    "Room capture requires a clean checkout",
  );
  assert.equal(source.clean, true);
  assert.deepEqual(Object.keys(source.scenes), ["room"]);
}
if (
  desktopReentry ||
  desktopNested ||
  desktopChildSidebar ||
  desktopChildNavigation ||
  desktopBusyChild ||
  desktopCombinedAttention
) {
  assert.equal(
    source.commit,
    desktopCombinedAttention
      ? process.env.ZENX_COMBINED_ATTENTION_EXPECTED_HEAD
      : desktopBusyChild
        ? process.env.ZENX_BUSY_CHILD_EXPECTED_HEAD
        : desktopChildNavigation
          ? process.env.ZENX_CHILD_NAVIGATION_EXPECTED_HEAD
          : desktopChildSidebar
            ? process.env.ZENX_CHILD_SIDEBAR_EXPECTED_HEAD
            : desktopNested
              ? process.env.ZENX_NESTED_EXPECTED_HEAD
              : process.env.ZENX_REENTRY_EXPECTED_HEAD,
    "Re-entry uses the exact event head",
  );
  const originalScene = desktopChildSidebar ? "navigation" : "reading";
  const isolatedScene =
    desktopChildNavigation || desktopBusyChild || desktopCombinedAttention
      ? "navigation"
      : originalScene;
  assert.deepEqual(Object.keys(source.scenes), [isolatedScene]);
  assert.equal(source.scenes[isolatedScene].html, `${isolatedScene}.html`);
  assert.deepEqual(
    source.dirtyFiles,
    [],
    "Re-entry requires a clean source receipt",
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "",
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    source.tree,
  );
}
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
if (desktopReading || desktopRoom || desktopReentry || desktopNested)
  files.set("/font-probe.html", Buffer.from(fontProbeHTML));
// Main fixture only: this is a blank-paint guard, not OCR or general visual acceptance.
function inspectMainReplyPixels(data, width, height, rect) {
  const x0 = Math.ceil(rect.x),
    y0 = Math.ceil(rect.y);
  const x1 = Math.floor(rect.right),
    y1 = Math.floor(rect.bottom);
  if (x0 < 0 || y0 < 0 || x1 > width || y1 > height || x1 <= x0 || y1 <= y0)
    return { passed: false, reason: "reply-pixel-region-outside-image" };
  let min = 255,
    max = 0,
    edges = 0;
  for (let y = y0; y < y1; y++) {
    let previous;
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const value = (data[i] + data[i + 1] + data[i + 2]) / 3;
      min = Math.min(min, value);
      max = Math.max(max, value);
      if (previous !== undefined && Math.abs(value - previous) >= 24) edges++;
      previous = value;
    }
  }
  return {
    passed: max - min >= 48 && edges >= 20,
    min,
    max,
    edges,
    region: { x0, y0, x1, y1 },
  };
}
const mainReplyProbe = `(() => {
  const expected="已检查工作区。你可以在右侧阅读和编辑计划，同时保留当前对话。";
  const matches=[...document.querySelectorAll('.thread-view .agent-copy p')].filter(e=>e.textContent.trim()===expected);
  const describe=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,classes:[...e.classList].slice(0,6),rect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},display:s.display,visibility:s.visibility,opacity:s.opacity,overflowX:s.overflowX,overflowY:s.overflowY,scrollTop:e.scrollTop,scrollLeft:e.scrollLeft};};
  const e=matches.length===1?matches[0]:null;
  const ancestors=[];for(let p=e;p&&ancestors.length<12;p=p.parentElement)ancestors.push(describe(p));
  const r=e?.getBoundingClientRect();
  const hidden=ancestors.some(a=>a.display==='none'||a.visibility!=='visible'||Number(a.opacity)===0);
  const clipped=!!r&&ancestors.slice(1).some(a=>((['hidden','clip','scroll','auto'].includes(a.overflowY))&&(r.y<a.rect.y-1||r.bottom>a.rect.bottom+1))||((['hidden','clip','scroll','auto'].includes(a.overflowX))&&(r.x<a.rect.x-1||r.right>a.rect.right+1)));
  return {expected,count:matches.length,rect:r?describe(e).rect:null,ancestors,passed:!!r&&r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&!hidden&&!clipped};
})()`;
// End main fixture blank-paint helpers.

const evidence = {
  schemaVersion: 1,
  source,
  scope:
    "Fast production-component rendering only. All content and services are synthetic. Not native Electron, OS capture, live Host, end-to-end acceptance or a full regression run.",
  pointer,
  captureProfile,
  browserSandboxDisabled: false,
  externalRequests: [],
  rendererErrors: [],
  screenshots: {},
  cases: [],
  inputProbes: [],
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
  if (desktopReading || desktopRoom || desktopReentry || desktopNested) {
    assert(
      process.env.ZENX_PREVIEW_FONT_RECEIPT,
      "Reading preview requires a pinned font receipt",
    );
    evidence.fontEnvironment = JSON.parse(
      await readFile(process.env.ZENX_PREVIEW_FONT_RECEIPT, "utf8"),
    );
    assert.equal(evidence.fontEnvironment.status, "ready");
    assert.equal(evidence.fontEnvironment.revision, fontRevision);
    for (const asset of fontAssets) {
      const recorded = evidence.fontEnvironment.assets.find(
        (entry) => entry.name === asset.name,
      );
      assert.equal(recorded?.sha256, asset.sha256);
      assert.equal(recorded?.coverageVerified, true);
      // Do not trust a stale/copied preparation receipt after font files change.
      const fontPath = path.join(
        path.dirname(process.env.ZENX_PREVIEW_FONT_RECEIPT),
        asset.name,
      );
      assert.equal(hash(await readFile(fontPath)), asset.sha256);
    }
  }
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
      // Explicit desktop device emulation, not a browser security change.
      coarse
        ? "--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=0,availableHoverTypes=0"
        : "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2",
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
    if (coarse) {
      await send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...point, radiusX: 1, radiusY: 1, force: 1, id: 1 }],
      });
      await send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      return;
    }
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
  await send(
    "Emulation.setTouchEmulationEnabled",
    coarse ? { enabled: true, maxTouchPoints: 1 } : { enabled: false },
  );
  const tabTo = async (selector) => {
    for (let index = 0; index < 80; index++) {
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
      if (
        await evaluate(
          `document.activeElement?.matches(${JSON.stringify(selector)})`,
        )
      )
        return true;
    }
    return false;
  };
  lifecycle.captureStarted();
  if (desktopReading || desktopRoom || desktopReentry || desktopNested) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    evidence.fontProbe = await probePreviewFonts(send, evaluate, origin);
    const probe = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(probe.data, "base64");
    await writeFile(path.join(directory, "font-probe.png"), bytes);
    evidence.fontProbe.screenshot = "font-probe.png";
    evidence.fontProbe.sha256 = hash(bytes);
  }
  const capture = async (name, options, scene) => {
    await evaluate(
      "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))",
    );
    await delay(200);
    const observation = await evaluate(`(() => {
      const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const selectors={sidebar:'.sidebar',thread:'.thread-view',composer:'.composer',information:'.editable-information-panel',pending:'.queue-shelf',pendingTray:'.pending-tray',bottomZone:'.bottom-zone',agentName:'.subagent-tree-title'};
      const tray=document.querySelector('.pending-tray'),trayRect=rect(tray);
      const pendingRows=[...document.querySelectorAll('.pending-tray .queue-row')].filter(e=>e.getBoundingClientRect().height>0).map(e=>{
        const kind=e.matches('.steer-shelf-row')?'steer':e.hasAttribute('data-queue-id')?'queue':'unknown';
        const bodySelector=kind==='steer'?(e.querySelector('.user-bubble')?'.user-bubble':'.pending-steer-images'):'.queue-row-content';
        const row=rect(e),body=e.querySelector(bodySelector),bodyRect=rect(body),actions=e.querySelector('.queue-row-actions');
        const observationWarnings=[];
        if(kind==='unknown')observationWarnings.push('unrecognized-row-kind');
        if(!body)observationWarnings.push('missing-body');
        if(row.width<=0)observationWarnings.push('zero-width-row');
        if(kind==='queue'&&!actions)observationWarnings.push('missing-action-group');
        const controls=[...e.querySelectorAll('.queue-row-actions button')].map(button=>{
          const r=rect(button),x=r.x+r.width/2,y=r.y+r.height/2;
          return {control:button.dataset.queueControl,label:button.getAttribute('aria-label'),text:button.textContent,disabled:button.disabled,rect:r,centerHit:button.contains(document.elementFromPoint(x,y))};
        });
        const actionLines=[];
        for(const control of controls)if(!actionLines.some(y=>Math.abs(y-control.rect.y)<2))actionLines.push(control.rect.y);
        return {kind,id:e.dataset.queueId??null,index:e.dataset.queueIndex??null,rect:row,bodySelector:body?bodySelector:null,bodyRect,bodyWidthRatio:bodyRect&&row.width>0?bodyRect.width/row.width:null,bodyHorizontalOverflow:body?body.scrollWidth>body.clientWidth+1:null,actionsRect:rect(actions),actionLineCount:actions?actionLines.length:null,observationWarnings,fullyWithinTray:row.y>=Math.max(0,trayRect.y)&&row.bottom<=Math.min(innerHeight,trayRect.bottom),controls};
      });
      const pendingLayout=tray?{trayRect,clientHeight:tray.clientHeight,scrollHeight:tray.scrollHeight,scrollTop:tray.scrollTop,horizontalOverflow:tray.scrollWidth>tray.clientWidth+1,visibleRowCount:pendingRows.filter(row=>row.rect.bottom>trayRect.y&&row.rect.y<trayRect.bottom).length,fullyWithinTrayCount:pendingRows.filter(row=>row.fullyWithinTray).length,rows:pendingRows}:null;
      const target=selector=>{const e=document.querySelector(selector);if(!e)return null;const r=rect(e);return {rect:r,disabled:!!e.disabled,centerHit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),fullyInViewport:r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,focused:document.activeElement===e};};
      const composerAccess={editor:target('.composer textarea'),primary:target('.composer .action-orb')};
      return {composerAccess,pendingLayout,url:location.href,input:{finePointer:matchMedia('(pointer:fine)').matches,coarsePointer:matchMedia('(pointer:coarse)').matches,hover:matchMedia('(hover:hover)').matches,noHover:matchMedia('(hover:none)').matches,touchPoints:navigator.maxTouchPoints},viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth,visibleText:document.body.innerText.slice(0,12000),geometry:Object.fromEntries(Object.entries(selectors).map(([k,s])=>[k,rect(document.querySelector(s))])),names:[...document.querySelectorAll('.subagent-tree-title')].map(e=>({text:e.textContent,rect:rect(e),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})),buttons:[...document.querySelectorAll('.queue-shelf button')].map(e=>({label:e.getAttribute('aria-label'),disabled:e.disabled,rect:rect(e),color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor})),active:{tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label')}};
    })()`);
    const checkMainReply =
      scene === "main" &&
      !coarse &&
      options.width === 1280 &&
      options.height === 900;
    const observeMainReply = async () => {
      try {
        return await evaluate(mainReplyProbe);
      } catch (error) {
        return { passed: false, error: String(error) };
      }
    };
    const replyBefore = checkMainReply ? await observeMainReply() : null;
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
      path.join(directory, evidenceFile),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    if (checkMainReply) {
      // The first genuine PNG and its hash are already saved, even on failure.
      const replyAfter = await observeMainReply();
      const check = {
        before: replyBefore,
        after: replyAfter,
        pixels: null,
        error: null,
      };
      (evidence.mainReplyChecks ??= []).push({
        screenshot: filename,
        ...check,
      });
      const receipt = evidence.mainReplyChecks.at(-1);
      try {
        assert(
          replyBefore.passed && replyAfter.passed,
          "Main fixture reply must be visible in viewport",
        );
        assert.deepEqual(
          replyAfter,
          replyBefore,
          "Main reply geometry/style stable across raw capture",
        );
        receipt.pixels = await evaluate(`(async () => {
          const bytes=Uint8Array.from(atob(${JSON.stringify(result.data)}),c=>c.charCodeAt(0));
          const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
          try {
            if(bitmap.width!==innerWidth||bitmap.height!==innerHeight)throw Error('Unexpected screenshot pixel scale');
            const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');
            if(!ctx)throw Error('Screenshot decoder unavailable');
            ctx.drawImage(bitmap,0,0);
            return (${inspectMainReplyPixels.toString()})(ctx.getImageData(0,0,bitmap.width,bitmap.height).data,bitmap.width,bitmap.height,${JSON.stringify(replyBefore.rect)});
          } finally {bitmap.close();}
        })()`);
        assert(
          receipt.pixels.passed,
          "Main reply region contains no proven text-like pixel variation",
        );
      } catch (error) {
        receipt.error = String(error);
        throw error;
      }
    }
    if (scene === "pending" && options.height === 600) {
      assert(
        observation.composerAccess.editor?.fullyInViewport &&
          observation.composerAccess.editor.centerHit &&
          !observation.composerAccess.editor.disabled,
        "Short viewport Composer editor remains visible and hit-testable",
      );
      assert(
        observation.composerAccess.primary?.fullyInViewport &&
          observation.composerAccess.primary.centerHit,
        "Short viewport primary action remains visible and hit-testable",
      );
    }
    if (coarse) {
      const controls =
        observation.pendingLayout?.rows.flatMap((row) => row.controls) ?? [];
      assert(
        controls.length > 0,
        "Observe actual Queue controls at coarse input",
      );
      assert(
        controls.every(
          (control) => control.rect.width >= 44 && control.rect.height >= 44,
        ),
        "Coarse Queue control targets remain at least 44 by 44 CSS pixels",
      );
      const primary = observation.composerAccess.primary?.rect;
      assert(
        primary && primary.width >= 44 && primary.height >= 44,
        "Coarse primary action target remains at least 44 by 44 CSS pixels",
      );
    }
  };
  const fineCases = [
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
    // These additional cases only render pending. 760px does not exercise the
    // <=480px CSS branch; both are fine-pointer window widths, not touch tests.
    {
      name: "narrow-dark",
      width: 760,
      height: 900,
      theme: "dark",
      lang: "en",
      onlyScene: "pending",
    },
    {
      name: "compact-light",
      width: 390,
      height: 900,
      theme: "light",
      lang: "en",
      onlyScene: "pending",
    },
    {
      name: "compact-dark",
      width: 390,
      height: 900,
      theme: "dark",
      lang: "en",
      onlyScene: "pending",
    },
    {
      name: "compact-short-light",
      width: 390,
      height: 600,
      theme: "light",
      lang: "en",
      onlyScene: "pending",
    },
    {
      name: "compact-short-dark",
      width: 390,
      height: 600,
      theme: "dark",
      lang: "en",
      onlyScene: "pending",
    },
  ];
  if (desktopQueue)
    assert.deepEqual(
      Object.keys(source.scenes),
      ["pending"],
      "Desktop queue requires only the pending bundle",
    );
  if (desktopReading)
    assert.deepEqual(
      Object.keys(source.scenes),
      ["reading"],
      "Desktop reading requires only the production App reading bundle",
    );
  const cases = ordinaryTitles
    ? ["light", "dark"].flatMap((theme) =>
        ["baseline", "two-lines"].map((variant) => ({
          name: `ordinary-titles-${theme}-${variant}`,
          width: 1280,
          height: 900,
          theme,
          variant,
          lang: "zh-CN",
          onlyScene: "navigation",
        })),
      )
    : coarse
      ? [
          {
            name: "compact-short-coarse-light",
            width: 390,
            height: 600,
            theme: "light",
            lang: "en",
            onlyScene: "pending",
          },
          {
            name: "compact-short-coarse-dark",
            width: 390,
            height: 600,
            theme: "dark",
            lang: "en",
            onlyScene: "pending",
          },
        ]
      : fineCases;
  for (const options of desktopOnly
    ? cases.filter((c) => c.width === 1280 && c.height === 900)
    : desktopRoom
      ? cases
          .filter((c) => c.width === 1280 && c.height === 900)
          .map((c) => ({ ...c, width: 1440, lang: "zh-CN" }))
      : desktopReentry || desktopNested || desktopChildNavigation
        ? cases.filter(
            (c) => c.width === 1280 && c.height === 900 && c.theme === "light",
          )
        : desktopChildSidebar
          ? cases.filter((c) => c.width === 1280 && c.height === 900)
          : desktopBusyChild
            ? cases.filter(
                (c) =>
                  c.width === 1280 && c.height === 900 && c.theme === "light",
              )
            : desktopCombinedAttention
              ? (identityCase ? ["light"] : ["light", "dark"]).flatMap(
                  (theme) =>
                    (identityCase ? [identityCase.lang] : ["en", "zh-CN"]).map(
                      (lang) => ({
                        name: `desktop-${theme}-${lang}${identityCaseName ? `-${identityCaseName}` : ""}`,
                        ...(identityCaseName
                          ? { identityCase: identityCaseName }
                          : {}),
                        width: 1280,
                        height: 900,
                        theme,
                        lang,
                        onlyScene: "navigation",
                      }),
                    ),
                )
              : cases) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const scene of Object.keys(source.scenes)) {
      if (options.onlyScene && scene !== options.onlyScene) continue;
      if (
        scene === "navigation" &&
        (coarse || options.width !== 1280 || options.height !== 900)
      )
        continue;
      const query = new URLSearchParams({
        theme: options.theme,
        lang: options.lang,
        platform: "linux",
      });
      if (scene === "reading") query.set("scene", "reading");
      if (desktopResultFile) query.set("resultFile", "1");
      if (desktopReentry) query.set("streaming", "1");
      if (scene === "information") query.set("scene", "lineage");
      if (scene === "navigation") {
        query.set("scene", "navigation");
        if (ordinaryTitles) query.set("ordinaryTitles", options.variant);
        query.set("conversationTabs", "true");
        if (desktopChildSidebar || desktopChildNavigation)
          query.set("childSidebar", "1");
        if (desktopChildNavigation) query.set("childNavigation", "1");
        if (desktopBusyChild) query.set("busyChild", "approval");
        if (desktopCombinedAttention) query.set("busyChild", "approval-asking");
        if (identityCaseName) query.set("identityCase", identityCaseName);
      }
      if (scene === "pending") {
        query.set("many", "");
        if (options.width < 1000) query.set("narrow", "");
      }
      const url = `${origin}/${scene}.html?${query}`;
      await send("Page.navigate", { url });
      await wait(
        `location.href===${JSON.stringify(url)} && !!document.querySelector('#root > *')`,
      );
      const inputProbe = await evaluate(
        "({finePointer:matchMedia('(pointer:fine)').matches,coarsePointer:matchMedia('(pointer:coarse)').matches,hover:matchMedia('(hover:hover)').matches,noHover:matchMedia('(hover:none)').matches,touchPoints:navigator.maxTouchPoints})",
      );
      evidence.inputProbes.push({ url, pointer, ...inputProbe });
      assert.equal(
        await evaluate(
          coarse
            ? "matchMedia('(pointer:coarse)').matches && !matchMedia('(pointer:fine)').matches && matchMedia('(hover:none)').matches && !matchMedia('(hover:hover)').matches && navigator.maxTouchPoints > 0"
            : "matchMedia('(pointer:fine)').matches && !matchMedia('(pointer:coarse)').matches && matchMedia('(hover:hover)').matches",
        ),
        true,
        `Actual ${pointer} pointer and hover media capabilities`,
      );
      if (scene === "room") {
        assert(
          desktopRoom,
          "Room evidence requires its distinct desktop-only profile",
        );
        await roomCapture.captureRoomFileOwners({
          send,
          evaluate,
          wait,
          click,
          capture,
          evidence,
          options,
          url,
          diagnostic: async (name) => {
            const result = await send("Page.captureScreenshot", {
              format: "png",
              captureBeyondViewport: false,
            });
            const bytes = Buffer.from(result.data, "base64");
            const filename = `${name}.png`;
            await writeFile(path.join(directory, filename), bytes);
            evidence.diagnostics ??= {};
            evidence.diagnostics[filename] = {
              sha256: hash(bytes),
              acceptance: false,
            };
          },
        });
        continue;
      }
      if (desktopNested) {
        await captureInlineTrace({
          send,
          evaluate,
          wait,
          capture,
          evidence,
          options,
          url,
          nested: true,
        });
        continue;
      }
      if (desktopReentry) {
        await captureReadingReentry({
          send,
          evaluate,
          wait,
          click,
          capture,
          evidence,
          options,
        });
        continue;
      }
      if (scene === "reading") {
        assert(
          desktopReading,
          "Reading journey requires its desktop-only profile",
        );
        await captureDesktopReading({
          send,
          evaluate,
          wait,
          click,
          capture,
          evidence,
          options,
          url,
        });
        continue;
      }
      if (scene === "navigation") {
        await (
          desktopCombinedAttention
            ? combinedAttentionCapture
            : desktopBusyChild
              ? captureBusyChild
              : desktopChildNavigation
                ? captureChildNavigation
                : desktopChildSidebar
                  ? captureChildSidebar
                  : captureDesktopNavigation
        )({
          send,
          evaluate,
          wait,
          click,
          tabTo,
          capture,
          evidence,
          options,
        });
        continue;
      } else if (scene === "main") {
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
      if (desktopQueue) {
        await captureQueueReading({
          send,
          evaluate,
          wait,
          click,
          capture,
          evidence,
          options,
        });
        continue;
      }
      await capture(`${scene}-${options.name}`, options, scene);
      if (scene === "pending") {
        const action = await evaluate(
          `(() => {const e=document.querySelector('.queue-row-edit:not(:disabled)'); if(!e)return null; e.scrollIntoView({block:'nearest',inline:'nearest'}); const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2; if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Editable queue action is not visible');return {x,y};})()`,
        );
        assert(action, "An editable user queue row must be rendered");
        if (!coarse) {
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            ...action,
          });
          assert.equal(
            await evaluate(
              "document.querySelector('.queue-row-edit:not(:disabled)').matches(':hover')",
            ),
            true,
            "Actual pointer hover on the editable queue action",
          );
          await capture(`${scene}-${options.name}-hover`, options, scene);
        }
        // Native Tab, not DOM focus(), is what establishes :focus-visible.
        const focused = await tabTo(
          ".queue-row-edit:not(:disabled):focus-visible",
        );
        assert(
          focused,
          "Editable queue action is reachable with a native Tab focus ring",
        );
        await capture(`${scene}-${options.name}-focus`, options, scene);
        if (coarse) {
          await click(".composer textarea");
          await wait("document.activeElement?.matches('.composer textarea')");
          await capture(
            `${scene}-${options.name}-composer-touch`,
            options,
            scene,
          );
          assert(
            await tabTo(".composer textarea"),
            "Composer editor is reachable by native Tab after queue controls",
          );
          await capture(
            `${scene}-${options.name}-composer-keyboard`,
            options,
            scene,
          );
        }
      }
    }
  }
  assert.deepEqual(
    evidence.externalRequests,
    [],
    "No external resource requests",
  );
  assert.deepEqual(evidence.rendererErrors, [], "No renderer exceptions");
  if (ordinaryTitles) assert.equal(evidence.ordinaryTitleCases?.length, 4);
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
      const stopped = await lifecycle.close(diagnosticsDirectory);
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
      path.join(directory, evidenceFile),
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
