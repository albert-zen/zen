// Opt-in synthetic native experiment. Not imported by the production application.
const { app, BrowserWindow, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");

const output = path.resolve(process.argv[2] || "webview-experiment-evidence");
const report = {
  experiment: "persistent-webview",
  platform: process.platform,
  electron: process.versions.electron,
  synthetic: true,
  checks: [],
  limitations: [
    "Not integrated into the production WorkspaceBrowser backend",
    "No OS IME or native file-dialog acceptance",
    "Renderer reload destroys live guests; persistence is only across panel/tab switches",
    "No multi-panel simultaneous interactive mirroring",
    "Input is injected into each WebContents separately, not an OS pointer-routing audit",
  ],
};
let window, server;
const timer = setTimeout(
  () => finish(new Error("Native experiment exceeded 60 seconds")),
  60_000,
);
async function check(name, operation, continueAfterFailure = false) {
  try {
    await operation();
    report.checks.push({ name, status: "passed" });
  } catch (error) {
    report.checks.push({ name, status: "failed", error: String(error) });
    if (!continueAfterFailure) throw error;
  }
}
async function bounded(promise, name) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${name} did not complete within 5 seconds`)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
async function until(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(message);
}
async function finish(error) {
  if (report.finished) return;
  report.finished = true;
  clearTimeout(timer);
  if (error) report.error = error.stack || String(error);
  const failed =
    error || report.checks.some((check) => check.status === "failed");
  report.status = failed ? "failed" : "passed";
  let exitCode = failed ? 1 : 0;
  try {
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } catch (writeError) {
    console.error("Unable to save experiment report", writeError);
    exitCode = 1;
  } finally {
    try {
      if (window && !window.isDestroyed()) window.destroy();
    } finally {
      server?.close();
      app.exit(exitCode);
    }
  }
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  // No user profile, cookies, credentials, remote content or production host.
  app.setPath("userData", path.join(output, "disposable-profile"));
  await app.whenReady();
  const token = randomUUID();
  const guests = new Map();
  let guestSequence = 0;
  const moduleSource = await fs.readFile(
    path.join(__dirname, "persistent-host.mjs"),
  );
  server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'",
    );
    if (req.url === `/${token}/persistent-host.mjs`) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(moduleSource);
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === `/${token}/host`) {
      res.end(
        `<!doctype html><title>Synthetic WebView experiment</title><style>html,body{margin:0;width:100%;height:100%;background:white}#panel{position:absolute;inset:0}#overlay{display:none;position:fixed;inset:0;z-index:1000;background:rgb(240,20,180)}#chrome{position:fixed;z-index:2;top:0;left:0}</style><div id="panel"></div><div id="chrome">Synthetic guest fixture, not ZenX production UI</div><div id="overlay" role="dialog" aria-modal="true"></div><script type="module">import { PersistentGuestHost } from './persistent-host.mjs'; window.host = new PersistentGuestHost(document.querySelector('#panel')); window.overlayClicks=0;document.querySelector('#overlay').onclick=()=>window.overlayClicks++;</script>`,
      );
      return;
    }
    if (req.url === `/${token}/guest/a` || req.url === `/${token}/guest/b`) {
      res.end(
        `<!doctype html><title>Synthetic guest</title><style>html,body{margin:0;width:100%;height:100%;background:rgb(20,180,70)}button{position:absolute;left:300px;top:250px;width:200px;height:100px}</style><input id="value" aria-label="Persistent value"><button id="click">Synthetic action</button><script>window.marker=crypto.randomUUID();window.clicks=0;document.querySelector('#click').onclick=()=>{window.clicks++;document.body.style.background='rgb(30,70,220)'};</script>`,
      );
      return;
    }
    res.statusCode = 404;
    res.end("Not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hostUrl = `${origin}/${token}/host`;
  const guestUrls = new Set([
    `${origin}/${token}/guest/a`,
    `${origin}/${token}/guest/b`,
  ]);
  const partition = `zen-webview-experiment-${token}`;
  window = new BrowserWindow({
    width: 800,
    height: 650,
    useContentSize: true,
    show: true,
    webPreferences: {
      webviewTag: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: `host-${token}`,
    },
  });
  window.webContents.session.setPermissionRequestHandler(
    (_web, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== hostUrl) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (!guestUrls.has(params.src) || params.partition !== partition) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    preferences.sandbox = true;
    preferences.contextIsolation = true;
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.webviewTag = false;
    preferences.backgroundThrottling = false;
    params.allowpopups = false;
  });
  window.webContents.on("did-attach-webview", (_event, guest) => {
    const sequence = ++guestSequence;
    guests.set(sequence, guest);
    guest.session.setPermissionRequestHandler((_web, _permission, callback) =>
      callback(false),
    );
    guest.session.setPermissionCheckHandler(() => false);
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.on("will-navigate", (event, url) => {
      if (!guestUrls.has(url)) event.preventDefault();
    });
    guest.on("will-redirect", (event, url) => {
      if (!guestUrls.has(url)) event.preventDefault();
    });
  });
  const ui = (source) => window.webContents.executeJavaScript(source);
  const frame = () =>
    ui(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
  const show = async (id) => {
    await ui(`host.show(${JSON.stringify(id) ?? "undefined"})`);
    await frame();
    assert.deepEqual(
      await ui(
        "Array.from(document.querySelectorAll('webview')).filter(g => getComputedStyle(g).visibility === 'visible').map(g => g.dataset.tabId)",
      ),
      id === undefined ? [] : [id],
    );
  };
  const clickAtCenter = (target) => {
    for (const type of ["mouseDown", "mouseUp"])
      target.sendInputEvent({
        type,
        x: 400,
        y: 300,
        button: "left",
        clickCount: 1,
      });
  };
  await window.loadURL(hostUrl);
  await until(() => ui("Boolean(window.host)"), "Host module did not load");
  async function add(id) {
    const before = guestSequence;
    await ui(
      `host.add(${JSON.stringify(id)},${JSON.stringify(`${origin}/${token}/guest/${id}`)},${JSON.stringify(partition)}); undefined`,
    );
    await until(() => guestSequence > before, "Guest did not attach");
    const guest = guests.get(guestSequence);
    await until(
      async () =>
        !guest.isLoading() &&
        (await guest.executeJavaScript("Boolean(window.marker)")),
      "Guest fixture did not load",
    );
    return guest;
  }
  const a = await add("a");
  const b = await add("b");
  await show("a");
  const marker = await a.executeJavaScript(
    "document.querySelector('#value').value='retained'; history.pushState({},'', '#kept'); window.marker",
  );
  await check("guests are sandboxed and have no Node bridge", async () => {
    for (const guest of [a, b]) {
      assert.equal(
        await guest.executeJavaScript("typeof require"),
        "undefined",
      );
      const preferences = guest.getLastWebPreferences();
      assert.equal(preferences.sandbox, true);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.nodeIntegration, false);
    }
  });
  await check(
    "repeated panel/thread presentation switches retain exact guest identity, history and state",
    async () => {
      const id = a.id;
      for (let i = 0; i < 10; i++) {
        await show("b");
        await show(undefined);
        await show("a");
      }
      assert.equal(a.id, id);
      assert.equal(await a.executeJavaScript("window.marker"), marker);
      assert.equal(
        await a.executeJavaScript("document.querySelector('#value').value"),
        "retained",
      );
      assert.equal(await a.executeJavaScript("location.hash"), "#kept");
      assert.equal(
        await ui(
          "document.querySelector('[data-tab-id=a]').getWebContentsId()",
        ),
        id,
      );
    },
  );
  await check(
    "visible guest composites and receives native input before overlay",
    async () => {
      await frame();
      const screenshot = await window.webContents.capturePage();
      await fs.writeFile(
        path.join(output, "synthetic-visible-guest.png"),
        screenshot.toPNG(),
      );
      const pixel = screenshot
        .resize({ width: 800, height: 650 })
        .crop({ x: 20, y: 150, width: 1, height: 1 })
        .toBitmap();
      assert.ok(
        pixel[1] > 140 && pixel[0] < 100 && pixel[2] < 60,
        `Visible guest pixel: ${[...pixel]}`,
      );
      clickAtCenter(a);
      await until(
        async () => (await a.executeJavaScript("clicks")) === 1,
        "Visible guest did not receive native input",
      );
    },
  );
  await check(
    "DOM modal composites above guest and receives host-targeted input",
    async () => {
      await ui("document.querySelector('#overlay').style.display='block'");
      await frame();
      assert.equal(
        await ui("document.elementFromPoint(400, 300).id"),
        "overlay",
      );
      const screenshot = await window.webContents.capturePage();
      await fs.writeFile(
        path.join(output, "synthetic-overlay.png"),
        screenshot.toPNG(),
      );
      const pixel = screenshot
        .resize({ width: 800, height: 650 })
        .crop({ x: 400, y: 300, width: 1, height: 1 })
        .toBitmap();
      assert.ok(
        pixel[2] > 200 && pixel[1] < 60 && pixel[0] > 140,
        `Overlay pixel: ${[...pixel]}`,
      );
      window.webContents.sendInputEvent({
        type: "mouseDown",
        x: 400,
        y: 300,
        button: "left",
        clickCount: 1,
      });
      window.webContents.sendInputEvent({
        type: "mouseUp",
        x: 400,
        y: 300,
        button: "left",
        clickCount: 1,
      });
      await until(
        () => ui("overlayClicks === 1"),
        "Modal did not receive native click",
      );
      assert.equal(await a.executeJavaScript("clicks"), 1);
      await ui("document.querySelector('#overlay').style.display='none'");
    },
  );
  await check("visible guest CDP screenshot baseline is fresh", async () => {
    a.debugger.attach("1.3");
    try {
      const shot = await bounded(
        a.debugger.sendCommand("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        }),
        "Visible Page.captureScreenshot",
      );
      const image = nativeImage.createFromBuffer(
        Buffer.from(shot.data, "base64"),
      );
      const pixel = image
        .crop({ x: 20, y: 150, width: 1, height: 1 })
        .toBitmap();
      assert.ok(
        pixel[0] > 180 && pixel[1] < 100 && pixel[2] < 60,
        `Visible CDP pixel: ${[...pixel]}`,
      );
    } finally {
      a.debugger.detach();
    }
  });
  await show("b");
  const focusedBefore = BrowserWindow.getFocusedWindow()?.id;
  a.debugger.attach("1.3");
  try {
    await check("hidden persistent guest accepts CDP action", async () => {
      const result = await bounded(
        a.debugger.sendCommand("Runtime.evaluate", {
          expression:
            "document.querySelector('#click').click(); document.body.style.background='rgb(230,140,10)'; window.clicks",
          returnByValue: true,
        }),
        "Hidden Runtime.evaluate",
      );
      assert.equal(result.result.value, 2);
    });
    await check(
      "hidden persistent guest produces fresh CDP screenshot",
      async () => {
        const image = await bounded(
          a.debugger.sendCommand("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          }),
          "Hidden Page.captureScreenshot",
        );
        const bytes = Buffer.from(image.data, "base64");
        await fs.writeFile(
          path.join(output, "synthetic-hidden-guest.png"),
          bytes,
        );
        const native = nativeImage.createFromBuffer(bytes);
        assert.ok(!native.isEmpty());
        // Orange exists only after the hidden action; a stale visible frame cannot pass.
        const pixel = native
          .crop({ x: 20, y: 150, width: 1, height: 1 })
          .toBitmap();
        assert.ok(
          pixel[0] < 40 && pixel[1] > 110 && pixel[1] < 170 && pixel[2] > 200,
          `Hidden frame pixel: ${[...pixel]}`,
        );
      },
      true,
    ); // Keep measuring independent lifecycle behavior after an observation failure.
  } finally {
    a.debugger.detach();
  }
  await check(
    "background probes do not change focused Electron window",
    async () => {
      assert.equal(BrowserWindow.getFocusedWindow()?.id, focusedBefore);
    },
  );
  await check("explicit close destroys only its guest", async () => {
    await ui("host.close('b')");
    await until(() => b.isDestroyed(), "Closed guest survived");
    assert.equal(a.isDestroyed(), false);
  });
  await check(
    "guest crash is observable and does not silently replace page identity",
    async () => {
      const gone = once(a, "render-process-gone");
      a.forcefullyCrashRenderer();
      await gone;
      assert.equal(
        await ui(
          "document.querySelector('[data-tab-id=a]').getWebContentsId()",
        ),
        a.id,
      );
      await ui("host.close('a')");
      await until(() => a.isDestroyed(), "Crashed guest not cleaned up");
    },
  );
  const replacement = await add("a");
  await check(
    "host renderer reload loses guests rather than claiming live persistence",
    async () => {
      window.webContents.reload();
      await until(
        () => replacement.isDestroyed(),
        "Reload unexpectedly retained guest; inspect semantics before changing expectation",
      );
      report.rendererReload = "live guest destroyed; migration parity blocker";
    },
  );
  await finish();
})().catch(finish);
