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
    pointer:
      "Electron sendInputEvent with trusted DOM acknowledgement, not OS non-client hit-testing; systemSidebarClicks separately use production bound Computer CoreGraphics input",
    field: "Electron native Select All and insertText with exact UI readback",
    select:
      "production DOM input/change; native OS popup input is not accepted by this run",
  },
  steps: [],
  cases: [],
  blockedExternalRequests: 0,
};
let window, taskId, ownedSidebarInput;
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
async function resizeWindow(width, height) {
  window.setSize(width, height);
  // setSize returns before Chromium necessarily consumes the native resize.
  // Do not locate or dispatch the next input against the previous width.
  await until(async () => {
    const [outerWidth] = window.getSize();
    const [contentWidth] = window.getContentSize();
    // macOS may constrain the requested height to its visible screen. This
    // barrier owns horizontal hit coordinates, not an OS height guarantee.
    if (outerWidth !== width) return false;
    return evaluate(`window.innerWidth === ${contentWidth}`);
  }, "native resize delivered to renderer");
}
async function click(
  selector,
  label = selector,
  systemPointer = false,
  scrollTarget = true,
) {
  window.show();
  window.focus();
  window.webContents.focus();
  await until(
    async () => window.isFocused() && window.webContents.isFocused(),
    "owned window focus",
  );
  const acknowledgedClick = ++clickSequence;
  let point;
  // Renderer refresh can replace a control between separate evaluations. Locate,
  // validate and arm the same element atomically, after focus has settled. Only
  // missing pre-dispatch targets may wait; unknown dispatched input never retries.
  await until(async () => {
    point = await evaluate(
      `(()=>{const e=${query(selector)};if(!e)return null;if(${scrollTarget})e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(e.disabled||!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Obscured/disabled native target: '+${JSON.stringify(label)}+' '+JSON.stringify({r:{x:r.x,y:r.y,width:r.width,height:r.height},hits:document.elementsFromPoint(x,y).map(n=>n.className).slice(0,5)}));e.addEventListener('click',event=>{if(event.isTrusted)window.__informationNativeClick=${acknowledgedClick}},{capture:true,once:true});return {x:Math.round(x),y:Math.round(y)}})()`,
    );
    return point !== null;
  }, label + " target prepared before input");
  if (systemPointer) {
    const receipt = await ownedSidebarInput.click(window, point);
    (result.systemSidebarClicks ??= []).push({
      label,
      receipt,
      input: "production Computer exact PID/CG/AX bound CoreGraphics events",
    });
  } else {
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
  }
  // Posting native input is not an acknowledgement: a following IPC read can
  // otherwise observe pre-click idle before React starts the layout write.
  await until(
    () => evaluate(`window.__informationNativeClick===${acknowledgedClick}`),
    label +
      (systemPointer
        ? " trusted OS click delivered"
        : " trusted Chromium click delivered"),
  );
  result.steps.push(label);
}
async function pressKey(keyCode, label) {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  result.steps.push(label);
}
async function verifyInformationOsInput() {
  result.informationOsInput = { status: "running", permissionChanges: false };
  await resizeWindow(1600, 1000);
  await click(
    '[data-tab-id="primary-conversation"] [role="tab"]',
    "Select maximized main conversation with actual OS pointer",
    true,
  );
  for (let repeat = 0; repeat < 2; repeat++) {
    await click(
      ".information-toolbar button",
      "Open maximized main information with actual OS pointer",
      true,
    );
    await capture(`16-${repeat}-os-main-information`, "overlay");
    await click(
      ".information-toolbar button",
      "Close maximized main information with actual OS pointer",
      true,
    );
    await capture(`16-${repeat}-os-main-information-closed`, "closed");
  }
  await click(
    '.auxiliary-heading button[aria-label="Restore side panel"]',
    "Restore split workspace for actual OS information pointer",
    true,
  );
  await resizeWindow(1440, 1000);
  for (let repeat = 0; repeat < 2; repeat++) {
    await click(
      ".information-toolbar button",
      "Reopen information beside split workspace with actual OS pointer",
      true,
    );
    await capture(`17-${repeat}-os-split-information`, "overlay");
    await click(
      ".information-toolbar button",
      "Close split information with actual OS pointer",
      true,
    );
    await capture(`17-${repeat}-os-split-information-closed`, "closed");
  }
  result.informationOsInput = {
    status: "passed",
    permissionChanges: false,
    repeatedMaximizedMainToggle: true,
    repeatedSplitOverlayToggle: true,
  };
}
async function focusWithNativeTab(selector, label) {
  for (let index = 0; index < 160; index++) {
    if (await evaluate(`document.activeElement===${query(selector)}`)) {
      result.steps.push(label);
      return;
    }
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await pause(35);
  }
  throw Error("Native Tab could not reach: " + label);
}
async function settledLayout() {
  await until(
    () =>
      evaluate(
        "document.querySelector('.editable-information-panel')?.dataset.busy==='false'",
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
async function settleScreenshotFrame() {
  // DOM acknowledgement can precede the compositor's visible frame on macOS.
  // Allow the asserted native state to paint without mutating focus or inputs.
  await evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  await pause(100);
}
async function screenshot(name) {
  await settleScreenshotFrame();
  await fs.writeFile(
    path.join(directory, name),
    (await window.webContents.capturePage()).toPNG(),
  );
}
// Check the known title without changing the screenshot's current reading position.
// Earlier interactions may intentionally have scrolled it above the card viewport.
async function inspectInformationHeading(selector) {
  return evaluate(`(()=>{
    const e=document.querySelector(${JSON.stringify(selector)});
    if(!e)throw Error('Missing information heading');
    const ancestors=[];
    for(let p=e.parentElement;p;p=p.parentElement) ancestors.push({node:p,top:p.scrollTop,left:p.scrollLeft});
    const before=e.getBoundingClientRect();
    let observation;
    try {
      e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      observation={text:e.textContent,top:r.top,bottom:r.bottom,originalTop:before.top,hitClass:hit?.className,unoccluded:e.contains(hit)};
    } finally {
      for(const {node,top,left} of ancestors) node.scrollTo({top,left,behavior:'instant'});
    }
    observation.scrollRestored=ancestors.every(({node,top,left})=>node.scrollTop===top&&node.scrollLeft===left);
    return observation;
  })()`);
}
// Read a stable user-authored anchor, not the active Turn's changing timer/body.
async function informationReadingSnapshot() {
  return evaluate(`(()=>{
    const scroll=document.querySelector('.thread-view .messages');
    const anchor=window.__informationReadingAnchor;
    if(!scroll || !anchor?.isConnected) throw Error('Missing controlled reading anchor');
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    return {scrollTop:scroll.scrollTop,maxTop:scroll.scrollHeight-scroll.clientHeight,
      viewport:rect(scroll),anchor:rect(anchor),
      id:anchor.closest('[data-sent-message-id]').dataset.sentMessageId,
      text:anchor.textContent,window:{width:innerWidth,height:innerHeight}};
  })()`);
}
async function prepareInformationReadingCamera() {
  const prepared = await evaluate(`(()=>{
    const scroll=document.querySelector('.thread-view .messages');
    const r=scroll.getBoundingClientRect();
    window.__informationReadingWheel=null;
    scroll.addEventListener('wheel',e=>{window.__informationReadingWheel={trusted:e.isTrusted,deltaY:e.deltaY}}, {once:true});
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/3),scrollTop:scroll.scrollTop};
  })()`);
  window.webContents.sendInputEvent({
    type: "mouseWheel",
    x: prepared.x,
    y: prepared.y,
    deltaX: 0,
    deltaY: 320,
    canScroll: true,
    hasPreciseScrollingDeltas: true,
  });
  await until(
    () =>
      evaluate(
        `(()=>{const s=document.querySelector('.thread-view .messages'),w=window.__informationReadingWheel;return w?.trusted&&w.deltaY<0&&s.scrollTop<${prepared.scrollTop}&&s.scrollHeight-s.clientHeight-s.scrollTop>100})()`,
      ),
    "native wheel pauses tail following and moves to earlier reading",
  );
  await evaluate(`(()=>{
    const scroll=document.querySelector('.thread-view .messages'),r=scroll.getBoundingClientRect();
    const bottom=document.querySelector('.bottom-zone').getBoundingClientRect().top;
    window.__informationReadingAnchor=[...scroll.querySelectorAll('[data-sent-message-id] .user-bubble')].find(e=>{const a=e.getBoundingClientRect();return a.bottom>r.top+40&&a.top<bottom-40});
    if(!window.__informationReadingAnchor) throw Error('No visible named user message for controlled camera');
    return true;
  })()`);
  let previous;
  let stable = 0;
  result.readingCamera = {
    input: "trusted Electron native wheel; no DOM scroll assignment",
    wheel: await evaluate("window.__informationReadingWheel"),
    samples: [],
  };
  await until(async () => {
    const sample = await informationReadingSnapshot();
    result.readingCamera.samples.push(sample);
    // This is an observed non-tail anchor barrier, not an assumed sleep. New
    // rows may arrive below it; maxTop is therefore diagnostic, not frozen.
    const signature = JSON.stringify({ ...sample, maxTop: undefined });
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    return stable >= 2 && sample.maxTop - sample.scrollTop > 100;
  }, "same visible reading anchor and viewport across consecutive observations");
  result.readingCamera.before = await informationReadingSnapshot();
}
function assertInformationReadingUnchanged(before, after, shift) {
  assert.deepEqual(
    after.window,
    before.window,
    "opening Information preserves viewport dimensions",
  );
  assert.deepEqual(
    after.viewport,
    before.viewport,
    "opening Information preserves transcript scrollport",
  );
  assert.equal(
    after.scrollTop,
    before.scrollTop,
    "opening Information preserves explicit non-tail scrollTop",
  );
  assert.equal(after.id, before.id, "same named visible message");
  assert.equal(after.text, before.text, "same immutable user message contents");
  for (const edge of ["top", "bottom", "width", "height"])
    assert.equal(
      after.anchor[edge],
      before.anchor[edge],
      `opening Information preserves anchor.${edge}`,
    );
  for (const edge of ["left", "right"])
    assert.ok(
      Math.abs(before.anchor[edge] - after.anchor[edge] - shift) <= 0.5,
      `anchor.${edge} follows measured lane`,
    );
}
// The fit is based on actual DOM coordinates, not a fixed window breakpoint.
function informationFitProbe({ left, right, width, viewportLeft }) {
  const shift = Math.max(0, left + width + 16 - (right - 320));
  return { shift, clearance: left - shift - viewportLeft - 24 };
}
async function captureInformationFitBoundary() {
  const originalSize = window.getSize();
  const original = await informationReadingSnapshot();
  const measure = () =>
    evaluate(`(()=>{
    const view=document.querySelector('.thread-view'),column=view.querySelector('.virtual-transcript-header, .messages-inner'),toolbar=document.querySelector('.information-toolbar');
    const r=column.getBoundingClientRect(),composer=document.querySelector('#thread-composer');
    return {left:r.left,right:Number(toolbar.dataset.clearanceRight),width:r.width,viewportLeft:view.getBoundingClientRect().left,
      resourceOpen:document.querySelector('.auxiliary-panel')?.dataset.open==='true',lane:view.dataset.informationLane==='true',
      draft:composer.value,composerIdentity:composer===window.__informationComposer};
  })()`);
  await click(
    ".information-toolbar button",
    "Close Information before measured fit-boundary camera",
  );
  await until(
    () =>
      evaluate(
        "!document.querySelector('.information-popover') && document.querySelector('.thread-view')?.dataset.informationLane!=='true'",
      ),
    "Information closed for boundary measurement",
  );
  const initial = await measure();
  assert.equal(
    initial.resourceOpen,
    false,
    "fit-boundary camera must keep right workspace closed",
  );
  const boundary = Math.round(
    originalSize[0] -
      (initial.right - initial.viewportLeft - initial.width - 360),
  );
  result.fitBoundary = { originalSize, boundary, initial, cases: [] };
  for (const [suffix, delta, fits] of [
    ["fits", 2, true],
    ["floats", -2, false],
  ]) {
    await resizeWindow(boundary + delta, originalSize[1]);
    await evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    const closed = await measure();
    const probe = informationFitProbe(closed);
    const receipt = { suffix, closed, probe };
    result.fitBoundary.cases.push(receipt);
    assert.equal(closed.resourceOpen, false);
    assert.equal(
      probe.clearance >= 0,
      fits,
      "measured DOM must straddle the actual fit threshold",
    );
    const before = await informationReadingSnapshot();
    assert.equal(
      before.id,
      original.id,
      "resize retains the same paused message",
    );
    assert.equal(before.text, original.text);
    assert.equal(
      before.anchor.width,
      original.anchor.width,
      "boundary camera does not rewrap the anchor",
    );
    assert.ok(
      before.anchor.bottom > before.viewport.top &&
        before.anchor.top < before.viewport.bottom,
      "same anchor remains visible",
    );
    Object.assign(receipt, { before });
    await screenshot(`01a-${suffix}-closed.png`);
    await click(
      ".information-toolbar button",
      `Open Information at measured ${suffix} width`,
    );
    await capture(`01a-${suffix}-open`, "overlay");
    const opened = await measure();
    const after = await informationReadingSnapshot();
    Object.assign(receipt, { opened, after });
    assert.equal(
      opened.lane,
      fits,
      "presentation follows measured fit, not split-pane fallback",
    );
    assert.equal(opened.resourceOpen, false);
    assert.equal(opened.draft, closed.draft);
    assert.equal(opened.composerIdentity, true);
    assertInformationReadingUnchanged(before, after, fits ? probe.shift : 0);
    await click(
      ".information-toolbar button",
      `Close measured ${suffix} camera`,
    );
    await until(
      () =>
        evaluate(
          "!document.querySelector('.information-popover') && document.querySelector('.thread-view')?.dataset.informationLane!=='true'",
        ),
      "boundary card closed",
    );
  }
  await resizeWindow(...originalSize);
  await click(
    ".information-toolbar button",
    "Restore original wide Information camera",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.thread-view')?.dataset.informationLane==='true'",
      ),
    "original fitted lane restored",
  );
}
async function capture(name, mode) {
  await until(
    () =>
      evaluate(
        `Boolean(document.querySelector(${JSON.stringify(mode === "overlay" ? ".information-popover" : ".information-toolbar button[aria-pressed=false]")}))`,
      ),
    name + " presentation",
  );
  await pause(250);
  const geometry = await evaluate(
    `(()=>{const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,display:c.display,visibility:c.visibility,color:c.color,background:c.backgroundColor}};return {reading:rect('.thread-view .virtual-transcript-header, .thread-view .messages-inner'),lane:document.querySelector('.thread-view')?.dataset.informationLane==='true',shift:parseFloat(document.querySelector('.thread-view')?.style.getPropertyValue('--information-reading-shift')||'0'),resourceOpen:document.querySelector('.auxiliary-panel')?.dataset.open==='true',chat:rect('.agent-surface'),composer:rect('#thread-composer'),composerShell:rect('.bottom-zone > .composer'),commandStrip:rect('.bottom-zone > .background-shell-status'),card:rect('.information-popover'),popoverCount:document.querySelectorAll('.information-popover').length,legacyDockCount:document.querySelectorAll('.information-dock').length,popover:rect('.information-popover'),workspace:rect('.workspace'),resource:rect('.auxiliary-panel'),titlebar:rect('.window-titlebar-session'),resourceHeading:document.querySelector('.auxiliary-panel')?.dataset.open==='true'?rect('.auxiliary-heading'):null,resourceExpanded:document.querySelector('.auxiliary-panel')?.dataset.expanded,primaryActive:document.querySelector('.auxiliary-panel')?.dataset.primaryActive,informationSlot:rect('.auxiliary-information-slot'),informationEntryHidden:document.querySelector('.information-toolbar')?.hidden,informationToggle:rect('.information-toolbar button'),workspaceToggle:rect('.auxiliary-close-button'),expanded:document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded'),overflow:document.documentElement.scrollWidth>innerWidth,composerIdentity:window.__informationComposer===document.querySelector('#thread-composer'),draft:document.querySelector('#thread-composer')?.value}})()`,
  );
  if (mode === "overlay") {
    assert.equal(
      geometry.popoverCount,
      1,
      "exactly one floating Information card",
    );
    assert.equal(geometry.legacyDockCount, 0, "no reserved information dock");
    assert.ok(
      geometry.card.width > 0 && geometry.card.width <= 341,
      "floating card is bounded to 340px",
    );
    assert.ok(
      geometry.card.left >= geometry.chat.left + 11,
      "card stays inside conversation leading clearance",
    );
    assert.ok(
      Math.abs(geometry.card.right - (geometry.chat.right - 12)) <= 1,
      "card follows conversation trailing edge",
    );
    assert.ok(
      geometry.card.bottom <= geometry.workspace.bottom + 1,
      "card remains within workspace height",
    );
    assert.ok(
      geometry.card.top >= geometry.informationToggle.bottom,
      "card sits below chat controls",
    );
    if (geometry.resourceHeading && geometry.resourceExpanded === "false") {
      assert.ok(
        geometry.card.right <= geometry.resource.left,
        "split resource remains outside the card",
      );
      assert.ok(
        Math.abs(geometry.chat.right - geometry.resource.left) <= 1,
        "no third column beside split conversation",
      );
    } else {
      assert.ok(
        Math.abs(geometry.chat.right - geometry.workspace.right) <= 1,
        "floating information reserves no conversation width",
      );
    }
    // Accepted questions are above component settings. With multiple questions,
    // the settings toolbar is legitimately below the fold, not occluded.
    // Check the first real heading in DOM order and retain the hit-test evidence.
    geometry.firstCardHeading = await inspectInformationHeading(
      ".information-popover .user-question-attention > header, .information-popover .room-question-attention > header, .information-popover .information-settings-toolbar",
    );
    assert.equal(
      geometry.firstCardHeading.scrollRestored,
      true,
      "heading check restores every scroll position",
    );
    assert.equal(
      geometry.firstCardHeading.unoccluded,
      true,
      "first card heading is not occluded by a higher titlebar layer: " +
        JSON.stringify(geometry.firstCardHeading),
    );
  }
  const resizeState = await evaluate(
    "(()=>{const p=document.querySelector('.auxiliary-panel[data-open=true][data-expanded=true]');if(!p)return null;const e=p.querySelector(':scope > .browser-panel-resizer');const prior=document.activeElement;e.focus({preventScroll:true});return {display:getComputedStyle(e).display,rects:e.getClientRects().length,focusable:document.activeElement===e,focusUnchanged:document.activeElement===prior}})()",
  );
  if (resizeState) {
    assert.equal(
      resizeState.display,
      "none",
      "Fullscreen workspace hides the split-width resizer",
    );
    assert.equal(
      resizeState.rects,
      0,
      "Fullscreen split resizer has no interactive layout box",
    );
    assert.equal(
      resizeState.focusable,
      false,
      "Fullscreen split resizer cannot take focus",
    );
    assert.equal(resizeState.focusUnchanged, true);
    result.fullscreenSplitResizer = resizeState;
  }
  if (mode === "closed") {
    assert.equal(
      geometry.popoverCount,
      0,
      "closed information has no floating card",
    );
    assert.equal(geometry.legacyDockCount, 0);
    if (
      geometry.resourceExpanded === "true" &&
      geometry.primaryActive !== "true"
    )
      assert.equal(
        geometry.informationEntryHidden,
        true,
        "resource-only fullscreen has no Information entry",
      );
  }
  assert.equal(geometry.overflow, false, "no page-level horizontal overflow");
  if (mode !== "closed") {
    assert.equal(geometry.expanded, "true");
    assert.equal(geometry.informationEntryHidden, false);
    if (geometry.resourceHeading && geometry.resourceExpanded === "false") {
      assert.ok(
        Math.abs(
          geometry.informationToggle.right -
            (geometry.resourceHeading.left - 8),
        ) <= 1,
        "split information entry belongs at the main conversation edge, not inside resource controls",
      );
      assert.equal(
        geometry.informationSlot.width,
        0,
        "split resource controls have no information slot",
      );
      assert.ok(
        geometry.informationToggle.left >= geometry.titlebar.left &&
          geometry.informationToggle.right <= geometry.titlebar.right &&
          geometry.informationToggle.top >= geometry.titlebar.top &&
          geometry.informationToggle.bottom <= geometry.titlebar.bottom,
        "split information entry remains in its own conversation title row",
      );
    }
    if (geometry.resourceExpanded === "true") {
      assert.equal(geometry.primaryActive, "true");
      const slot = geometry.informationSlot,
        button = geometry.informationToggle;
      assert.ok(
        slot.width > 0 &&
          slot.left <= button.left + 1 &&
          slot.right >= button.right - 1 &&
          slot.top <= button.top + 1 &&
          slot.bottom >= button.bottom - 1,
        "maximized main title row excludes the whole native information hit target",
      );
    }
  }
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
  if (geometry.lane) {
    assert.equal(mode, "overlay", "lane requires an open Information card");
    assert.ok(
      !geometry.resourceOpen ||
        (geometry.resourceExpanded === "true" &&
          geometry.primaryActive === "true"),
      "lane never moves a conversation with an adjacent resource",
    );
    assert.ok(geometry.reading, "lane measures the real reading column");
    assert.ok(
      geometry.card.left - geometry.reading.right >= 15.5,
      "Information lane leaves at least 16px reading clearance (0.5px rounding tolerance)",
    );
    assert.ok(
      geometry.reading.left >= geometry.chat.left + 23.5,
      "lane retains the conversation leading gutter",
    );
  } else {
    assert.equal(
      geometry.shift,
      0,
      "floating fallback never displaces the reading column",
    );
  }
  if (name.startsWith("01-")) {
    assert.ok(
      geometry.composerShell && geometry.commandStrip,
      "wide camera includes the active background command strip",
    );
    for (const edge of ["left", "right"])
      assert.ok(
        Math.abs(geometry.commandStrip[edge] - geometry.composerShell[edge]) <=
          0.5,
        `background command strip shares Composer.${edge}`,
      );
    const after = await informationReadingSnapshot();
    result.readingCamera.after = after;
    assertInformationReadingUnchanged(
      result.readingCamera.before,
      after,
      geometry.shift,
    );
    const baseline = await evaluate("window.__informationLayoutBaseline");
    for (const edge of ["left", "right", "top", "bottom", "width", "height"])
      assert.equal(
        geometry.chat[edge],
        baseline.chat[edge],
        `opening Information preserves outer chat.${edge}`,
      );
    for (const key of ["composer", "reading"])
      for (const edge of ["top", "bottom", "width", "height"])
        assert.equal(
          geometry[key][edge],
          baseline[key][edge],
          `opening Information preserves ${key}.${edge}`,
        );
    // This camera is intentionally wide with workspace closed. A floating
    // fallback here would hide a regression in the newly chosen lane design.
    assert.equal(
      geometry.lane,
      true,
      "wide camera must activate the Information lane",
    );
    const displacement = baseline.reading.left - geometry.reading.left;
    assert.ok(
      displacement > 0,
      "wide reading column moves into existing left whitespace",
    );
    assert.ok(
      Math.abs(displacement - geometry.shift) <= 0.5,
      "measured reading displacement matches the owned shift",
    );
    for (const edge of ["left", "right"])
      assert.ok(
        Math.abs(
          baseline.composer[edge] - geometry.composer[edge] - displacement,
        ) <= 0.5,
        `composer.${edge} follows exactly the unchanged-width reading column`,
      );
    assert.equal(geometry.draft, baseline.draft);
    assert.equal(geometry.composerIdentity, true);
    geometry.closedBaseline = baseline;
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
async function captureMarkdownRemount() {
  const priorWindowSize = window.getSize();
  const priorAppearance = nativeTheme.themeSource;
  try {
    await resizeWindow(1200, 860);
    nativeTheme.themeSource = "dark";
    await until(
      () =>
        evaluate(
          "document.documentElement.dataset.appearance==='dark' && document.documentElement.dataset.themePreset==='graphite'",
        ),
      "Graphite dark for independent Markdown history",
    );
    const markdownRow =
      '.thread-view:has(#thread-composer) [data-read-message-id="information-markdown-wrap-turn-15-answer"]';
    const targetThread =
      '.thread-row-shell[data-thread-id="information-markdown-wrap"] > button.thread-row';
    await click(targetThread, "Open synthetic Markdown history");
    await until(
      () =>
        evaluate(
          `${query(targetThread)}?.getAttribute("aria-current")==="page"`,
        ),
      "Independent Markdown history is the selected Thread",
    );
    if (
      await evaluate(
        "Boolean(document.querySelector('.workspace > .auxiliary-panel[data-open=true]'))",
      )
    ) {
      await click(
        ".workspace > .auxiliary-panel[data-open=true] .auxiliary-close-button",
        "Close active right workspace before Markdown camera",
      );
    }
    if (
      await evaluate("Boolean(document.querySelector('.information-popover'))")
    ) {
      await click(
        ".information-toolbar button",
        "Dismiss active Information before Markdown camera",
      );
    }
    await until(
      () =>
        evaluate(
          "!document.querySelector('.workspace > .auxiliary-panel[data-open=true], .information-popover')",
        ),
      "Independent Markdown capture has no right overlay or workspace allocation",
    );
    await until(
      () =>
        evaluate(
          "document.querySelectorAll(" +
            JSON.stringify(markdownRow + " .markdown-code-wrap") +
            ").length === 2",
        ),
      "Two identical completed Markdown fences in newest synthetic row",
    );
    await click(
      "#thread-composer",
      "Focus independent Markdown draft",
      false,
      false,
    );
    await insertComposerText(
      "Keep this synthetic draft while reading older messages.",
    );
    await evaluate(`(()=>{
    const row=${query(markdownRow)}, scroll=row.closest(".messages");
    if(!row.closest("[data-transcript-row-key]")||!scroll.querySelector(".virtual-transcript-content"))
      throw Error("The owned renderer is not using LegendList");
    if(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop>2)
      throw Error("Before Wrap, the newest row must be at the tail");
    window.__markdownObserved={row,scroll,composer:document.querySelector("#thread-composer")};
    return true;
  })()`);
    await click(
      markdownRow + " .markdown-code-wrap",
      "Wrap the first closed fence",
      false,
      false,
    );
    const markdownSnapshot = () =>
      evaluate(
        "(()=>{" +
          "const o=window.__markdownObserved,row=document.querySelector(" +
          JSON.stringify(markdownRow) +
          "),s=o.scroll;" +
          "if(!row)return null;" +
          "const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};" +
          "return {id:row.getAttribute('data-read-message-id'),sameNode:row===o.row,originalConnected:o.row.isConnected," +
          "composerSame:document.querySelector('#thread-composer')===o.composer,draft:o.composer.value," +
          "top:s.scrollTop,tail:s.scrollHeight-s.clientHeight-s.scrollTop,viewport:box(s),width:innerWidth,height:innerHeight," +
          "appearance:document.documentElement.dataset.appearance,preset:document.documentElement.dataset.themePreset," +
          "blocks:[...row.querySelectorAll('.markdown-code')].map(b=>{const pre=b.querySelector('pre'),btn=b.querySelector('.markdown-code-wrap');" +
          "return {wrapped:b.dataset.wrapped,pressed:btn.getAttribute('aria-pressed'),text:pre.textContent," +
          "box:box(b),header:box(btn),scrollWidth:pre.scrollWidth,clientWidth:pre.clientWidth};})};})()",
      );
    await until(
      () =>
        evaluate(
          "document.querySelector(" +
            JSON.stringify(markdownRow + " .markdown-code-wrap") +
            ").getAttribute('aria-pressed')==='true'",
        ),
      "Trusted Wrap toggles only the first actual fence",
    );
    await settleScreenshotFrame();
    const markdownBefore = await markdownSnapshot();
    assert.equal(markdownBefore.preset, "graphite");
    assert.equal(markdownBefore.appearance, "dark");
    assert.equal(markdownBefore.blocks.length, 2);
    assert.deepEqual(
      markdownBefore.blocks.map((b) => b.pressed),
      ["true", "false"],
    );
    assert.equal(markdownBefore.blocks[0].text, markdownBefore.blocks[1].text);
    assert.ok(
      markdownBefore.blocks[0].scrollWidth <=
        markdownBefore.blocks[0].clientWidth + 1,
    );
    assert.ok(
      markdownBefore.blocks[1].scrollWidth >
        markdownBefore.blocks[1].clientWidth,
    );
    await screenshot("markdown-wrap-before-scroll-away.png");
    const focusCheck = await evaluate(
      "(()=>{const o=window.__markdownObserved,s=o.scroll,top=s.scrollTop;" +
        "getSelection()?.removeAllRanges();o.composer.focus({preventScroll:true});return {top,next:s.scrollTop,focused:document.activeElement===o.composer};})()",
    );
    assert.equal(focusCheck.focused, true);
    assert.equal(focusCheck.next, focusCheck.top);
    const wheelReceipts = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await evaluate("!window.__markdownObserved.row.isConnected")) break;
      const point = await evaluate(
        "(()=>{const o=window.__markdownObserved,s=o.scroll,r=s.getBoundingClientRect();" +
          "const y=Math.floor(r.top+r.height/3),x=[r.left+4,r.right-24,r.left+r.width/2].map(Math.floor).find(px=>{const hit=document.elementFromPoint(px,y);return s.contains(hit)&&!hit.closest('pre');});" +
          "if(x===undefined)throw Error('No reachable transcript wheel target outside code');" +
          "o.wheel=null;s.addEventListener('wheel',e=>{o.wheel={trusted:e.isTrusted,deltaY:e.deltaY};},{once:true});return {x,y};})()",
      );
      window.webContents.sendInputEvent({
        type: "mouseWheel",
        ...point,
        deltaX: 0,
        deltaY: 640,
        canScroll: true,
        hasPreciseScrollingDeltas: true,
      });
      await until(
        () =>
          evaluate(
            "window.__markdownObserved.wheel?.trusted && window.__markdownObserved.wheel.deltaY<0",
          ),
        "Trusted upward transcript wheel",
      );
      wheelReceipts.push(await evaluate("window.__markdownObserved.wheel"));
      await settleScreenshotFrame();
    }
    assert.equal(
      await evaluate("!window.__markdownObserved.row.isConnected"),
      true,
      "Actual source row unmounted, not merely outside viewport",
    );
    assert.ok(wheelReceipts.length > 0);
    assert.equal(
      await evaluate(
        "document.querySelector(" + JSON.stringify(markdownRow) + ")===null",
      ),
      true,
    );
    const returnControl =
      ".thread-view:has(#thread-composer) .conversation-reading-position button";
    await click(
      returnControl,
      "Return through the native reading-position arrow",
      false,
      false,
    );
    await until(
      () =>
        evaluate(
          "(()=>{const o=window.__markdownObserved,row=document.querySelector(" +
            JSON.stringify(markdownRow) +
            ");return row!==null&&row!==o.row&&!o.row.isConnected&&o.scroll.scrollHeight-o.scroll.clientHeight-o.scroll.scrollTop<=2;})()",
        ),
      "Fresh newest row after native return to latest",
    );
    await settleScreenshotFrame();
    const markdownAfter = await markdownSnapshot();
    assert.equal(markdownAfter.sameNode, false);
    assert.equal(markdownAfter.originalConnected, false);
    assert.equal(markdownAfter.id, markdownBefore.id);
    assert.equal(markdownAfter.composerSame, true);
    assert.equal(markdownAfter.draft, markdownBefore.draft);
    assert.equal(markdownAfter.blocks.length, 2);
    assert.deepEqual(
      markdownAfter.blocks.map((b) => b.text),
      markdownBefore.blocks.map((b) => b.text),
    );
    assert.equal(markdownAfter.blocks[1].pressed, "false");
    for (const b of markdownAfter.blocks) assert.equal(b.wrapped, b.pressed);
    assert.equal(markdownAfter.width, markdownBefore.width);
    assert.equal(markdownAfter.height, markdownBefore.height);
    await screenshot("markdown-wrap-after-native-return.png");
    result.markdownWrapRemount = {
      before: markdownBefore,
      after: markdownAfter,
      wheelReceipts,
      files: [
        "markdown-wrap-before-scroll-away.png",
        "markdown-wrap-after-native-return.png",
      ],
      input:
        "Chromium-trusted control clicks and wheel; no programmatic scroll assignment; focus-only handoff with preventScroll",
    };
  } finally {
    await evaluate("delete window.__markdownObserved").catch(() => {});
    nativeTheme.themeSource = priorAppearance;
    await resizeWindow(...priorWindowSize);
  }
}
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
  await screenshot("00-live-before-controlled-reading.png");
  // Take the actual main window across the Graphite color seam with no card
  // or adjacent resource. Preserve the same draft and the native theme.
  const originalShellSize = window.getSize();
  assert.equal(window.webContents.getZoomFactor(), 1);
  result.graphiteShell = [];
  for (const appearance of ["light", "dark"]) {
    nativeTheme.themeSource = appearance;
    await until(
      () =>
        evaluate(
          `document.documentElement.dataset.appearance === ${JSON.stringify(appearance)} && document.documentElement.dataset.themePreset === 'graphite'`,
        ),
      `Graphite ${appearance} before palette capture`,
    );
    for (const width of [961, 960]) {
      await resizeWindow(width, 820);
      await settleScreenshotFrame();
      const shell = await evaluate(
        "(()=>{const bg=s=>getComputedStyle(document.querySelector(s)).backgroundColor;return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,wide:matchMedia('(min-width: 961px)').matches,sidebar:bg('.sidebar'),main:bg('.workspace'),composer:bg('.bottom-zone > .composer'),sameComposer:document.querySelector('#thread-composer')===window.__informationComposer,draft:document.querySelector('#thread-composer').value,independent:!document.querySelector('.information-popover, .auxiliary-panel[data-open=true]')}})()",
      );
      assert.equal(shell.width, width);
      assert.equal(shell.wide, width >= 961);
      assert.equal(shell.independent, true);
      assert.equal(shell.sameComposer, true);
      assert.equal(
        shell.draft,
        "Synthetic draft must survive information and workspace toggles.",
      );
      const file = `graphite-${appearance}-${width}.png`;
      await screenshot(file);
      result.graphiteShell.push({
        file,
        ...shell,
        outerSize: window.getSize(),
        contentSize: window.getContentSize(),
        zoomFactor: window.webContents.getZoomFactor(),
      });
    }
  }
  await resizeWindow(...originalShellSize);
  nativeTheme.themeSource = "light";
  await until(
    () => evaluate("document.documentElement.dataset.appearance === 'light'"),
    "restore light after Graphite palette capture",
  );
  result.readingReturn = [];
  for (const width of [961, 960]) {
    await resizeWindow(width, 820);
    const selector =
      width === 961 ? ".conversation-reading-position button" : ".back-live";
    await prepareInformationReadingCamera();
    const control = await evaluate(
      `(()=>{const b=${query(selector)},r=b.getBoundingClientRect();return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,button:{x:r.x,y:r.y,width:r.width,height:r.height,text:b.textContent.trim(),label:b.getAttribute('aria-label')},draft:document.querySelector('#thread-composer')===window.__informationComposer}})()`,
    );
    assert.equal(control.width, width);
    assert.equal(control.draft, true);
    assert.ok(control.button.width > 0);
    const file = `reading-return-light-${width}.png`;
    await screenshot(file);
    if (width === 961) {
      await click(selector, "Return to latest by pointer at 961px");
    } else {
      result.readingReturnKeyboard = [];
      await evaluate(`(()=>{
        const editor=document.querySelector('#thread-composer');
        const view=editor?.closest('.thread-view'),button=view?.querySelector('.back-live');
        if(!document.hasFocus()||!button?.getBoundingClientRect().width) throw Error('Paused primary thread must be active');
        editor.focus({preventScroll:true});
        if(document.activeElement!==editor) throw Error('Could not start at the primary Composer');
        window.__returnTab=null;
        document.addEventListener('keydown',function capture(e){
          if(e.key!=='Tab') return;
          if(!e.shiftKey||!e.isTrusted) return;
          const previous=e.target;
          setTimeout(()=>{window.__returnTab={trusted:true,prevented:e.defaultPrevented,editor:previous===editor}},0);
        },{capture:true,signal:(window.__returnTabAbort=new AbortController()).signal});
        return true;
      })()`);
      try {
        for (let step = 0; step < 8; step++) {
          await evaluate("window.__returnTab=null");
          for (const type of ["keyDown", "keyUp"]) {
            window.webContents.sendInputEvent({
              type,
              keyCode: "Tab",
              modifiers: ["shift"],
            });
          }
          await until(
            () => evaluate("Boolean(window.__returnTab)"),
            "Trusted Shift+Tab reached the primary Chrome renderer",
          );
          await settleScreenshotFrame();
          const sample = await evaluate(`(()=>{
            const e=document.querySelector('#thread-composer'),v=e.closest('.thread-view');
            const b=v.querySelector('.back-live'),s=v.querySelector('.messages'),a=document.activeElement;
            return {key:window.__returnTab,hit:Boolean(b&&a===b),visible:Boolean(b?.getBoundingClientRect().width),
              inThread:v.contains(a),inBottom:Boolean(a?.closest('.bottom-zone')),tag:a?.tagName,
              tailDistance:s.scrollHeight-s.clientHeight-s.scrollTop};
          })()`);
          result.readingReturnKeyboard.push(sample);
          if (sample.hit) break;
          if (!sample.visible || !sample.inThread) break;
        }
      } finally {
        await evaluate("window.__returnTabAbort.abort()");
      }
      assert.equal(
        result.readingReturnKeyboard.at(-1)?.hit,
        true,
        "Native Shift+Tab from the Composer must reach the visible arrow",
      );
      await evaluate(`(()=>{
        const b=${query(selector)};
        if(document.activeElement!==b) throw Error('Enter target must be the focused return button');
        window.__readingEnter={keydown:false,keypress:false,click:false};
        b.addEventListener('keydown',e=>{if(e.isTrusted&&e.key==='Enter')setTimeout(()=>{window.__readingEnter.keydown=true;window.__readingEnter.prevented=e.defaultPrevented},0)},{once:true});
        b.addEventListener('keypress',e=>{window.__readingEnter.keypress=e.isTrusted&&e.charCode===13},{once:true});
        b.addEventListener('click',e=>{window.__readingEnter.click=e.isTrusted&&e.detail===0},{once:true});
        return true;
      })()`);
      // Electron sends raw keydown; Blink activates a button on Enter's CR keypress.
      const enterInput = window.webContents;
      enterInput.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      try {
        await until(
          () => evaluate("window.__readingEnter.keydown"),
          "Trusted Enter keydown reached the narrow return button",
        );
        assert.equal(
          await evaluate(
            `!window.__readingEnter.prevented && document.activeElement===${query(selector)}`,
          ),
          true,
          "Return button still owns Enter before its character event",
        );
        enterInput.sendInputEvent({ type: "char", keyCode: "\r" });
        await until(
          () =>
            evaluate(
              "window.__readingEnter.keypress && window.__readingEnter.click",
            ),
          "Trusted carriage return activated the narrow return button",
        );
      } finally {
        enterInput.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        result.readingReturnEnter = await evaluate("window.__readingEnter");
      }
    }
    await until(
      () =>
        evaluate(
          `(()=>{const s=document.querySelector('.thread-view .messages'),c=document.querySelector('#thread-composer');return !${query(selector)}&&s.scrollHeight-s.clientHeight-s.scrollTop<4&&c===window.__informationComposer&&c.value==='Synthetic draft must survive information and workspace toggles.'})()`,
        ),
      `Back at latest with the original Composer draft at ${width}px`,
    );
    if (width === 960) {
      assert.deepEqual(
        await evaluate(
          "(()=>{const s=document.querySelector('#thread-composer').closest('.thread-view').querySelector('.messages');return {trustedKeyClick:window.__readingEnter.click,transcriptFocus:document.activeElement===s}})()",
        ),
        { trustedKeyClick: true, transcriptFocus: true },
      );
    }
    result.readingReturn.push({
      file,
      ...control,
      zoomFactor: window.webContents.getZoomFactor(),
      method: width === 961 ? "pointer" : "Shift+Tab then Enter",
    });
  }
  await resizeWindow(...originalShellSize);
  await prepareInformationReadingCamera();
  await evaluate(
    "(()=>{if(document.querySelector('.information-popover, .information-dock'))throw Error('Opening baseline requires closed information');const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};window.__informationLayoutBaseline={reading:rect('.thread-view .virtual-transcript-header, .thread-view .messages-inner'),chat:rect('.agent-surface'),composer:rect('#thread-composer'),draft:document.querySelector('#thread-composer').value};return true})()",
  );
  await screenshot("00-wide-closed-baseline.png");
  await click(".information-toolbar button", "Open wide information card");
  await until(
    () =>
      evaluate(
        "document.querySelector('.information-content')?.textContent.includes('Daily synthetic review') && document.querySelector('.information-content')?.textContent.includes('Review responsive layout') && Boolean(document.querySelector('.information-content .background-shell-list code'))",
      ),
    "real trigger, lineage and command cards",
  );
  await capture("01-wide-light", "overlay");
  await captureInformationFitBoundary();
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
  assert.equal(
    await evaluate(
      `document.activeElement===${query(checkbox)} && ${query(checkbox)}.matches(':focus-visible')`,
    ),
    true,
    "native checkbox keyboard selection retains visible focus before capture",
  );
  await screenshot("01f-checkbox-keyboard-focus.png");
  const keyboardSwitch =
    '[aria-label="Pause trigger · Daily synthetic review"]';
  // Native mouse focus differs by platform. Enter this keyboard flow with
  // actual Tab navigation, then require both Space operations to retain focus.
  await focusWithNativeTab(keyboardSwitch, "Tab to the native trigger switch");
  await pressKey("Space", "Native Space pauses the focused trigger switch");
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
    '[aria-label="Done"]',
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
  await click('[aria-label="Done"]', "Review independent native fields");
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
  await click('[aria-label="Done"]', "Return to information reading");
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
  for (let attempt = 0; attempt < 2; attempt++) {
    await click(
      ".sidebar-collapse-button",
      "Collapse sidebar in maximized resource workspace",
    );
    await until(
      () =>
        evaluate(
          "document.querySelector('.app-shell').classList.contains('sidebar-collapsed')",
        ),
      "sidebar collapsed",
    );
    await pause(250);
    if (process.platform === "darwin") {
      const strip = await evaluate(
        "(()=>{const b=document.querySelector('.sidebar-collapse-button').getBoundingClientRect(),h=document.querySelector('.auxiliary-heading').getBoundingClientRect();return {buttonRight:b.right,headingLeft:h.left}})()",
      );
      assert.ok(
        strip.headingLeft >= strip.buttonRight,
        "Fullscreen drag heading clears native toggle hit region",
      );
      result.sidebarNativeStrip = strip;
    }
    await click(
      ".sidebar-collapse-button",
      "Expand sidebar from native strip while workspace is maximized",
    );
    await until(
      () =>
        evaluate(
          "!document.querySelector('.app-shell').classList.contains('sidebar-collapsed')",
        ),
      "sidebar expands after actual click",
    );
  }
  await click(
    '[data-tab-id="primary-conversation"] [role="tab"]',
    "Select the main-conversation workspace Tab",
  );
  await click(
    '.thread-row-shell[data-thread-id="information-other"] > button.thread-row',
    "Navigate away from maximized primary conversation",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.thread-row-shell[data-thread-id=\"information-other\"] > button.thread-row')?.getAttribute('aria-current')==='page' || !document.querySelector('.auxiliary-panel[data-primary-active=true]')",
      ),
    "second conversation shown",
  );
  await click(main, "Return to retained primary conversation");
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.auxiliary-panel[data-primary-active=true] [data-tab-id=\"primary-conversation\"] [aria-selected=true]'))",
      ),
    "primary selection survives production panel remount",
  );
  await click(
    '.auxiliary-heading button[aria-label="Restore side panel"]',
    "Restore original resource after retained primary conversation",
  );
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('[data-tab-id=\"file:fixture.txt\"] [aria-selected=true]'))",
      ),
    "original resource fallback retained",
  );
  await click(
    '.auxiliary-heading button[aria-label="Expand side panel"]',
    "Reenter fullscreen on retained resource",
  );
  await click(
    '[data-tab-id="primary-conversation"] [role="tab"]',
    "Select primary again after restoring resource",
  );
  // Navigation remounts the real ThreadView; subsequent tests compare its new DOM identity.
  await evaluate(
    "(()=>{window.__informationComposer=document.querySelector('#thread-composer');return true})()",
  );
  await click(
    ".information-toolbar button",
    "Open information in maximized main conversation",
  );
  await capture("04-maximized-main-overlay", "overlay");
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
  await capture("05-maximized-main-dark", "overlay");
  await click(
    '[data-tab-id="file:fixture.txt"] [role="tab"]',
    "Switch maximized workspace to its file resource",
  );
  await capture("06-resource-tab-closes-information", "closed");
  await click(
    '[data-tab-id="primary-conversation"] [role="tab"]',
    "Return to the main-conversation Tab",
  );
  await resizeWindow(1000, 820);
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
  await resizeWindow(1600, 1000);
  await capture("08a-open-overlay-resize-wide", "overlay");
  assert.equal(result.cases.at(-1).geometry.composerIdentity, true);
  await resizeWindow(1000, 820);
  await capture("08b-open-overlay-resize-narrow", "overlay");
  // Both sides of the former dock breakpoint retain full conversation width.
  await resizeWindow(1184, 820);
  await capture("08c-920px-allocation-overlay", "overlay");
  assert.equal(result.cases.at(-1).geometry.workspace.width, 920);
  assert.equal(result.cases.at(-1).geometry.chat.width, 920);
  assert.ok(result.cases.at(-1).geometry.composer.width >= 480);
  await resizeWindow(1183, 820);
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
  await resizeWindow(1600, 1000);
  await click(
    ".information-toolbar button",
    "Reopen before switching conversation",
  );
  await click(
    '.thread-row-shell[data-thread-id="information-other"] > button.thread-row',
    "Switch to a different synthetic conversation",
  );
  await capture("09-switch-owner-closed", "closed");
  // Same ordinary Room-sourced message on both builds, read from the real journal.
  const hostRow =
    '.thread-view:has(#thread-composer) .host-message-row:has(.host-message-actions time[datetime="2026-11-01T12:01:00.000Z"])';
  const hoverHostCapture = async (selector) => {
    const point = await evaluate(`(()=>{
      const e=${query(selector)},r=e.getBoundingClientRect();
      const x=Math.floor(r.left+r.width/2),y=Math.floor(r.top+r.height/2);
      if(!e.contains(document.elementFromPoint(x,y))) throw Error('Native pointer cannot reach capture target');
      window.__hostCaptureMove=false;
      e.addEventListener('mousemove',ev=>{window.__hostCaptureMove=ev.isTrusted},{once:true,capture:true});
      return {x,y};
    })()`);
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
    await until(
      () => evaluate("window.__hostCaptureMove"),
      "Trusted Room provenance pointer position",
    );
    await pause(180);
  };
  await until(
    () =>
      evaluate(
        `document.querySelectorAll(${JSON.stringify(hostRow)}).length===1`,
      ),
    "unique ordinary Room provenance in the primary transcript",
  );
  const provenanceSnapshot = () =>
    evaluate(`(()=>{
    const host=${query(hostRow)},source=host.querySelector('.host-message-source');
    return {light:document.documentElement.dataset.appearance==='light',
      preset:document.documentElement.dataset.themePreset,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,
      hovered:host.matches(':hover'),fine:matchMedia('(hover:hover) and (pointer:fine)').matches,
      source:source.textContent.trim(),sourceTitle:source.getAttribute('title'),
      actions:getComputedStyle(host.querySelector('.host-message-actions')).opacity,
      copy:getComputedStyle(host.querySelector('.host-message-actions > .message-copy')).opacity,
      hostTime:host.querySelector('time')?.dateTime,
      replyTime:host.closest('.thread-view').querySelector('.assistant-message-actions time')?.dateTime,
      expanded:host.querySelector('.host-message-toggle').getAttribute('aria-expanded'),
      sourceIdVisible:host.querySelector('.host-message-source-id')?.textContent.includes('synthetic-room-brief')??false};
  })()`);
  await hoverHostCapture("#thread-composer");
  const rest = await provenanceSnapshot();
  assert.equal(rest.hovered, false);
  assert.equal(rest.light, false);
  assert.equal(rest.preset, "graphite");
  assert.equal(rest.expanded, "false");
  assert.equal(rest.sourceTitle, null);
  assert.equal(rest.actions, "1");
  assert.equal(rest.copy, rest.fine ? "0" : "1");
  assert.equal(rest.hostTime, "2026-11-01T12:01:00.000Z");
  assert.equal(rest.replyTime, "2026-11-01T12:05:00.000Z");
  await screenshot("host-provenance-rest.png");
  await hoverHostCapture(hostRow + " .host-message-source");
  const hover = await provenanceSnapshot();
  assert.equal(hover.hovered, true);
  assert.equal(hover.actions, "1");
  assert.equal(hover.copy, "1");
  await screenshot("host-provenance-hover.png");
  await click(
    hostRow + " .host-message-toggle",
    "Open Room source details explicitly",
  );
  const details = await provenanceSnapshot();
  assert.equal(details.expanded, "true");
  assert.equal(details.sourceIdVisible, true);
  assert.equal(
    await evaluate(
      `${query(hostRow)}.querySelector('pre[data-thread-find-item-id="synthetic-provenance-host"]')?.textContent`,
    ),
    "Room handoff: leave the draft open and keep the reading area clear for the review.",
  );
  await screenshot("host-provenance-details.png");
  await click(
    hostRow + " .host-message-toggle",
    "Restore closed Room source details",
  );
  result.hostProvenance = {
    rest,
    hover,
    details,
    zoomFactor: window.webContents.getZoomFactor(),
  };
  await click(
    ".information-toolbar button",
    "Open second conversation information",
  );
  await capture("10-second-owner", "overlay");
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
  await until(
    () =>
      evaluate(
        "document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded')==='true'",
      ),
    "original owner's remembered open state is restored",
  );
  // The selected main conversation restores the same floating presentation.
  await capture("10a-original-owner-restored", "overlay");
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
    '[aria-label="Done"]',
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
    '[aria-label="Done"]',
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
  await until(async () => {
    const listing = await evaluate(
      "window.zenx.shellPanel.request({operation:'list',threadId:'information-main'})",
    );
    const task = listing.sessions.find((session) => session.taskId === taskId);
    return (
      !!task &&
      ["completed", "failed", "timed_out", "cancelled"].includes(task.status)
    );
  }, "Host confirms the exact background command has ended");
  await until(
    () =>
      evaluate(
        "(()=>{const panel=document.querySelector('.editable-information-panel[data-owner=\"thread:information-main\"]');const shell=panel?.querySelector('[data-widget-id=\"default:shell\"]');return !!shell&&shell.hidden&&shell.getClientRects().length===0&&!panel.querySelector('.background-shell-list,.background-shell-status')})()",
      ),
    "ended command and its empty information card are not visible",
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
  // Reuse the original review's Chinese content for a comparable visual case,
  // published through the actual native Host rather than injected into the DOM.
  const referencePrompt = "资料卡里最该优先显示哪一类信息？";
  await until(
    () =>
      evaluate(
        "window.zenx.threads.list().then(rows=>rows.find(row=>row.threadId==='information-main')?.status==='idle')",
      ),
    "reference visual question actor is idle",
  );
  await evaluate(
    `window.zenx.protocol.request('turn/start',${JSON.stringify({
      threadId: "information-main",
      clientUserMessageId: "native-reference-visual-question",
      input: [
        {
          type: "text",
          text:
            "!tool ask_user_question " +
            JSON.stringify({
              questions: [
                {
                  id: "reference-visual",
                  prompt: referencePrompt,
                  multiSelect: true,
                  options: [
                    {
                      id: "live",
                      label: "正在运行的事情",
                      description: "后台命令、子对话和等待中的提问",
                    },
                    {
                      id: "trigger",
                      label: "触发器状态",
                      description: "下一次运行时间与暂停状态",
                    },
                    {
                      id: "recent",
                      label: "最近活动",
                      description: "刚才结束的任务与结果",
                    },
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
        `Array.from(document.querySelectorAll('.user-question-card')).some(e=>e.textContent.includes(${JSON.stringify(referencePrompt)}))`,
      ),
    "reference visual question accepted and rendered by the real Host",
  );
  const referenceCallId = await evaluate(
    `Array.from(document.querySelectorAll('.user-question-card')).find(e=>e.textContent.includes(${JSON.stringify(referencePrompt)})).dataset.questionCallId`,
  );
  const referenceCard = `[data-question-call-id=${JSON.stringify(referenceCallId)}]`;
  await click(
    referenceCard + " .user-question-options > li:nth-child(1) input",
    "Select first original-reference option",
  );
  await click(
    referenceCard + " .user-question-options > li:nth-child(2) input",
    "Select second original-reference option",
  );
  nativeTheme.themeSource = "dark";
  await until(
    () => evaluate("document.documentElement.dataset.appearance==='dark'"),
    "reference comparison uses actual dark appearance",
  );
  await evaluate(
    `${query(referenceCard)}.scrollIntoView({block:'start',inline:'nearest'})`,
  );
  await screenshot("17-reference-dark-Chinese-question-full-App.png");
  const captureInformationCrop = async (name) => {
    await settleScreenshotFrame();
    const rectangle = await evaluate(
      "(()=>{const e=document.querySelector('.information-popover'),r=e.getBoundingClientRect();return {x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.width),height:Math.floor(r.height)}})()",
    );
    await fs.writeFile(
      path.join(directory, name),
      (await window.webContents.capturePage(rectangle)).toPNG(),
    );
  };
  await captureInformationCrop(
    "17a-reference-dark-Chinese-question-native-crop.png",
  );
  await evaluate(
    "document.querySelector('.information-trigger-list').closest('.information-widget').scrollIntoView({block:'start',inline:'nearest'})",
  );
  await screenshot("18-reference-dark-Chinese-triggers-full-App.png");
  await captureInformationCrop(
    "18a-reference-dark-Chinese-triggers-native-crop.png",
  );
  result.cases.push({
    name: "original-reference-visual-comparison",
    source:
      "original #658/#659/#661/#662 reference wording; current production App with real native publication and pointer input",
    crops:
      "Electron capturePage of the actual information surface; no redrawing or image editing",
    nativeInputsRetained: true,
  });
  // Restore the production preference before the OS-pointer scenario uses
  // English accessible names; the Chinese reference captures above stay intact.
  await evaluate(
    "(()=>{localStorage.setItem('zenx.language','en');dispatchEvent(new StorageEvent('storage',{key:'zenx.language',newValue:'en',storageArea:localStorage}));return true})()",
  );
  await until(
    () => evaluate("document.documentElement.lang==='en'"),
    "English preference restored before system-pointer acceptance",
  );
  // Unlike sendInputEvent, the production Computer path traverses macOS's
  // actual non-client drag hit test. No trust prompt, TCC change or fallback.
  if (process.platform === "darwin") {
    result.sidebarOsInput = { status: "running", permissionChanges: false };
    try {
      ownedSidebarInput = await require(
        path.join(temporary, "owned-sidebar-native-input.cjs"),
      ).prepareOwnedSidebarInput(temporary);
      await click(
        main,
        "Select owned main Thread for system-pointer acceptance",
      );
      await until(
        () => evaluate("Boolean(document.querySelector('.auxiliary-panel'))"),
        "owned Thread workspace mounted",
      );
      if (
        !(await evaluate(
          "document.querySelector('.auxiliary-panel').dataset.open==='true'",
        ))
      )
        await click(
          "#thread-browser-toggle",
          "Open workspace for system-pointer acceptance",
        );
      if (
        !(await evaluate(
          "document.querySelector('.auxiliary-panel').dataset.expanded==='true'",
        ))
      )
        await click(
          '.auxiliary-heading button[aria-label="Expand side panel"]',
          "Maximize workspace for system-pointer acceptance",
        );
      await click(
        '[data-tab-id="file:fixture.txt"] [role="tab"]',
        "Select owned resource before system-pointer acceptance",
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        await click(
          ".sidebar-collapse-button",
          "Collapse sidebar before actual OS click",
        );
        await until(
          () =>
            evaluate(
              "document.querySelector('.app-shell').classList.contains('sidebar-collapsed')",
            ),
          "sidebar fully collapsed before OS click",
        );
        await pause(250);
        await click(
          ".sidebar-collapse-button",
          "Expand sidebar using actual bound macOS pointer",
          true,
        );
        await until(
          () =>
            evaluate(
              "!document.querySelector('.app-shell').classList.contains('sidebar-collapsed')",
            ),
          "OS click expanded the actual sidebar",
        );
      }
      result.sidebarOsInput = {
        status: "passed",
        permissionChanges: false,
        clicks: result.systemSidebarClicks.length,
      };
      await screenshot("15-macos-system-sidebar-click.png");
      await verifyInformationOsInput();
    } catch (error) {
      const failedScenario =
        result.informationOsInput?.status === "running"
          ? "informationOsInput"
          : "sidebarOsInput";
      result[failedScenario] = {
        status: /Accessibility permission is not granted/.test(String(error))
          ? "blocked"
          : "failed",
        permissionChanges: false,
        reason: String(error),
        nativeDelivery: "unverified",
      };
      throw error;
    }
  }
  result.ok = true;
  try {
    await captureMarkdownRemount();
    result.markdownWrapRemount.status = "captured";
  } catch (error) {
    result.markdownWrapRemount = {
      status: "failed",
      waitingFor: result.waitingFor,
      reason: String(error.stack || error),
    };
    delete result.waitingFor;
  }
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
    await ownedSidebarInput?.close();
    await fs.writeFile(
      path.join(directory, "acceptance.json"),
      JSON.stringify(result, null, 2),
    );
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
  });
