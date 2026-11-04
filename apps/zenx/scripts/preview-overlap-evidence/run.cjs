const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { createHash } = require("node:crypto");
const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  systemPreferences,
} = require("electron");
const { createElectronWorkspaceBrowser } = require("./browser.cjs");
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Disposable hosted runner only",
);
assert.ok(
  ["darwin", "win32"].includes(process.platform),
  "Supported owned-window capture platform",
);
const profile = process.env.ZENX_OVERLAY_EVIDENCE_PROFILE;
assert.ok(
  profile && fs.statSync(profile).isDirectory(),
  "Parent-owned fresh synthetic profile",
);
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const receipt = {
  head: process.env.GITHUB_SHA,
  scope:
    "Production ImageUrlPreview, WorkspaceBrowserPanel and native WorkspaceBrowser; synthetic owned window/page; OS-composed desktopCapturer window screenshots. Not full App/Host or user desktop acceptance.",
  cases: [],
  status: "starting",
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let owner, browser, view, server;
async function until(check, label) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function capture(name, expected) {
  await owner.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  await pause(150);
  const sourceId = owner.getMediaSourceId();
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 1000, height: 700 },
    fetchWindowIcons: false,
  });
  const source = sources.find((s) => s.id === sourceId);
  assert.ok(
    source && !source.thumbnail.isEmpty(),
    "Exact owned window has nonempty OS capture",
  );
  const size = source.thumbnail.getSize();
  assert.ok(
    Math.abs(size.width / size.height - 1000 / 700) < 0.03,
    "Frameless owned-window aspect ratio",
  );
  const bitmap = source.thumbnail.toBitmap();
  const offset =
    (Math.floor(size.height * 0.5) * size.width +
      Math.floor(size.width * 0.8)) *
    4;
  const pixel = [...bitmap.subarray(offset, offset + 4)];
  for (let i = 0; i < 3; i++)
    assert.ok(
      Math.abs(pixel[i] - expected[i]) < 12,
      `${name}: native/DOM pixel ${pixel} expected ${expected}`,
    );
  const png = source.thumbnail.toPNG();
  fs.writeFileSync(path.join(__dirname, `${name}.png`), png);
  receipt.cases.push({
    name,
    size,
    pixel,
    sha256: createHash("sha256").update(png).digest("hex"),
    nativeVisible: view.getVisible(),
    nativeContentsId: view.webContents.id,
  });
}
(async () => {
  await app.whenReady();
  receipt.platform = process.platform;
  receipt.screenPermission =
    process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus("screen")
      : "no-macOS-permission-API";
  if (process.platform === "darwin" && receipt.screenPermission !== "granted") {
    receipt.status = "blocked-existing-screen-permission-unavailable";
    return;
  }
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<!doctype html><body style="margin:0;background:rgb(200,0,200);color:white;font:24px sans-serif">Owned native browser page</body>',
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  browser = createElectronWorkspaceBrowser({
    onCreateView: (value) => {
      view = value;
    },
  });
  owner = new BrowserWindow({
    width: 1000,
    height: 700,
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const [tab] = browser.command(
    owner.webContents,
    "evidence-thread",
    "new",
    undefined,
    `http://127.0.0.1:${server.address().port}/`,
  );
  const id = view.webContents.id;
  ipcMain.on("evidence:tab", (event) => {
    assert.equal(event.sender, owner.webContents);
    event.returnValue = tab;
  });
  ipcMain.handle("evidence:mount", (event, request) => {
    assert.equal(event.sender, owner.webContents);
    browser.mount(event.sender, request);
  });
  owner.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) receipt.rendererError = message.slice(0, 400);
  });
  await owner.loadFile(path.join(__dirname, "index.html"));
  owner.show();
  await until(
    () => view.getVisible() && !view.webContents.isLoading(),
    "initial native view",
  );
  await capture("01-native-visible", [200, 0, 200]);
  const point = await owner.webContents.executeJavaScript(
    "(() => {const r=document.querySelector('#open-preview').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
  );
  owner.webContents.sendInputEvent({
    type: "mouseDown",
    button: "left",
    clickCount: 1,
    ...point,
  });
  owner.webContents.sendInputEvent({
    type: "mouseUp",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await until(() => !view.getVisible(), "preview hides native view");
  await capture("02-preview-open", [0, 220, 255]);
  await owner.webContents.executeJavaScript(
    "window.__overlayEvidence.setCount(2)",
  );
  await until(
    async () =>
      await owner.webContents.executeJavaScript(
        "document.querySelectorAll('.image-preview-layer').length === 2",
      ),
    "two previews",
  );
  await owner.webContents.executeJavaScript(
    "window.__overlayEvidence.setCount(1)",
  );
  await until(
    async () =>
      await owner.webContents.executeJavaScript(
        "document.querySelectorAll('.image-preview-layer').length === 1",
      ),
    "one preview remains",
  );
  assert.equal(view.getVisible(), false);
  await capture("03-one-preview-remains", [0, 220, 255]);
  owner.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESC" });
  owner.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESC" });
  await until(() => view.getVisible(), "final close restores native view");
  assert.equal(view.webContents.id, id);
  await capture("04-native-restored", [200, 0, 200]);
  assert.equal(
    await owner.webContents.executeJavaScript("document.activeElement.id"),
    "open-preview",
  );
  receipt.status = "passed";
})()
  .catch((error) => {
    receipt.status = "failed";
    receipt.error = String(error.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await browser?.shutdown();
      owner?.destroy();
      server?.close();
    } catch (error) {
      receipt.cleanupError = String(error);
      process.exitCode = 1;
    }
    fs.writeFileSync(
      path.join(__dirname, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    app.exit(process.exitCode || 0);
  });
