/** Operates only the disposable CI App created by launch-user-question-acceptance. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  session,
  nativeTheme,
  ipcMain,
  clipboard,
  nativeImage,
} = require("electron");
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
  runtime: {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
  },
  screenshots: {},
  steps: [],
  cases: [],
  blockedExternalRequests: 0,
};
let window;
let fixture;
let loseNextReply = false;
const responseAttempts = [];
const exactReads = [];
const ordinaryAttempts = [],
  recallAttempts = [];
let withdrawnReadGate, releaseWithdrawnRead;
// Test transport fault only: the actual production handler and Host run first.
// No renderer API/DOM substitution, no changed Host options or production hook.
const registerHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  registerHandle(
    channel,
    channel !== "zenx:protocol:request"
      ? listener
      : async (event, method, params) => {
          const reply = await listener(event, method, params);
          if (method === "zen/turn/send")
            ordinaryAttempts.push({ params, reply });
          if (method === "zen/thread/steer/recall")
            recallAttempts.push({ params, reply });
          if (method === "zen/thread/questions/read") {
            exactReads.push({ params, reply });
            if (
              withdrawnReadGate &&
              !withdrawnReadGate.blocked &&
              params.threadId === withdrawnReadGate.threadId &&
              reply.response?.status === "withdrawn"
            ) {
              withdrawnReadGate.blocked = true;
              await withdrawnReadGate.wait;
              withdrawnReadGate.delivered = true;
            }
          }
          if (method === "zen/thread/questions/respond") {
            assert.ok(
              fixture.questions.some(
                (q) =>
                  q.request.threadId === params.threadId &&
                  q.request.callItemId === params.questionCallItemId,
              ),
            );
            assert.equal(
              reply.question.response.clientId,
              params.clientUserMessageId,
            );
            responseAttempts.push({ params, reply });
            if (loseNextReply) {
              loseNextReply = false;
              throw new Error(
                "Synthetic transport fault: real Host reply deliberately lost after admission",
              );
            }
          }
          return reply;
        },
  );
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
  const png = (await window.webContents.capturePage()).toPNG();
  await fs.writeFile(path.join(directory, name), png);
  result.screenshots[name] = createHash("sha256").update(png).digest("hex");
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
        "(()=>{const e=document.querySelector('.information-dock .conversation-information-section > header'),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()",
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
async function typeOnce(selector, value, label) {
  await click(selector, label);
  await until(
    () =>
      evaluate(
        `document.activeElement===${query(selector)} && ${query(selector)} instanceof HTMLTextAreaElement`,
      ),
    label + " focus settled",
  );
  assert.equal(
    await evaluate(`${query(selector)}.value`),
    "",
    label + " starts blank",
  );
  await window.webContents.insertText(value);
  try {
    await until(
      () => evaluate(`${query(selector)}.value===${JSON.stringify(value)}`),
      label + " exact native input value",
    );
  } catch (error) {
    result.inputFailure = await evaluate(
      `(()=>{const e=${query(selector)};return {exists:!!e,active:document.activeElement===e,tag:e?.tagName,disabled:e?.disabled,value:e?.value}})()`,
    );
    throw error;
  }
}
async function selectThread(selector, label, expectedInformationOpen = false) {
  await click(selector, label);
  await until(
    () =>
      evaluate(
        `${query(selector)}?.getAttribute('aria-current')==='page' && document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded')===${JSON.stringify(String(expectedInformationOpen))}`,
      ),
    label + " navigation and remembered owner panel settled",
  );
}
async function openInformation() {
  if (
    await evaluate(
      `document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded')!=='true'`,
    )
  )
    await click(".information-toolbar button", "Open information panel");
  await until(
    () =>
      evaluate(
        `document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded')==='true'`,
      ),
    "information panel open settled",
  );
}
async function cardVisible(selector) {
  await until(() => evaluate(`Boolean(${query(selector)})`), "question card");
  await evaluate(`${query(selector)}.scrollIntoView({block:'nearest'})`);
  await pause(100);
}
// Read-only DOM inspection supports the real textarea and reference-chip editor.
async function composerSnapshot() {
  return evaluate(`(()=>{const e=document.querySelector('#thread-composer');if(!e)return null;
    const lines=[...e.querySelectorAll('.cm-line')].map(line=>{const copy=line.cloneNode(true);copy.querySelectorAll('.cm-placeholder').forEach(node=>node.remove());copy.querySelectorAll('[data-reference-key]').forEach(chip=>chip.replaceWith('\\uFFFC'));return copy.textContent});
    return {text:e instanceof HTMLTextAreaElement?e.value:lines.join('\\n'),references:[...e.querySelectorAll('.reference-token-details')].map(x=>x.title),images:document.querySelectorAll('.composer-images .draft-image').length}})()`);
}
async function typeEmptyComposer(text) {
  await click("#thread-composer", "Native ordinary Composer input");
  await until(
    () =>
      evaluate(
        `(()=>{const e=document.querySelector('#thread-composer');return document.activeElement===e&&(e instanceof HTMLTextAreaElement||e.isContentEditable)})()`,
      ),
    "actual editable Composer focus",
  );
  assert.equal((await composerSnapshot()).text, "");
  await window.webContents.insertText(text);
  await until(
    async () => (await composerSnapshot()).text === text,
    "exact native Composer text",
  );
}
async function sendComposer(mode) {
  const count = ordinaryAttempts.length;
  await click(
    `.composer-send-control > button.action-orb.${mode}:not(:disabled)`,
    "Native ordinary Send",
  );
  await until(
    () => Promise.resolve(ordinaryAttempts.length === count + 1),
    "real ordinary send receipt",
  );
  await until(
    async () => (await composerSnapshot()).text === "",
    "ordinary Send clears draft",
  );
  assert.equal(
    ordinaryAttempts.at(-1).params.mode,
    undefined,
    "production soft send",
  );
  return ordinaryAttempts.at(-1);
}
async function originSummary(threadId) {
  // Dedicated summary API only, never full-history polling while sending.
  return evaluate(
    `window.zenx.threads.list({archived:false}).then(rows=>rows.find(row=>row.threadId===${JSON.stringify(threadId)}))`,
  );
}
async function originBadge(threadId, open) {
  await until(
    () =>
      evaluate(
        `(()=>{const rows=[...document.querySelectorAll('.thread-row-shell[data-thread-id="${threadId}"] > .thread-row')];return rows.length>0&&rows.every(row=>Boolean(row.querySelector('.thread-asking-badge'))===${open})})()`,
      ),
    `authoritative Asking badge ${open ? "open" : "pending-hidden"}`,
  );
}
async function runOrigin() {
  const preferences = (await evaluate("window.zenx.settings.get()")).profile;
  assert.deepEqual(preferences.pinnedThreadIds, [fixture.other]);
  const initialSummaries = await evaluate(
    "window.zenx.threads.list({archived:false})",
  );
  result.origin = {
    batches: [],
    fault:
      "One actual exact withdrawn read reply delayed during native navigation; no UI or Host replacement",
  };
  for (const [index, key] of ["main", "other"].entries()) {
    const threadId = fixture[key],
      release = fixture.releaseFiles[index];
    const row = `.thread-row-shell[data-thread-id="${threadId}"] > button.thread-row`;
    const question = fixture.questions.find(
      (q) => q.request.threadId === threadId,
    );
    const card = `.user-question-card[data-question-call-id="${question.request.callItemId}"]`;
    const detail = `Synthetic original question detail ${key}.`,
      newer = `Synthetic newer ordinary draft ${key}.`;
    await selectThread(row, `Select synthetic mixed-origin ${key}`);
    await originBadge(threadId, true);
    const initialSummary = initialSummaries.find(
      (summary) => summary.threadId === threadId,
    );
    assert.equal(initialSummary.userQuestionSummary.openCount, 1);
    await typeEmptyComposer(
      "!tool shell " +
        JSON.stringify({
          command: `node ${JSON.stringify(fixture.holdScript)} ${JSON.stringify(release)}`,
          yield_time_ms: 180000,
          timeout_ms: 180000,
        }),
    );
    await sendComposer("send");
    await until(
      async () =>
        fs.stat(release + ".started").then(
          () => true,
          () => false,
        ),
      "real active production shell tool",
    );
    await openInformation();
    await cardVisible(card);
    await click(
      card + " .user-question-option:first-of-type input",
      "Native original question choice",
    );
    await typeOnce(
      card + " textarea",
      detail,
      "Native original question free text",
    );
    await click(
      card + " .primary-button",
      "Native question Send during active tool",
    );
    await until(
      () => Promise.resolve(responseAttempts.length === index + 1),
      "real pending question reply",
    );
    const answer = responseAttempts.at(-1);
    assert.equal(answer.reply.question.state, "answer-pending");
    await originBadge(threadId, false);
    await typeEmptyComposer(`Synthetic original ordinary ${key}. @fixture`);
    await click(
      '.composer-suggestion-menu .selector-option:has(strong[title="fixture.txt"])',
      "Native workspace reference selection",
    );
    await until(
      async () => (await composerSnapshot()).references.length === 1,
      "real inline file reference",
    );
    clipboard.writeImage(
      nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 180), {
        width: 16,
        height: 16,
      }),
    );
    await click(
      "#thread-composer",
      "Focus real Composer for synthetic image paste",
    );
    await until(
      () =>
        evaluate(
          `document.activeElement===document.querySelector('#thread-composer')`,
        ),
      "actual image paste focus",
    );
    assert.equal(clipboard.readImage().isEmpty(), false);
    // Native Chromium edit command consumes the real CI system clipboard and
    // dispatches the normal trusted paste path; no renderer value/event injection.
    window.webContents.paste();
    await until(
      async () => (await composerSnapshot()).images === 1,
      "native clipboard image imported",
    );
    clipboard.clear();
    const original = await composerSnapshot();
    const ordinary = await sendComposer("steer");
    assert.equal(
      ordinary.params.input.filter((p) => p.type === "image").length,
      1,
    );
    assert.match(
      ordinary.params.input.find((p) => p.type === "text").text,
      /fixture\.txt/,
    );
    await typeEmptyComposer(newer);
    await until(
      () =>
        evaluate(
          `document.querySelector('.pending-steer-heading [role="status"]')?.textContent.includes('2')`,
        ),
      "two real recallable steer inputs",
    );
    const pendingSummary = await originSummary(threadId);
    assert.equal(pendingSummary.userQuestionSummary.openCount, 0);
    if (index === 1)
      withdrawnReadGate = {
        threadId,
        blocked: false,
        wait: new Promise((resolve) => {
          releaseWithdrawnRead = resolve;
        }),
      };
    await click(
      ".pending-steer-heading .queue-header-action:not(:disabled)",
      "Native one whole-batch Recall",
    );
    await until(
      () => Promise.resolve(recallAttempts.length === index + 1),
      "real whole-batch recall receipt",
    );
    const recall = recallAttempts.at(-1);
    assert.equal(recall.reply.receipt.type, "user_message_steer_recalled");
    assert.deepEqual(
      new Set(recall.params.targets.map((t) => t.clientId)),
      new Set([
        answer.params.clientUserMessageId,
        ordinary.params.clientUserMessageId,
      ]),
    );
    if (index === 1) {
      await until(
        () => Promise.resolve(withdrawnReadGate.blocked),
        "actual exact withdrawn preflight held",
      );
      await click(
        ".new-thread-action",
        "Navigate away during origin preflight",
      );
      await until(
        async () => (await composerSnapshot())?.text === "",
        "new draft owner settled",
      );
      await typeEmptyComposer("Synthetic unrelated navigation draft.");
      releaseWithdrawnRead();
      await until(
        () => Promise.resolve(withdrawnReadGate.delivered),
        "real delayed withdrawn reply delivered",
      );
      await pause(200);
      assert.equal(
        (await composerSnapshot()).text,
        "Synthetic unrelated navigation draft.",
      );
      await selectThread(row, "Return to recoverable original owner", true);
      await until(
        () => evaluate(`Boolean(document.querySelector('.steer-recovery'))`),
        "whole receipt remains recoverable",
      );
      assert.deepEqual(
        await composerSnapshot(),
        { text: newer, references: [], images: 0 },
        "navigation blocks every ordinary origin, not partial restoration",
      );
      await openInformation();
      await cardVisible(card);
      assert.equal(
        await evaluate(`${query(card + " textarea")}.value`),
        detail,
        "original question draft not overwritten",
      );
      await capture("07-origin-navigation-blocked-recoverable", "dock");
      await click(
        ".steer-recovery > div > button",
        "Explicit restore from durable receipt",
      );
      await until(
        () =>
          evaluate(
            `document.querySelectorAll('.steer-recovery > div > button').length===2`,
          ),
        "explicit merge confirmation",
      );
      await click(
        ".steer-recovery > div > button:first-of-type",
        "Confirm original input destinations",
      );
    }
    await until(
      async () =>
        (await composerSnapshot()).text === original.text + "\n\n" + newer,
      "ordinary draft merged once at original input",
    );
    assert.deepEqual(await composerSnapshot(), {
      text: original.text + "\n\n" + newer,
      references: ["fixture.txt"],
      images: 1,
    });
    await openInformation();
    await cardVisible(card);
    await until(
      () => evaluate(`!${query(card + " .primary-button")}.disabled`),
      "withdrawn original question editable",
    );
    assert.equal(await evaluate(`${query(card + " textarea")}.value`), detail);
    assert.equal(
      await evaluate(
        `document.querySelectorAll(${JSON.stringify(card + " input:checked")}).length`,
      ),
      1,
    );
    assert.equal(
      await evaluate(
        `Boolean(document.querySelector('.steer-recovery, .pending-steer-heading'))`,
      ),
      false,
      "batch applied exactly once",
    );
    assert.equal(
      responseAttempts.length,
      index + 1,
      "restore never resends answer",
    );
    assert.equal(
      ordinaryAttempts.length,
      (index + 1) * 2,
      "restore never resends ordinary input",
    );
    assert.equal(
      recallAttempts.length,
      index + 1,
      "one mutation per complete mixed batch",
    );
    await originBadge(threadId, true);
    const restoredSummary = await originSummary(threadId);
    assert.equal(restoredSummary.userQuestionSummary.openCount, 1);
    assert.equal(
      restoredSummary.userQuestionSummary.latestPublishedAt,
      initialSummary.userQuestionSummary.latestPublishedAt,
      "recall does not invent a new publication",
    );
    assert.equal(
      restoredSummary.recentActivityAt,
      pendingSummary.recentActivityAt,
      "recall does not create human recency",
    );
    assert.deepEqual(
      await evaluate(
        "[...document.querySelectorAll('.pinned-thread-group .thread-row-shell')].map(row=>row.dataset.threadId)",
      ),
      [fixture.other],
      "Pinned row/order unchanged",
    );
    await capture(
      index === 0
        ? "06-origin-mixed-restored-once"
        : "08-origin-explicit-recovery-restored-once",
      "dock",
    );
    result.origin.batches.push({
      threadId,
      answer,
      ordinary,
      recall,
      original,
      restored: await composerSnapshot(),
      summary: {
        initial: initialSummary,
        pending: pendingSummary,
        restored: restoredSummary,
      },
    });
    await fs.writeFile(release, "normal release");
    await until(
      () =>
        evaluate(
          `Boolean(document.querySelector('.composer-send-control > button.action-orb.send:not(:disabled)'))`,
        ),
      "owned production tool exits normally with restored draft unsent",
    );
  }
  const finalPreferences = (await evaluate("window.zenx.settings.get()"))
    .profile;
  assert.deepEqual(
    finalPreferences.pinnedThreadIds,
    preferences.pinnedThreadIds,
  );
  assert.deepEqual(finalPreferences.sidebarOrder, preferences.sidebarOrder);
  result.receipts = responseAttempts;
  result.notCovered = [
    "live Desktop question publication",
    "Windows native UI",
    "claim-wins race",
    "reload draft durability",
  ];
  result.ok = true;
}

async function run() {
  fixture = JSON.parse(
    await fs.readFile(path.join(temporary, "fixture.json"), "utf8"),
  );
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
  window.setSize(1600, 1040);
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
    "real production fake Host ready",
  );
  const settings = await evaluate("window.zenx.settings.get()");
  assert.equal(settings.profile.defaultModel.providerProfileId, "fake");
  assert.equal(settings.hasApiKey, false);
  if (fixture.scenario === "origin") return runOrigin();
  const mainRow = `.thread-row-shell[data-thread-id="${fixture.main}"] > button.thread-row`;
  const otherRow = `.thread-row-shell[data-thread-id="${fixture.other}"] > button.thread-row`;
  const [color, note] = fixture.questions.filter(
    (q) => q.request.threadId === fixture.main,
  );
  const unknown = fixture.questions.find(
    (q) => q.request.threadId === fixture.other,
  );
  const card = (q) =>
    `.user-question-card[data-question-call-id="${q.request.callItemId}"]`;
  await selectThread(mainRow, "Select synthetic main conversation");
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('#thread-composer:not(:disabled)'))",
      ),
    "editable main Composer",
  );
  await typeOnce(
    "#thread-composer",
    "Synthetic independent main Composer draft.",
    "Native main Composer draft",
  );
  await evaluate(
    "(()=>{window.__informationComposer=document.querySelector('#thread-composer');return true})()",
  );
  await openInformation();
  await cardVisible(card(color));
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.user-question-card input:checked').length",
    ),
    0,
    "nothing preselected",
  );
  assert.equal(
    await evaluate(`${query(card(color) + " .primary-button")}.disabled`),
    true,
    "empty answer cannot send",
  );
  await click(
    card(color) + " .user-question-option:first-of-type input",
    "Select Blue without submitting",
  );
  await typeOnce(
    card(color) + " textarea",
    "Synthetic custom color detail.",
    "Native per-request color text",
  );
  await cardVisible(card(note));
  await typeOnce(
    card(note) + " textarea",
    "Synthetic independent note draft.",
    "Native separate request draft",
  );
  assert.equal(responseAttempts.length, 0, "editing never submits");
  await capture("01-wide-light-independent-drafts", "dock");

  await click(
    ".information-toolbar button",
    "Hide questions without cancelling",
  );
  await until(
    () =>
      evaluate(
        `document.querySelector('.information-toolbar button')?.getAttribute('aria-expanded')==='false'`,
      ),
    "explicit hide settled",
  );
  await openInformation();
  assert.equal(
    await evaluate(`${query(card(color) + " textarea")}.value`),
    "Synthetic custom color detail.",
  );
  await selectThread(otherRow, "Switch Thread with independent drafts");
  await openInformation();
  await cardVisible(card(unknown));
  assert.equal(
    await evaluate(`${query(card(unknown) + " textarea")}.value`),
    "",
  );
  await selectThread(mainRow, "Return to original question drafts", true);
  await openInformation();
  await cardVisible(card(note));
  assert.equal(
    await evaluate(`${query(card(note) + " textarea")}.value`),
    "Synthetic independent note draft.",
  );
  assert.equal(
    await evaluate("document.querySelector('#thread-composer')?.value"),
    "Synthetic independent main Composer draft.",
  );
  assert.equal(
    responseAttempts.length,
    0,
    "hide/switch never cancels or sends",
  );

  // Only workspace maximization promises the same DOM; changing Thread does not.
  await evaluate(
    "(()=>{window.__informationComposer=document.querySelector('#thread-composer');return true})()",
  );
  await evaluate(
    `(async()=>{const owner={kind:'thread',id:${JSON.stringify(fixture.main)}},s=await window.zenx.threadSidebar.read(owner);return window.zenx.threadSidebar.update({owner,expectedRevision:s.revision,patch:{open:false,fullscreen:false,tabs:[{kind:'file',path:'fixture.txt'}],selectedTab:'file:fixture.txt'}})})()`,
  );
  await click("#thread-browser-toggle", "Open real workspace resource");
  await click(
    '.auxiliary-heading button[aria-label="Expand side panel"]',
    "Internally maximize workspace, not OS fullscreen",
  );
  await click(
    '[data-tab-id="primary-conversation"] [role="tab"]',
    "Select same mounted main conversation Tab",
  );
  nativeTheme.themeSource = "dark";
  await until(
    () => evaluate("document.documentElement.dataset.appearance==='dark'"),
    "dark appearance",
  );
  await openInformation();
  await capture("02-maximized-main-dark-dock", "dock");
  assert.equal(result.cases.at(-1).geometry.composerIdentity, true);
  assert.equal(
    result.cases.at(-1).geometry.draft,
    "Synthetic independent main Composer draft.",
  );
  window.setSize(1000, 900);
  await capture("03-narrow-main-overlay", "overlay");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await until(
    () =>
      evaluate(
        "document.activeElement===document.querySelector('.information-toolbar button')&&!document.querySelector('.information-popover')",
      ),
    "Escape dismisses, returns focus, no cancellation",
  );
  assert.equal(responseAttempts.length, 0);
  window.setSize(1600, 1040);
  await openInformation();
  await cardVisible(card(color));
  await click(
    card(color) + " .primary-button",
    "Explicit Send exact question answer",
  );
  await until(
    () => Promise.resolve(responseAttempts.length === 1),
    "Host answer receipt",
  );
  assert.equal(responseAttempts[0].params.outcome, "answer");
  assert.deepEqual(responseAttempts[0].params.answers, [
    {
      questionId: "color",
      optionIds: ["blue"],
      text: "Synthetic custom color detail.",
    },
  ]);
  await until(
    () => evaluate(`!${query(card(color))}`),
    "claimed answer leaves attention",
  );
  await cardVisible(card(note));
  assert.equal(
    await evaluate(`${query(card(note) + " textarea")}.value`),
    "Synthetic independent note draft.",
  );
  await capture("04-answer-confirmed-other-draft-intact", "dock");
  await click(
    card(note) + " .user-question-actions > button:first-child",
    "Explicit Cancel this entire request",
  );
  await until(
    () => Promise.resolve(responseAttempts.length === 2),
    "Host cancel receipt",
  );
  assert.equal(responseAttempts[1].params.outcome, "cancel");
  assert.equal("answers" in responseAttempts[1].params, false);
  await until(
    () => evaluate(`!${query(card(note))}`),
    "cancelled request leaves attention",
  );
  assert.equal(
    await evaluate("document.querySelector('#thread-composer')?.value"),
    "Synthetic independent main Composer draft.",
  );

  await selectThread(
    otherRow,
    "Select synthetic unknown-outcome conversation",
    true,
  );
  await openInformation();
  await cardVisible(card(unknown));
  await typeOnce(
    card(unknown) + " textarea",
    "Synthetic free-text-only answer.",
    "Native answer without choosing authored option",
  );
  loseNextReply = true;
  await click(
    card(unknown) + " .primary-button",
    "Explicit Send with one deliberate lost reply",
  );
  await until(
    () =>
      evaluate(
        `${query(card(unknown) + " .user-question-status")}?.textContent==='Response unconfirmed'`,
      ),
    "real unknown UI",
  );
  assert.equal(responseAttempts.length, 3);
  assert.deepEqual(responseAttempts[2].params.answers, [
    {
      questionId: "scope",
      optionIds: [],
      text: "Synthetic free-text-only answer.",
    },
  ]);
  assert.equal(
    await evaluate(`${query(card(unknown) + " .primary-button")}?.disabled`),
    true,
    "unknown cannot resend",
  );
  await capture("05-real-host-reply-lost-unknown", "dock");
  // The last action is the real Check response button, not a direct RPC replacement.
  await click(
    card(unknown) + " .user-question-actions > button:last-child",
    "Read-only Check response for same intent",
  );
  await until(
    () =>
      Promise.resolve(
        exactReads.some(
          (r) =>
            r.params.clientUserMessageId ===
              responseAttempts[2].params.clientUserMessageId &&
            r.reply.response.status === "claimed",
        ),
      ),
    "authoritative exact claimed readback",
  );
  await until(
    () => evaluate(`!${query(card(unknown))}`),
    "confirmed claimed card resolved",
  );
  assert.equal(responseAttempts.length, 3, "status check never resends");
  result.receipts = responseAttempts.map(({ params, reply }) => ({
    params,
    questionState: reply.question.state,
    response: reply.question.response,
  }));
  result.reconciledRead = exactReads.at(-1);
  result.notCovered = [
    "whole-batch recall to origins",
    "sidebar summary/ordering",
    "live publication into selected or background Desktop",
    "Windows native UI",
    ">32 pagination",
    "concurrent clients",
    "reload draft durability",
  ];
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
    releaseWithdrawnRead?.();
    for (const release of fixture?.releaseFiles ?? [])
      await fs.writeFile(release, "driver cleanup");
    if (fixture?.scenario === "origin") clipboard.clear();
    await fs.writeFile(
      path.join(directory, "acceptance.json"),
      JSON.stringify(result, null, 2),
    );
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
  });
