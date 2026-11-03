/** Isolated macOS packaged-App case. Electron native input, not hardware input. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, Menu, session } = require("electron");
assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(app.isPackaged, true);
assert.notEqual(process.defaultApp, true);
assert(!process.argv.some((arg) => arg === "--no-sandbox" || arg.startsWith("--remote-debugging")));
const [directory, temporary] = process.argv.slice(1, 3);
assert(directory && temporary);
app.setPath("userData", path.join(temporary, "profile"));
app.setPath("home", path.join(temporary, "home"));
app.setPath("documents", path.join(temporary, "home/Documents"));
const screenshotNames = Object.freeze([
  "image-notice-open-before.png", "image-notice-open-full-dom.png",
  "image-notice-open-restored.png", "image-notice-thread-isolated.png",
]);
const result = { ok: false, screenshots: [], checks: {}, blockedExternalRequests: 0 };
let window;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Each expression below has its own fixed plain-data result; no generic DOM serializer.
const evaluate = (expression) => window.webContents.executeJavaScript(expression, true);
async function until(check, stage) {
  result.stage = stage;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await pause(100);
  }
  throw Error("Owned image notice stage timed out");
}
async function click(selector, stage) {
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), stage);
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Owned target obscured');return {x:Math.round(x),y:Math.round(y)}})()`);
  window.show(); window.focus(); window.webContents.focus();
  await until(async () => window.isFocused() && window.webContents.isFocused(), stage);
  for (const type of ["mouseDown", "mouseUp"]) window.webContents.sendInputEvent({ type, button: "left", clickCount: 1, ...point });
}
const noticeSelector = ".image-preparation-notice details[data-image-preparation-sample-id]";
const summarySelector = noticeSelector + " > summary";
async function state() {
  return evaluate(`(()=>{const d=document.querySelector(${JSON.stringify(noticeSelector)}),s=document.querySelector('.messages');return {present:Boolean(d),open:d?.open??null,sampleId:d?.dataset.imagePreparationSampleId??null,dimensions:Boolean(d&&/2048\\s*×\\s*2048\\s*→\\s*1600\\s*×\\s*1600/.test(d.textContent)),fullDom:s?.dataset.nativeTranscriptSelection==='complete',virtual:Boolean(s?.classList.contains('experimental-transcript-viewport')),selectionActive:Boolean(getSelection()&&!getSelection().isCollapsed),rows:s?.querySelectorAll('section.turn').length??0}})()`);
}
async function revealNotice() {
  // No scrollTop mutation, synthetic DOM click or details.open assignment.
  for (let attempt = 0; attempt < 12; attempt++) {
    const observation = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(summarySelector)}),s=document.querySelector('.messages');if(!e||!s)return null;const r=e.getBoundingClientRect(),v=s.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;return {visible:r.top>=v.top&&r.bottom<=v.bottom&&e.contains(document.elementFromPoint(x,y)),point:{x:Math.round((v.left+v.right)/2),y:Math.round((Math.max(0,v.top)+Math.min(innerHeight,v.bottom))/2)}}})()`);
    assert(observation);
    if (observation.visible) return;
    window.webContents.sendInputEvent({ type: "mouseMove", ...observation.point });
    window.webContents.sendInputEvent({ type: "mouseWheel", ...observation.point, deltaX: 0, deltaY: 600, canScroll: true, hasPreciseScrollingDeltas: true });
    await pause(200);
  }
  throw Error("Owned image Notice could not be revealed");
}
async function screenshot(name) {
  assert(screenshotNames.includes(name));
  assert(!result.screenshots.includes(name));
  const observed = await state();
  assert(observed.present && observed.dimensions);
  await revealNotice();
  await fs.writeFile(path.join(directory, name), (await window.webContents.capturePage()).toPNG());
  result.screenshots.push(name);
}
// Same installed product Edit menu handler as the existing 5000-row case.
function invokeProductSelectAll() {
  assert.equal(window.isFocused() && window.webContents.isFocused(), true);
  assert.equal(BrowserWindow.getFocusedWindow(), window);
  assert.equal(window.webContents.focusedFrame, window.webContents.mainFrame);
  const edit = Menu.getApplicationMenu()?.items.find((item) => item.submenu?.items.some((child) => child.role === "copy"));
  const selectAll = edit?.submenu?.items.find((item) => item.accelerator === "CommandOrControl+A");
  assert(selectAll?.enabled && typeof selectAll.click === "function");
  selectAll.click(selectAll, window, {});
}
async function remount(open, sampleId) {
  await revealNotice();
  await click(".image-preparation-notice > strong", "focus-notice-transcript");
  invokeProductSelectAll();
  await until(async () => {
    const observed = await state();
    return observed.fullDom && observed.selectionActive && observed.open === open && observed.sampleId === sampleId && observed.dimensions;
  }, open ? "open-full-dom" : "closed-full-dom");
  if (open) await screenshot("image-notice-open-full-dom.png");
  await click("#thread-composer", "clear-through-composer");
  await until(async () => {
    const observed = await state();
    return observed.virtual && !observed.fullDom && !observed.selectionActive && observed.open === open && observed.sampleId === sampleId && observed.dimensions;
  }, open ? "open-restored" : "closed-restored");
  result.checks[open ? "openSurvivesFullDomAndClear" : "closedSurvivesFullDomAndClear"] = true;
  if (open) await screenshot("image-notice-open-restored.png");
}
async function selectThread(threadId) {
  const selector = `.thread-row-shell[data-thread-id=${JSON.stringify(threadId)}] > button.thread-row`;
  await click(selector, "select-owned-thread");
  await until(async () => {
    const observed = await state();
    return observed.present && observed.dimensions && observed.virtual;
  }, "owned-thread-notice");
  await revealNotice();
}
const networkReady = app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed = ["file:", "data:", "blob:", "about:", "devtools:"].includes(url.protocol) || (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    } catch {}
    if (!allowed) result.blockedExternalRequests++;
    callback({ cancel: !allowed });
  });
});
async function run() {
  await networkReady;
  await until(async () => Boolean(window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith("/renderer/index.html"))), "production-renderer");
  const preferences = window.webContents.getLastWebPreferences();
  assert(preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration);
  window.setSize(1280, 820); window.show(); window.focus();
  await until(() => evaluate("Boolean(document.querySelector('.app-shell')&&window.zenx?.protocol)"), "app-mounted");
  // Existing explicit default-off experiment opt-in, before any Thread is selected.
  await evaluate("sessionStorage.setItem('zenx.experimental.virtualTranscript','1')");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Owned reload timed out")), 30000);
    window.webContents.once("did-finish-load", () => { clearTimeout(timeout); resolve(); });
    window.webContents.reload();
  });
  await until(() => evaluate("Boolean(window.zenx?.protocol)&&window.zenx.protocol.getStatus().then(s=>s.type==='ready')"), "fake-host-ready");
  const configured = await evaluate(`window.zenx.settings.get().then(s=>({fake:s.profile.providerProfiles.find(p=>p.providerProfileId==='fake')?.type==='fake',model:s.profile.defaultModel.modelId,image:s.profile.providerProfiles.find(p=>p.providerProfileId==='fake')?.models.find(m=>m.id==='image-notice-fake')?.inputModalities?.includes('image')===true,noAuth:!s.hasApiKey&&!s.subscription.authenticated}))`);
  assert(configured.fake && configured.image && configured.noAuth);
  assert.equal(configured.model, "image-notice-fake");
  result.checks.actualAppImageCapableFakeCatalog = true;
  const manifest = JSON.parse(await fs.readFile(path.join(temporary, "image-notice-private-fixture.json"), "utf8"));
  assert(manifest.synthetic && manifest.threads.length === 2);
  const [a, b] = manifest.threads;
  await selectThread(a.threadId);
  const first = await state();
  assert.equal(first.open, false);
  assert(first.sampleId);
  await click(summarySelector, "open-first-sample");
  await until(async () => (await state()).open === true, "first-sample-open");
  await screenshot("image-notice-open-before.png");
  await remount(true, first.sampleId);
  await revealNotice();
  await click(summarySelector, "close-first-sample");
  await until(async () => (await state()).open === false, "first-sample-closed");
  await remount(false, first.sampleId);
  await revealNotice();
  await click(summarySelector, "reopen-before-new-sample");
  await until(async () => (await state()).open === true, "first-sample-reopened");
  await click("#thread-composer", "focus-real-send");
  await window.webContents.insertText(manifest.followupText);
  await until(() => evaluate("Boolean(document.querySelector('.composer-send-control button.action-orb.send:not(:disabled)'))"), "real-send-ready");
  await click(".composer-send-control button.action-orb.send", "send-next-image-sample");
  await until(async () => {
    const observed = await state();
    return observed.present && observed.dimensions && observed.sampleId !== first.sampleId && observed.open === false;
  }, "new-sample-default-closed");
  // Query is read-only: completion and canonical receipt come from the real Host.
  await until(() => evaluate(`window.zenx.protocol.request('thread/read',{threadId:${JSON.stringify(a.threadId)},includeTurns:true}).then(r=>r.thread.turns.length===2&&r.thread.turns.every(t=>t.status==='completed'))`), "second-turn-completed");
  result.checks.newSampleDoesNotInheritOpen = true;
  await revealNotice();
  await click(summarySelector, "open-second-sample");
  await until(async () => (await state()).open === true, "second-sample-open");
  const second = await state();
  await selectThread(b.threadId);
  const other = await state();
  assert.notEqual(other.sampleId, second.sampleId);
  assert.equal(other.open, false);
  result.checks.otherThreadDoesNotInheritOpen = true;
  await screenshot("image-notice-thread-isolated.png");
  await click(summarySelector, "open-other-thread");
  await until(async () => (await state()).open === true, "other-thread-open");
  await selectThread(a.threadId);
  const returned = await state();
  assert.equal(returned.sampleId, second.sampleId);
  assert.equal(returned.open, false); // Thread-keyed reading state is disposable.
  result.checks.returnedThreadHasFreshReadingState = true;
  result.ok = true;
}
void import(pathToFileURL(path.join(__dirname, "../out/main/index.js")).href)
  .then(run)
  .catch(() => { result.ok = false; }) // Raw stacks and paths remain in private process logs.
  .finally(async () => {
    await fs.writeFile(path.join(directory, "image-notice-private-result.json"), JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    app.quit(); // Production before-quit closes the owned Host before process close.
  });
