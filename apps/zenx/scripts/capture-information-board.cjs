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
  inputBoundaries: {
    pointer: "Electron native events with trusted DOM click acknowledgement",
    field: "Electron native Select All and insertText with exact UI readback",
    select:
      "production DOM input/change; native OS popup input is not accepted by this run",
  },
  steps: [],
  cases: [],
  blockedExternalRequests: 0,
};
let window, taskId;
let clickSequence = 0;
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
  await evaluate(
    `${query(selector)}.scrollIntoView({block:'center',inline:'nearest'})`,
  );
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
  const acknowledgedClick = ++clickSequence;
  await evaluate(
    `(()=>{const e=${query(selector)};e.addEventListener('click',event=>{if(event.isTrusted)window.__informationNativeClick=${acknowledgedClick}},{capture:true,once:true});return true})()`,
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
  // Posting native input is not an acknowledgement: a following IPC read can
  // otherwise observe pre-click idle before React starts the layout write.
  await until(
    () => evaluate(`window.__informationNativeClick===${acknowledgedClick}`),
    label + " trusted native click delivered",
  );
  result.steps.push(label);
}
async function pressKey(keyCode, label) {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  result.steps.push(label);
}
async function settledLayout() {
  await until(
    () =>
      evaluate(
        "!document.querySelector('[aria-label=\"Refresh information\"]')?.disabled",
      ),
    "native layout write settled",
  );
}
async function selectValue(selector, value, label) {
  // macOS's native select popup is outside webContents key dispatch. Exercise
  // the real controlled DOM select/change handler, not an OS menu, and record
  // this narrower input boundary. All subsequent Host/state checks are unchanged.
  await evaluate(
    `(()=>{const e=${query(selector)};if(!(e instanceof HTMLSelectElement)||e.disabled)throw Error('Unavailable select: '+${JSON.stringify(label)});const option=[...e.options].find(o=>o.value===${JSON.stringify(value)});if(!option||option.disabled)throw Error('Unavailable real option: '+${JSON.stringify(label)});e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height||!e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)))throw Error('Obscured select: '+${JSON.stringify(label)});e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
  );
  await until(
    () => evaluate(`${query(selector)}.value===${JSON.stringify(value)}`),
    label + " controlled DOM selection committed",
  );
  result.steps.push(label);
  (result.controlSelections ??= []).push({
    label,
    input: "real DOM select input/change; not native OS popup automation",
  });
  await settledLayout();
}
async function insertComposerText(text) {
  await until(
    () =>
      evaluate(
        "(()=>{const e=document.querySelector('#thread-composer');return e instanceof HTMLTextAreaElement && document.activeElement===e})()",
      ),
    "actual Composer has native focus before input",
  );
  await window.webContents.insertText(text);
  await until(
    () =>
      evaluate(
        "document.querySelector('#thread-composer')?.value === " +
          JSON.stringify(text),
      ),
    "actual Composer committed exact native input",
  );
}
async function replaceNativeFieldText(selector, text) {
  await click(selector, "Edit exact native field " + selector);
  await until(
    () =>
      evaluate(
        `(()=>{const e=${query(selector)};return document.activeElement===e&&typeof e?.selectionStart==='number'})()`,
      ),
    "owned field has native focus before replacement",
  );
  // Renderer key injection does not traverse macOS's application-menu
  // accelerator. Use Electron's native editing command, then observe the real
  // selection before inserting once. No DOM value or selection is assigned.
  window.webContents.selectAll();
  await until(
    () =>
      evaluate(
        `(()=>{const e=${query(selector)};return document.activeElement===e&&e.selectionStart===0&&e.selectionEnd===e.value.length})()`,
      ),
    "native Select All selected the complete owned field",
  );
  await window.webContents.insertText(text);
  await until(
    () => evaluate(`${query(selector)}.value===${JSON.stringify(text)}`),
    "native insertion committed the exact field value",
  );
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
    `(()=>{const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,display:c.display,visibility:c.visibility,color:c.color,background:c.backgroundColor}};return {chat:rect('.agent-surface'),composer:rect('#thread-composer'),card:rect('.information-dock'),popover:rect('.information-popover'),workspace:rect('.workspace'),resource:rect('.auxiliary-panel'),titlebar:rect('.window-titlebar-session'),resourceHeading:document.querySelector('.auxiliary-panel')?.dataset.open==='true'?rect('.auxiliary-heading'):null,informationToggle:rect('.information-toolbar button'),workspaceToggle:rect('.auxiliary-close-button'),expanded:document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded'),overflow:document.documentElement.scrollWidth>innerWidth,composerIdentity:window.__informationComposer===document.querySelector('#thread-composer'),draft:document.querySelector('#thread-composer')?.value}})()`,
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
    const visibleHeaders = [geometry.titlebar, geometry.resourceHeading].filter(
      (rect) => rect && rect.visibility !== "hidden" && rect.display !== "none",
    );
    assert.ok(
      visibleHeaders.every((rect) => geometry.card.top >= rect.bottom + 11),
      "card clears actual visible conversation/workspace headings on every platform",
    );
    assert.equal(
      await evaluate(
        "(()=>{const e=document.querySelector('.information-dock .information-settings-toolbar'),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()",
      ),
      true,
      "first card heading is not occluded by a higher titlebar layer",
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
  // Real runtime/model facade publication, not direct plugin storage or injected UI.
  const bodyProgram = `const decode=r=>{if(r.exitCode!==0)throw Error(r.output||'Tool failed');return r.structuredContent??JSON.parse(r.output)}; for (const address of ['default','board:acceptance-second']) { const observed=decode(await tools.zenx_board_read({view:'document',...(address==='default'?{}:{instanceKey:address})})); const saved=decode(await tools.zenx_board_put({snapshot:observed.snapshot,document:{id:'equal-authored-id',title:address==='default'?'Native first Board':'Native second Board',summary:'Synthetic same body ID and revision; independent address.',blocks:[{id:'field',kind:'field',field:'answer',label:'Native independent field'}],initialValues:{answer:address==='default'?'first saved value':'second saved value'},events:[],html:'<p>Identical isolated body</p>'}})); if(saved.applied!==true)throw Error('Unexpected body conflict'); } const sidebar=decode(await tools.zenx_self_control_sidebar_read({includeInformation:true})); const placed=decode(await tools.zenx_self_control_sidebar_update({snapshot:sidebar.snapshot,patch:{information:{operations:[{op:'add',type:'board',config:{instanceKey:'board:acceptance-second'}}]}}})); if(placed.applied!==true)throw Error('Unexpected layout conflict'); text('Synthetic native Board and layout publication complete');`;
  await click(
    "#thread-composer",
    "Author independent Boards through actual model tools",
  );
  await insertComposerText(
    "!tool run_code " + JSON.stringify({ code: bodyProgram }),
  );
  await click(
    ".composer-send-control > button.action-orb.send:not(:disabled)",
    "Publish two Boards and placement through actual Host",
  );
  await until(
    () =>
      evaluate(
        "window.zenx.plugins.executeCommand('zenx-board','ui',{operation:'read',owner:{kind:'thread',threadId:'information-main'},instanceKey:'board:acceptance-second'}).then(s=>s?.document?.title==='Native second Board')",
      ),
    "actual model-authored independent Board body",
  );
  await until(
    () =>
      evaluate(
        "window.zenx.threads.list().then(rows=>rows.find(row=>row.threadId==='information-main')?.status==='idle')",
      ),
    "real model publication Turn completed without blocking on the open question",
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
  await insertComposerText(command);
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
  await insertComposerText(
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
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.user-question-attention .user-question-card')) && Boolean(document.querySelector('.thread-asking-badge'))",
      ),
    "real unanswered question survived completed Turn and seed Host restart",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.information-trigger-list').closest('section').querySelector('header button')===null",
    ),
    true,
    "healthy trigger facts have no always-visible refresh control",
  );
  await click(
    '[aria-label="Pause trigger · Daily synthetic review"]',
    "Pause exact trigger through its native information switch",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('[aria-label=\"Enable trigger · Daily synthetic review\"]')?.getAttribute('aria-checked')==='false'",
      ),
    "authoritative pause readback",
  );
  await screenshot("01b-trigger-paused.png");
  await click(
    '[aria-label="Enable trigger · Daily synthetic review"]',
    "Resume exact trigger through its revision-bound native switch",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('[aria-label=\"Pause trigger · Daily synthetic review\"]')?.getAttribute('aria-checked')==='true'",
      ),
    "authoritative resume readback",
  );
  const switchFacts = await evaluate(
    "window.zenx.plugins.executeCommand('zenx-triggers','sidebar-facts')",
  );
  assert.equal(
    switchFacts.triggers.find((trigger) => trigger.id === active.id)?.active,
    true,
  );
  result.cases.push({
    name: "native-trigger-switches",
    pauseThenResume: true,
    currentFacts: switchFacts.triggers.filter(
      (trigger) => trigger.threadId === "information-main",
    ),
  });
  await screenshot("01c-trigger-resumed.png");
  const option =
    ".user-question-card:first-of-type .user-question-option:first-of-type";
  await click(
    option,
    "Select a full question option row using native pointer input",
  );
  assert.equal(
    await evaluate(`${query(option)}.querySelector('input').checked`),
    true,
  );
  assert.equal(await evaluate(`${query(option)}.dataset.selected`), "true");
  await pressKey(
    "Down",
    "Native radio Down selects the next option without submitting",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.user-question-card input[type=radio]:checked')?.closest('label').textContent.includes('Full suite later')",
      ),
    "native radio arrow selection",
  );
  assert.equal(
    await evaluate(
      "document.activeElement?.matches('input[type=radio]:checked')",
    ),
    true,
  );
  await screenshot("01d-radio-keyboard-focus.png");
  await pressKey(
    "Up",
    "Native radio Up restores the first option without submitting",
  );
  await until(
    () => evaluate(`${query(option)}.querySelector('input').checked`),
    "native radio reverse selection",
  );
  const questionText =
    ".user-question-card:first-of-type .user-question-text textarea";
  const emptyHeight = await evaluate(
    `${query(questionText)}.getBoundingClientRect().height`,
  );
  await replaceNativeFieldText(
    questionText,
    "Synthetic review notes.\nA second line.\nA third line.\nA fourth line.",
  );
  const questionSizing = await evaluate(
    `(()=>{const e=${query(questionText)};return {height:e.getBoundingClientRect().height,resize:getComputedStyle(e).resize,fieldSizing:getComputedStyle(e).fieldSizing}})()`,
  );
  assert.ok(
    questionSizing.height > emptyHeight,
    "question textarea grows from real multiline input",
  );
  assert.equal(questionSizing.resize, "none");
  result.cases.push({
    name: "native-question-full-row-and-growth",
    emptyHeight,
    ...questionSizing,
  });
  await screenshot("01d-full-row-question-multiline.png");
  await click(
    ".information-toolbar button",
    "Close information before a new foreground model question",
  );
  await click(
    "#thread-composer",
    "Retain native Composer focus during foreground question publication",
  );
  await until(
    () =>
      evaluate(
        "window.zenx.threads.list().then(rows=>rows.find(row=>row.threadId==='information-main')?.status==='idle')",
      ),
    "foreground actor idle before question publication",
  );
  const revealPrompt =
    "Synthetic new foreground question reveals information without stealing focus.";
  await evaluate(
    `window.zenx.protocol.request('turn/start',${JSON.stringify({
      threadId: "information-main",
      clientUserMessageId: "native-information-reveal",
      input: [
        {
          type: "text",
          text:
            "!tool ask_user_question " +
            JSON.stringify({
              questions: [
                {
                  id: "reveal",
                  prompt: revealPrompt,
                  multiSelect: true,
                  options: [
                    { id: "yes", label: "Keep the foreground draft" },
                    { id: "verify", label: "Verify native keyboard selection" },
                  ],
                },
              ],
            }),
        },
      ],
    })})`,
  );
  await until(
    () =>
      evaluate(
        `document.querySelector('.user-question-attention')?.textContent.includes(${JSON.stringify(revealPrompt)})`,
      ),
    "real new foreground question automatically reveals its hidden panel",
  );
  assert.equal(
    await evaluate(
      "document.activeElement===document.querySelector('#thread-composer')",
    ),
    true,
    "automatic reveal does not move native focus",
  );
  assert.equal(
    await evaluate("document.querySelector('#thread-composer').value"),
    "Synthetic draft must survive information and workspace toggles.",
  );
  await screenshot("01e-new-foreground-question-reveal.png");
  result.cases.push({
    name: "native-foreground-question-reveal",
    composerFocusRetained: true,
    draftRetained: true,
  });
  const checkbox = ".user-question-card input[type=checkbox]";
  await click(
    checkbox,
    "Select a native full-row checkbox without sending an answer",
  );
  await until(
    () => evaluate(`${query(checkbox)}.checked`),
    "native checkbox pointer checked",
  );
  await pressKey("Space", "Native Space toggles only the focused checkbox");
  await until(
    () => evaluate(`!${query(checkbox)}.checked`),
    "native checkbox Space unchecked",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.user-question-card input[type=checkbox]:checked').length",
    ),
    0,
  );
  await pressKey(
    "Space",
    "Native Space restores the focused checkbox selection",
  );
  await until(
    () => evaluate(`${query(checkbox)}.checked`),
    "native checkbox Space checked",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.user-question-card input[type=checkbox]:checked').length",
    ),
    1,
  );
  await screenshot("01f-checkbox-keyboard-focus.png");
  const keyboardSwitch =
    '[aria-label="Pause trigger · Daily synthetic review"]';
  await click(keyboardSwitch, "Focus native trigger switch and pause once");
  await until(
    () =>
      evaluate(
        "document.activeElement?.getAttribute('aria-checked')==='false' && document.activeElement.getAttribute('aria-disabled')!=='true' && !document.activeElement.disabled",
      ),
    "paused native trigger switch retains focus",
  );
  await pressKey("Space", "Native Space resumes the focused trigger switch");
  await until(
    () =>
      evaluate(
        "document.activeElement?.getAttribute('aria-checked')==='true' && document.activeElement.getAttribute('aria-disabled')!=='true' && !document.activeElement.disabled",
      ),
    "native switch keyboard resume confirmed",
  );
  await screenshot("01g-trigger-keyboard-focus.png");
  await click(
    '[aria-label="Customize information"]',
    "Customize actual information layout",
  );
  const observedBoards = await evaluate(
    "window.zenx.information.read({kind:'thread',id:'information-main'}).then(s=>s.layout.widgets.filter(w=>w.type==='board'))",
  );
  assert.equal(observedBoards.length, 2);
  const secondId = observedBoards.find(
    (widget) => widget.config.instanceKey === "board:acceptance-second",
  ).id;
  const row = (id) => `[data-widget-id=${JSON.stringify(id)}]`;
  await click(
    row(secondId) + ' button[aria-label="Move up · Board"]',
    "Reorder independent Board placement with native pointer",
  );
  await settledLayout();
  await screenshot("01a-native-customize.png");
  const count = await evaluate(
    "document.querySelectorAll('.information-widget[data-visible=true]').length",
  );
  for (let index = 0; index < count; index++) {
    await click(
      '.information-widget[data-visible="true"] .information-widget-actions button:nth-child(3)',
      "Hide customizable widget " + index,
    );
    await settledLayout();
  }
  await click(
    '[aria-label="Customize information"]',
    "Leave customization with every widget hidden",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.information-widget-body').length",
    ),
    0,
  );
  assert.ok(
    await evaluate(
      "Boolean(document.querySelector('.user-question-attention .user-question-card'))",
    ),
  );
  await screenshot("01b-native-all-hidden-asking-remains.png");
  result.cases.push({
    name: "native-unhideable-asking",
    source:
      "real default-on asynchronous question, completed seed Turn and seed Host shutdown before Desktop",
    allWidgetsHidden: true,
  });
  await click(
    '[aria-label="Customize information"]',
    "Restore layout through actual controls",
  );
  await click(
    ".information-add-controls > button:last-of-type",
    "Reset native layout without deleting extra bodies",
  );
  await settledLayout();
  await click(
    row(secondId) +
      ".information-widget .information-widget-actions button:nth-child(3)",
    "Show retained second Board after reset",
  );
  await settledLayout();
  await click(
    '[aria-label="Customize information"]',
    "Review independent native fields",
  );
  await until(
    () =>
      evaluate("document.querySelectorAll('.board-field input').length===2"),
    "two independent native Board fields",
  );
  await replaceNativeFieldText(
    row(secondId) + " .board-field input",
    "second native draft only",
  );
  await until(
    () =>
      evaluate(
        "window.zenx.plugins.executeCommand('zenx-board','ui',{operation:'read',owner:{kind:'thread',threadId:'information-main'},instanceKey:'board:acceptance-second'}).then(s=>s?.values?.answer==='second native draft only')",
      ),
    "second native draft saved",
  );
  assert.equal(
    await evaluate(
      "window.zenx.plugins.executeCommand('zenx-board','ui',{operation:'read',owner:{kind:'thread',threadId:'information-main'}}).then(s=>s.values.answer)",
    ),
    "first saved value",
  );
  await screenshot("01c-native-independent-fields.png");
  result.cases.push({
    name: "native-independent-bodies",
    sameAuthoredId: true,
    independentDrafts: true,
    modelPublication: true,
  });
  await click(
    '[aria-label="Customize information"]',
    "Remove only the second placement",
  );
  await click(
    row(secondId) + ' button[aria-label="Remove placement · Board"]',
    "Remove second placement without deleting its body",
  );
  await settledLayout();
  assert.equal(
    await evaluate(
      "window.zenx.plugins.executeCommand('zenx-board','ui',{operation:'read',owner:{kind:'thread',threadId:'information-main'},instanceKey:'board:acceptance-second'}).then(s=>s?.values?.answer)",
    ),
    "second native draft only",
  );
  await click(
    ".information-add-controls > button:last-of-type",
    "Restore standard provider layout",
  );
  await settledLayout();
  await click(
    '[aria-label="Customize information"]',
    "Return to information reading",
  );
  await evaluate("document.querySelector('.information-content').scrollTop=0");
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
  window.setSize(1600, 1000);
  await capture("08a-open-overlay-to-dock", "dock");
  assert.equal(result.cases.at(-1).geometry.composerIdentity, true);
  window.setSize(1000, 820);
  await capture("08b-open-dock-to-overlay", "overlay");
  // Native layout at our exact responsive boundary, not only a spacious window.
  window.setSize(1184, 820);
  await capture("08c-920px-allocation-dock", "dock");
  assert.equal(result.cases.at(-1).geometry.workspace.width, 920);
  assert.equal(result.cases.at(-1).geometry.chat.width, 556);
  assert.ok(result.cases.at(-1).geometry.composer.width >= 480);
  window.setSize(1183, 820);
  await capture("08d-919px-allocation-overlay", "overlay");
  assert.equal(result.cases.at(-1).geometry.workspace.width, 919);
  assert.equal(result.cases.at(-1).geometry.composerIdentity, true);
  assert.equal(
    result.cases.at(-1).geometry.draft,
    "Synthetic draft must survive information and workspace toggles.",
  );
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await until(
    () =>
      evaluate(
        "document.activeElement===document.querySelector('.information-toolbar button')&&!document.querySelector('.information-popover')",
      ),
    "resize-transition overlay retains controlled dismissal and focus return",
  );
  await click(
    ".information-toolbar button",
    "Reopen after presentation transition",
  );
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
  await capture("10a-original-owner-restored", "dock");
  assert.equal(
    await evaluate(
      "document.querySelector('.information-toolbar button').getAttribute('aria-expanded')",
    ),
    "true",
    "returning owner restores its remembered open panel",
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
  nativeTheme.themeSource = "light";
  await until(
    () => evaluate("document.documentElement.dataset.appearance==='light'"),
    "actual app light appearance for Room acceptance",
  );
  const nativeRoom = await evaluate(
    "window.zenx.plugins.executeCommand('zenx-rooms','create',{name:'Synthetic native Room',members:[{name:'Synthetic source',threadId:'information-main'},{name:'Synthetic reviewer',threadId:'information-child'}]})",
  );
  const nativePaw = await evaluate(
    "window.zenx.plugins.executeCommand('zenx-rooms','create-assistant',{name:'Synthetic native PAW',memberName:'Synthetic PAW member',operationId:'information-acceptance-paw',target:{kind:'existing',threadId:'information-other'}})",
  );
  const emptyRoom = await evaluate(
    "window.zenx.plugins.executeCommand('zenx-rooms','create',{name:'Synthetic native empty Room',members:[{name:'Temporary synthetic source',threadId:'information-child'}]})",
  );
  await evaluate(
    `window.zenx.plugins.executeCommand('zenx-rooms','remove-member',{roomId:${JSON.stringify(emptyRoom.id)},threadId:'information-child'})`,
  );
  const openRoom = async (room, title) => {
    await click(
      `.room-conversation-row[data-room-id=${JSON.stringify(room.id)}]`,
      title,
    );
    await until(
      () =>
        evaluate(
          `${query(`.room-conversation-row[data-room-id=${JSON.stringify(room.id)}]`)}?.getAttribute('aria-current')==='page'`,
        ),
      "actual Room navigation committed before toggling information",
    );
    if (
      !(await evaluate(
        `document.querySelector('.editable-information-panel')?.dataset.owner===${JSON.stringify("room:" + room.id)}`,
      ))
    )
      await click(
        ".information-toolbar button",
        "Open information owned by " + room.name,
      );
    await until(
      () =>
        evaluate(
          `document.querySelector('.editable-information-panel')?.dataset.owner===${JSON.stringify("room:" + room.id)}`,
        ),
      "actual Room information owner",
    );
  };
  await openRoom(nativeRoom, "Select ordinary Room in actual Sidebar");
  await click(
    '[aria-label="Customize information"]',
    "Choose a verified current Room member",
  );
  await selectValue(
    '[aria-label="Source member"]',
    "information-main",
    "Select actual Room source member",
  );
  await selectValue(
    '[aria-label="Component"]',
    "triggers",
    "Select admitted Trigger component",
  );
  await click(
    ".information-add-controls > button:first-of-type",
    "Add member-bound Trigger component",
  );
  await settledLayout();
  const ordinaryLayout = await evaluate(
    `window.zenx.information.read({kind:'room',id:${JSON.stringify(nativeRoom.id)}})`,
  );
  assert.deepEqual(
    ordinaryLayout.layout.widgets.find((widget) => widget.type === "triggers")
      .binding,
    { kind: "member", resourceThreadId: "information-main" },
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.information-content').textContent.includes('Daily synthetic review')",
      ),
    "actual member-owned Trigger facts",
  );
  await screenshot("12-native-room-member-layout.png");
  await click(
    '[aria-label="Customize information"]',
    "Leave Room layout settings before answering workspace questions",
  );
  const roomQuestions = (room, options) =>
    evaluate(
      `window.zenx.roomQuestions.request(${JSON.stringify({ method: "list", roomId: room.id, ...(options ? { options } : {}) })})`,
    );
  const roomBadge = (room) =>
    `.room-conversation-row[data-room-id=${JSON.stringify(room.id)}] .room-asking-badge`;
  const roomCard = (question) =>
    `[data-room-question-id=${JSON.stringify(question.id)}]`;
  let questionPublicationSequence = 0;
  const publishQuestion = async (threadId, prompt, room) => {
    await until(
      () =>
        evaluate(
          `window.zenx.threads.list().then(rows=>rows.find(row=>row.threadId===${JSON.stringify(threadId)})?.status==='idle')`,
        ),
      "publication actor's existing Turn completed",
    );
    await evaluate(
      `window.zenx.protocol.request('turn/start',${JSON.stringify({ threadId, clientUserMessageId: "native-question-" + ++questionPublicationSequence, input: [{ type: "text", text: "!tool ask_user_question " + JSON.stringify({ ...(room ? { roomId: room.id } : {}), questions: [{ id: "review", prompt, options: [{ id: "yes", label: "Yes" }] }] }) }] })})`,
    );
    if (room) {
      await until(
        () =>
          evaluate(
            `document.querySelector('.room-question-attention')?.textContent.includes(${JSON.stringify(prompt)})`,
          ),
        "real Host Room publication appears without selecting its member",
      );
      const page = await roomQuestions(room);
      const question = page.questions.find((question) =>
        question.specification.questions.some(
          (value) => value.prompt === prompt,
        ),
      );
      assert.ok(question, "actual Room journal publication readback");
      return question;
    }
    await until(
      () =>
        evaluate(
          `window.zenx.threads.list().then(rows=>(rows.find(row=>row.threadId===${JSON.stringify(threadId)})?.userQuestionSummary?.openCount??0)>0)`,
        ),
      "private Thread publication exists independently",
    );
  };
  assert.equal(
    (await roomQuestions(nativeRoom)).openCount,
    0,
    "existing private member question is not a Room question",
  );
  assert.equal(
    await evaluate(`Boolean(${query(roomBadge(nativeRoom))})`),
    false,
  );
  const roomFirst = await publishQuestion(
    "information-main",
    "Synthetic Room question from first member",
    nativeRoom,
  );
  const roomSecond = await publishQuestion(
    "information-child",
    "Synthetic Room question from another member",
    nativeRoom,
  );
  assert.equal((await roomQuestions(nativeRoom)).openCount, 2);
  await until(
    () =>
      evaluate(
        `${query(roomBadge(nativeRoom))}?.getAttribute('aria-label').includes('2')`,
      ),
    "Room Asking counts its two journal requests only",
  );
  await click(
    '[aria-label="Customize information"]',
    "Hide all customizable Room widgets",
  );
  const visibleRoomWidgets = await evaluate(
    "document.querySelectorAll('.information-widget[data-visible=true]').length",
  );
  for (let index = 0; index < visibleRoomWidgets; index++) {
    await click(
      '.information-widget[data-visible="true"] .information-widget-actions button:nth-child(3)',
      "Hide Room widget " + index,
    );
    await settledLayout();
  }
  await click(
    '[aria-label="Customize information"]',
    "Keep Room questions outside hidden widgets",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.information-widget-body').length",
    ),
    0,
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.room-question-card').length"),
    2,
  );
  await screenshot("12a-native-room-workspace-two-questions.png");
  await evaluate(
    `window.zenx.plugins.executeCommand('zenx-rooms','remove-member',{roomId:${JSON.stringify(nativeRoom.id)},threadId:'information-main'})`,
  );
  await until(
    () => evaluate(`Boolean(${query(roomCard(roomFirst))})`),
    "author removal retains the Room resource",
  );
  await click(
    roomCard(roomFirst) + ' input[type="radio"]',
    "Choose answer for the Room-owned question",
  );
  await click(
    roomCard(roomFirst) + " .primary-button",
    "Save Room answer without choosing a member",
  );
  await until(
    async () => (await roomQuestions(nativeRoom)).openCount === 1,
    "one Room question remains open after answer",
  );
  await until(
    () =>
      evaluate(
        `${query(roomBadge(nativeRoom))}?.getAttribute('aria-label').includes('1')`,
      ),
    "Asking remains for the other Room request",
  );
  await until(
    () => evaluate(`!${query(roomCard(roomFirst))}`),
    "answered Room card acknowledged and removed before capture",
  );
  await screenshot("12b-native-room-partial-answer-asking-remains.png");
  await click(
    roomCard(roomSecond) + " .user-question-actions .quiet-button",
    "Cancel the remaining Room request explicitly",
  );
  await until(
    async () => (await roomQuestions(nativeRoom)).openCount === 0,
    "all Room requests resolved",
  );
  await until(
    () => evaluate(`!${query(roomBadge(nativeRoom))}`),
    "Room Asking disappears only after its last open question",
  );
  const withdrawQuestion = await publishQuestion(
    "information-child",
    "Synthetic Room request for explicit model withdrawal",
    nativeRoom,
  );
  const withdrawProgram = `const decode=r=>{if(r.exitCode!==0)throw Error(r.output||'Tool failed');return r.structuredContent??JSON.parse(r.output)};let room;for(let cursor=0;;){const page=decode(await tools.zenx_rooms_list({cursor}));room=page.rooms.find(value=>value.name==='Synthetic native Room');if(room||page.nextCursor==null)break;cursor=page.nextCursor;}if(!room)throw Error('Room not found');const page=decode(await tools.zenx_rooms_questions({room:room.ref}));const q=page.questions.find(value=>value.specification.questions.some(value=>value.prompt==='Synthetic Room request for explicit model withdrawal'));if(!q)throw Error('Question not found');const result=decode(await tools.zenx_rooms_withdraw_question({question:q.ref}));if(result.state!=='withdrawn')throw Error('Withdrawal not confirmed');text('Synthetic Room question explicitly withdrawn');`;
  await until(
    () =>
      evaluate(
        "window.zenx.threads.list().then(rows=>rows.find(row=>row.threadId==='information-child')?.status==='idle')",
      ),
    "publication Turn finished before the separate explicit withdrawal",
  );
  await evaluate(
    `window.zenx.protocol.request('turn/start',${JSON.stringify({ threadId: "information-child", clientUserMessageId: "native-room-question-withdraw", input: [{ type: "text", text: "!tool run_code " + JSON.stringify({ code: withdrawProgram }) }] })})`,
  );
  await until(
    async () =>
      (await roomQuestions(nativeRoom, { includeClosed: true })).questions.find(
        (question) => question.id === withdrawQuestion.id,
      )?.state === "withdrawn",
    "actual model Room snapshot withdrawal persisted",
  );
  await until(
    () => evaluate(`!${query(roomBadge(nativeRoom))}`),
    "withdrawal updates the same Room Asking projection",
  );
  await screenshot("12c-native-room-resolved-and-withdrawn.png");
  result.cases.push({
    name: "native-ordinary-room",
    owner: ordinaryLayout.owner,
    memberBound: true,
    independentWorkspaceQuestions: true,
    privateThreadQuestionsExcluded: true,
    removedAuthorQuestionRetained: true,
    partialAnswerKeepsAsking: true,
    lastCancelClearsAsking: true,
    actualModelSnapshotWithdrawal: true,
  });
  await openRoom(nativePaw, "Select PAW's actual Room in Sidebar");
  const pawLayout = await evaluate(
    `window.zenx.information.read({kind:'room',id:${JSON.stringify(nativePaw.id)}})`,
  );
  assert.deepEqual(pawLayout.owner, { kind: "room", id: nativePaw.id });
  assert.equal(pawLayout.resourceThreadId, "information-other");
  assert.ok(
    pawLayout.layout.widgets
      .filter((widget) => widget.binding.kind === "member")
      .every(
        (widget) => widget.binding.resourceThreadId === "information-other",
      ),
  );
  await screenshot("13-native-paw-actual-room.png");
  await publishQuestion(
    "information-other",
    "Synthetic private PAW Thread question only",
  );
  assert.equal(
    (await roomQuestions(nativePaw)).openCount,
    0,
    "single-member PAW does not aggregate private Thread questions",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.information-content')?.textContent.includes('Synthetic private PAW Thread question only')",
    ),
    false,
    "PAW information does not display the member's private question",
  );
  const pawQuestion = await publishQuestion(
    "information-other",
    "Synthetic independent PAW workspace question",
    nativePaw,
  );
  await until(
    () => evaluate(`Boolean(${query(roomBadge(nativePaw))})`),
    "PAW Asking follows its own Room question",
  );
  await screenshot("13a-native-independent-paw-question.png");
  await click(
    roomCard(pawQuestion) + " .user-question-actions .quiet-button",
    "Cancel PAW Room request without changing its private Thread question",
  );
  await until(
    () => evaluate(`!${query(roomBadge(nativePaw))}`),
    "PAW workspace Asking clears independently",
  );
  await until(
    () => evaluate(`!${query(roomCard(pawQuestion))}`),
    "cancelled PAW card acknowledged and removed before capture",
  );
  await screenshot("13b-native-paw-room-resolved-private-thread-pending.png");
  result.cases.push({
    name: "native-paw-room",
    owner: pawLayout.owner,
    actualAssistant: "information-other",
    thirdOwner: false,
    privateThreadQuestionExcluded: true,
    independentRoomQuestionCancelled: true,
  });
  await openRoom(emptyRoom, "Select actual empty Room in Sidebar");
  await click(
    '[aria-label="Customize information"]',
    "Inspect empty Room source options",
  );
  const emptyLayout = await evaluate(
    `window.zenx.information.read({kind:'room',id:${JSON.stringify(emptyRoom.id)}})`,
  );
  assert.deepEqual(emptyLayout.members, []);
  assert.equal(emptyLayout.resourceThreadId, undefined);
  assert.ok(
    emptyLayout.layout.widgets.every(
      (widget) => widget.binding.kind === "owner",
    ),
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[aria-label=\"Source member\"]').options.length",
    ),
    1,
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.user-question-card').length"),
    0,
    "empty Room cannot borrow a stale private Thread question",
  );
  await screenshot("14-native-empty-room-no-invented-member.png");
  result.cases.push({
    name: "native-empty-room",
    owner: emptyLayout.owner,
    noInventedMember: true,
  });
  await evaluate(
    `window.zenx.shellPanel.request({operation:'stop',threadId:'information-main',taskId:${JSON.stringify(taskId)}})`,
  );
  await click(main, "Return to main owner after its background command ended");
  if (
    await evaluate(
      "document.querySelector('.information-toolbar button').getAttribute('aria-expanded')==='false'",
    )
  )
    await click(
      ".information-toolbar button",
      "Open information to inspect ended command removal",
    );
  await until(
    () =>
      evaluate(
        "document.querySelector('.background-shell-list')===null && document.querySelector('.background-shell-status')?.textContent.includes('No background commands')",
      ),
    "ended command no longer appears as live work",
  );
  await screenshot("15-ended-command-removed.png");
  result.cases.push({
    name: "native-ended-command-removal",
    endedCommandAbsent: true,
  });
  // Exercise the production language preference receiver with a synthetic
  // same-origin preference event; this is not a native Settings-menu claim.
  await evaluate(
    "(()=>{localStorage.setItem('zenx.language','zh-CN');dispatchEvent(new StorageEvent('storage',{key:'zenx.language',newValue:'zh-CN',storageArea:localStorage}));return true})()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.information-content')?.textContent.includes('子对话')",
      ),
    "production Chinese child-conversation terminology",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.information-content').textContent.includes('子 Agent')",
    ),
    false,
  );
  await screenshot("16-chinese-child-conversations.png");
  result.cases.push({
    name: "chinese-child-conversations",
    languageInput:
      "production preference receiver with synthetic same-origin storage event",
  });
  result.ok = true;
}
void import(pathToFileURL(path.join(__dirname, "../out/main/index.js")).href)
  .then(run)
  .catch(async (error) => {
    result.error = String(error.stack || error);
    console.error(result.error);
    if (window && !window.isDestroyed())
      try {
        result.inputFailureState = {
          windowFocused: window.isFocused(),
          webContentsFocused: window.webContents.isFocused(),
          renderer: await evaluate(
            "(()=>{const e=document.querySelector('#thread-composer'),a=document.activeElement;return {activeTag:a?.tagName,activeId:a?.id,composerExists:Boolean(e),composerDisabled:e?.disabled,composerValue:e?.value,hasComposerFocus:a===e,visibilityState:document.visibilityState,documentFocused:document.hasFocus()}})()",
          ),
        };
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
