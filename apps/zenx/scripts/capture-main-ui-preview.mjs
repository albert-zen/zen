import { fontProbeHTML, probePreviewFonts } from "./preview-font-probe.mjs";
import { fontRevision, fontAssets } from "./prepare-preview-fonts.mjs";
import { captureDesktopReading } from "./reading-main-ui-preview.mjs";
import { captureQueueReading } from "./queue-reading-main-ui-preview.mjs";
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
import { captureDesktopNavigation } from "./navigation-main-ui-preview.mjs";

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
const desktopQueue = captureProfile === "desktop-queue";
const desktopReading = captureProfile === "desktop-reading";
const desktopRoom = captureProfile === "desktop-room";
// Older profiles must not load this separately scoped receipt/capture helper.
const roomCapture = desktopRoom
  ? await import("./room-file-owner-main-ui-preview.mjs")
  : null;
const desktopOnly = desktopQueue || desktopReading;
const pointer = desktopOnly ? "fine" : desktopRoom ? "fine" : captureProfile;
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
if (desktopReading || desktopRoom)
  files.set("/font-probe.html", Buffer.from(fontProbeHTML));
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
  if (desktopReading || desktopRoom) {
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
  if (desktopReading || desktopRoom) {
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
  const cases = coarse
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
      if (scene === "information") query.set("scene", "lineage");
      if (scene === "navigation") {
        query.set("scene", "navigation");
        query.set("conversationTabs", "true");
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
        await captureDesktopNavigation({
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
