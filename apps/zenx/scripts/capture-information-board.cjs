/** Operates only the disposable CI App created by launch-information-board-acceptance. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, session, nativeTheme } = require("electron");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.ok(["darwin", "win32"].includes(process.platform));
assert.ok(
  !process.argv.some(
    (a) => a === "--no-sandbox" || a.startsWith("--remote-debugging"),
  ),
);
const [directory, temporary] = process.argv.slice(2, 4);
assert.ok(directory && temporary);
app.setPath("userData", path.join(temporary, "profile"));
app.setPath("home", path.join(temporary, "home"));
app.setPath("documents", path.join(temporary, "home", "Documents"));
nativeTheme.themeSource = "light";
const result = {
  ok: false,
  synthetic: true,
  platform: process.platform,
  steps: [],
  cases: [],
  blockedExternalRequests: 0,
};
let window, taskId;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(expression) {
  const reply = await window.webContents.executeJavaScript(
    `(async()=>{try{return {ok:true,value:JSON.parse(JSON.stringify((await (${expression}))??null))}}catch(e){return {ok:false,error:String(e.stack||e)}}})()`,
    true,
  );
  if (!reply.ok) throw Error(reply.error);
  return reply.value;
}
async function until(check, label) {
  result.waitingFor = label;
  for (let i = 0; i < 300; i++) {
    if (await check()) {
      delete result.waitingFor;
      return;
    }
    await pause(100);
  }
  throw Error("Timed out: " + label);
}
const query = (selector) =>
  `document.querySelector(${JSON.stringify(selector)})`;
async function click(selector, label = selector) {
  await until(() => evaluate(`Boolean(${query(selector)})`), label);
  const point = await evaluate(
    `(()=>{const e=${query(selector)},r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw Error('Obscured/disabled native target: '+${JSON.stringify(label)}+' '+JSON.stringify({r:{x:r.x,y:r.y,width:r.width,height:r.height},hits:document.elementsFromPoint(x,y).map(n=>n.className).slice(0,5)}));return {x:Math.round(x),y:Math.round(y)}})()`,
  );
  window.show();
  window.focus();
  window.webContents.focus();
  await until(
    async () => window.isFocused() && window.webContents.isFocused(),
    "owned window focus",
  );
  window.webContents.sendInputEvent({
    type: "mouseDown",
    button: "left",
    clickCount: 1,
    ...point,
  });
  window.webContents.sendInputEvent({
    type: "mouseUp",
    button: "left",
    clickCount: 1,
    ...point,
  });
  result.steps.push(label);
}
async function screenshot(name) {
  await fs.writeFile(
    path.join(directory, name),
    (await window.webContents.capturePage()).toPNG(),
  );
}
async function capture(name, mode) {
  await until(
    () =>
      evaluate(
        `Boolean(document.querySelector(${JSON.stringify(mode === "dock" ? ".information-dock" : mode === "overlay" ? ".information-popover" : ".information-toolbar button[aria-pressed=false]")}))`,
      ),
    name + " presentation",
  );
  await pause(250);
  const geometry = await evaluate(
    `(()=>{const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,display:c.display,visibility:c.visibility,color:c.color,background:c.backgroundColor}};return {chat:rect('.agent-surface'),composer:rect('#thread-composer'),card:rect('.information-dock'),popover:rect('.information-popover'),workspace:rect('.workspace'),resource:rect('.auxiliary-panel'),informationToggle:rect('.information-toolbar button'),workspaceToggle:rect('.auxiliary-close-button'),expanded:document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded'),overflow:document.documentElement.scrollWidth>innerWidth,composerIdentity:window.__informationComposer===document.querySelector('#thread-composer'),draft:document.querySelector('#thread-composer')?.value}})()`,
  );
  if (mode === "dock") {
    assert.ok(
      geometry.chat.right <= geometry.card.left,
      "docked card cannot overlap the main conversation",
    );
    assert.ok(
      geometry.composer.right <= geometry.card.left,
      "docked card cannot overlap Composer",
    );
    assert.ok(
      geometry.chat.width >= 550,
      "conversation retains a usable allocation",
    );
    assert.ok(
      geometry.card.bottom <= geometry.workspace.bottom + 1,
      "card remains within workspace height",
    );
  }
  assert.equal(geometry.overflow, false, "no page-level horizontal overflow");
  if (mode !== "closed") assert.equal(geometry.expanded, "true");
  if (geometry.workspaceToggle && mode !== "closed") {
    assert.equal(
      geometry.informationToggle.background,
      geometry.workspaceToggle.background,
      "shared active surface",
    );
    assert.equal(
      geometry.informationToggle.color,
      geometry.workspaceToggle.color,
      "shared active foreground",
    );
  }
  await screenshot(name + ".png");
  result.cases.push({ name, mode, geometry });
}
const networkReady = app.whenReady().then(() =>
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const u = new URL(details.url);
      allowed =
        ["file:", "data:", "blob:", "about:", "devtools:"].includes(
          u.protocol,
        ) ||
        (["http:", "https:", "ws:", "wss:"].includes(u.protocol) &&
          ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
    } catch {}
    if (!allowed) result.blockedExternalRequests++;
    callback({ cancel: !allowed });
  }),
);
async function run() {
  await networkReady;
  await until(async () => {
    window = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith("/renderer/index.html"),
    );
    return !!window;
  }, "production App window");
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  window.setSize(1600, 1000);
  window.show();
  window.focus();
  await until(
    () =>
      evaluate(
        "Boolean(window.zenx?.protocol && document.querySelector('.app-shell'))",
      ),
    "full App mounted",
  );
  await until(
    () =>
      evaluate("window.zenx.protocol.getStatus().then(s=>s.type==='ready')"),
    "fake production Host ready",
  );
  const settings = await evaluate("window.zenx.settings.get()");
  assert.equal(settings.profile.defaultModel.providerProfileId, "fake");
  assert.equal(settings.hasApiKey, false);
  await until(
    () =>
      evaluate(
        "window.zenx.plugins.get().then(s=>s.commands.some(c=>c.pluginId==='zenx-triggers'&&c.id==='create'))",
      ),
    "admitted trigger plugin",
  );
  // Fixture setup uses real product APIs and exact isolated owners, never renderer mocks.
  const active = await evaluate(
    "window.zenx.plugins.executeCommand('zenx-triggers','create',{threadId:'information-main',kind:'timer',label:'Daily synthetic review',prompt:'Synthetic fixture only; not due during this run.',runAt:Date.now()+86400000})",
  );
  const paused = await evaluate(
    "window.zenx.plugins.executeCommand('zenx-triggers','create',{threadId:'information-main',kind:'timer',label:'Paused synthetic check',prompt:'Synthetic fixture only.',runAt:Date.now()+86400000})",
  );
  result.fixtureTriggers = { active, paused };
  await evaluate(
    `window.zenx.plugins.executeCommand('zenx-triggers','cancel',{triggerId:${JSON.stringify(paused.id)}})`,
  );
  await evaluate(
    "(async()=>{const owner={kind:'thread',id:'information-main'},s=await window.zenx.threadSidebar.read(owner);return window.zenx.threadSidebar.update({owner,expectedRevision:s.revision,patch:{open:false,fullscreen:false,tabs:[{kind:'file',path:'fixture.txt'}],selectedTab:'file:fixture.txt'}})})()",
  );
  const main =
    '.thread-row-shell[data-thread-id="information-main"] > button.thread-row';
  await click(main, "Select synthetic main conversation");
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('#thread-composer:not(:disabled)'))",
      ),
    "main composer",
  );
  const command =
    "!tool shell " +
    JSON.stringify({
      command: 'node -e "setTimeout(() => {}, 180000)"',
      yield_time_ms: 1000,
      timeout_ms: 200000,
    });
  await click(
    "#thread-composer",
    "Focus actual Composer for owned background command",
  );
  await window.webContents.insertText(command);
  await click(
    ".composer-send-control > button.action-orb.send:not(:disabled)",
    "Send synthetic fake-provider shell command",
  );
  await until(async () => {
    const listing = await evaluate(
      "window.zenx.shellPanel.request({operation:'list',threadId:'information-main'})",
    );
    const task = listing.sessions.find(
      (s) =>
        s.origin === "agent" &&
        s.kind === "command" &&
        s.lifecycle?.foreground === "running",
    );
    taskId = task?.taskId;
    return !!taskId;
  }, "native running Agent command");
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('#thread-composer:not(:disabled)'))",
      ),
    "editable Composer",
  );
  await click("#thread-composer", "Keep an unsent Composer draft");
  await window.webContents.insertText(
    "Synthetic draft must survive information and workspace toggles.",
  );
  await evaluate(
    "(()=>{window.__informationComposer=document.querySelector('#thread-composer');return true})()",
  );
  await click(".information-toolbar button", "Open wide information card");
  await until(
    () =>
      evaluate(
        "document.querySelector('.information-content')?.textContent.includes('Daily synthetic review') && document.querySelector('.information-content')?.textContent.includes('Review responsive layout') && Boolean(document.querySelector('.information-content .background-shell-list code'))",
      ),
    "real trigger, lineage and command cards",
  );
  await capture("01-wide-light", "dock");
  await click(
    "#thread-browser-toggle",
    "Open workspace and automatically close information",
  );
  await capture("02-workspace-auto-close", "closed");
  await click(
    ".information-toolbar button",
    "Manually reopen information beside workspace",
  );
  await capture("03-workspace-reopen-overlay", "overlay");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await until(
    () =>
      evaluate(
        "document.activeElement===document.querySelector('.information-toolbar button')&&!document.querySelector('.information-popover')",
      ),
    "Escape closes overlay and restores toggle focus",
  );
  await click(
    '.auxiliary-heading button[aria-label="Expand side panel"]',
    "Internally maximize workspace (not OS fullscreen)",
  );
  await click(
    '[data-tab-id="primary-conversation"] [role="tab"]',
    "Select the main-conversation workspace Tab",
  );
  await click(
    ".information-toolbar button",
    "Open information in maximized main conversation",
  );
  await capture("04-maximized-main-dock", "dock");
  assert.equal(result.cases.at(-1).geometry.composerIdentity, true);
  assert.equal(
    result.cases.at(-1).geometry.draft,
    "Synthetic draft must survive information and workspace toggles.",
  );
  nativeTheme.themeSource = "dark";
  await until(
    () => evaluate("document.documentElement.dataset.appearance==='dark'"),
    "actual app dark appearance",
  );
  await capture("05-maximized-main-dark", "dock");
  await click(
    '[data-tab-id="file:fixture.txt"] [role="tab"]',
    "Switch maximized workspace to its file resource",
  );
  await capture("06-resource-tab-closes-information", "closed");
  await click(
    '[data-tab-id="primary-conversation"] [role="tab"]',
    "Return to the main-conversation Tab",
  );
  window.setSize(1000, 820);
  await click(
    ".information-toolbar button",
    "Open information at narrow main-conversation width",
  );
  await capture("07-narrow-main-overlay", "overlay");
  await click(
    ".information-toolbar button",
    "Close narrow overlay with its own toggle",
  );
  await click(
    ".information-toolbar button",
    "Reopen narrow overlay repeatedly",
  );
  await capture("08-narrow-reopened", "overlay");
  await click(
    ".information-toolbar button",
    "Dismiss overlay before switching conversation",
  );
  window.setSize(1600, 1000);
  await click(
    ".information-toolbar button",
    "Reopen before switching conversation",
  );
  await click(
    '.thread-row-shell[data-thread-id="information-other"] > button.thread-row',
    "Switch to a different synthetic conversation",
  );
  await capture("09-switch-owner-closed", "closed");
  await click(
    ".information-toolbar button",
    "Open second conversation information",
  );
  await capture("10-second-owner", "dock");
  assert.ok(
    !(await evaluate(
      "document.querySelector('.information-content')?.textContent.includes('Daily synthetic review')",
    )),
    "facts never bleed across owners",
  );
  await click(main, "Return to the original owner");
  await until(
    () =>
      evaluate(
        "document.querySelector('#thread-composer')?.value==='Synthetic draft must survive information and workspace toggles.'",
      ),
    "owner-scoped draft preserved",
  );
  await click(
    ".information-toolbar button",
    "Open original information for exact Trigger edit",
  );
  await click(
    '.information-trigger-list button[aria-label="Edit · Daily synthetic review"]',
    "Open exact Trigger editor without changing or executing it",
  );
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.trigger-editor')) || Boolean(document.querySelector('input[value=\"Daily synthetic review\"]'))",
      ),
    "real Trigger editor",
  );
  await screenshot("11-trigger-editor.png");
  await evaluate(
    `window.zenx.shellPanel.request({operation:'stop',threadId:'information-main',taskId:${JSON.stringify(taskId)}})`,
  );
  result.ok = true;
}
void import(pathToFileURL(path.join(__dirname, "../out/main/index.js")).href)
  .then(run)
  .catch(async (error) => {
    result.error = String(error.stack || error);
    console.error(result.error);
    if (window && !window.isDestroyed())
      try {
        await screenshot("failure.png");
      } catch {}
  })
  .finally(async () => {
    await fs.writeFile(
      path.join(directory, "acceptance.json"),
      JSON.stringify(result, null, 2),
    );
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
  });
