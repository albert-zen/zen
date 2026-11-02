/** Owns only a disposable CI Electron instance. No remote debugging or sandbox bypass. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, session } = require("electron");
assert.ok(["win32", "darwin"].includes(process.platform));
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.ok(process.versions.electron);
assert.ok(
  !process.argv.some(
    (a) => a === "--no-sandbox" || a.startsWith("--remote-debugging"),
  ),
);
assert.equal(app.isPackaged, true, "A real packaged bundle is required");
assert.notEqual(
  process.defaultApp,
  true,
  "Default Electron script mode is not representative",
);
const [directory, version, temporary] = process.argv.slice(1, 4);
assert.ok(directory && temporary && ["before", "current"].includes(version));
app.setPath("userData", path.join(temporary, "profile"));
app.setPath("home", path.join(temporary, "home"));
// The private Windows profile has no OS-registered Documents known folder.
// Point only this owned Electron app at the directory created by its launcher.
app.setPath("documents", path.join(temporary, "home", "Documents"));
const result = {
  ok: false,
  harnessVersion: "cv-reading-correctness-v1",
  version,
  platform: process.platform,
  electron: process.versions.electron,
  scope:
    "Correctness-only real packaged App with private synthetic journal; no send, no performance acceptance claim.",
  cases: [],
  stage: "bootstrap",
  steps: [],
  blockedExternalRequests: 0,
};
let window;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Catch renderer exceptions before Electron replaces them with an opaque IPC rejection.
// JSON-normalize successes too: only plain data crosses this diagnostic boundary.
function diagnosticFailure(code) {
  const error = new Error("Owned diagnostic failure");
  error.diagnosticCode = code;
  throw error;
}
function diagnosticEvaluation(expression) {
  return `(async()=>{try{return {ok:true,value:JSON.parse(JSON.stringify(await (${expression})??null))}}catch{return {ok:false}}})()`;
}
const evaluate = async (expression) => {
  const reply = await window.webContents.executeJavaScript(
    diagnosticEvaluation(expression),
    true,
  );
  if (reply.ok !== true) diagnosticFailure("renderer-observation-failed");
  return reply.value;
};
async function until(check, label) {
  result.waitingFor = label;
  console.log(
    "CV_READING_STAGE " +
      JSON.stringify({ phase: "wait", label, mainMs: performance.now() }),
  );
  for (let i = 0; i < 400; i++) {
    if (await check()) {
      delete result.waitingFor;
      console.log(
        "CV_READING_STAGE " +
          JSON.stringify({ phase: "ready", label, mainMs: performance.now() }),
      );
      return;
    }
    await pause(100);
  }
  diagnosticFailure("ui-readiness-timeout");
}
async function click(expression, label) {
  result.pendingOperation = label;
  await until(
    async () => Boolean(await evaluate(`Boolean(${expression})`)),
    label,
  );
  const p = await evaluate(
    `(()=>{const e=${expression},r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(!e.contains(document.elementFromPoint(x,y))){const describe=n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n);return {tag:n.tagName,id:n.id,className:typeof n.className==='string'?n.className:n.className.baseVal,bounds:{left:b.left,top:b.top,width:b.width,height:b.height},zIndex:s.zIndex,visibility:s.visibility,pointerEvents:s.pointerEvents}};throw Error('Obscured target: '+${JSON.stringify(label)}+' '+JSON.stringify({target:describe(e),point:{x,y},hitStack:document.elementsFromPoint(x,y).slice(0,5).map(describe)}))}return {x:Math.round(x),y:Math.round(y)}})()`,
  );
  window.show();
  window.focus();
  window.webContents.focus();
  await until(
    async () => window.isFocused() && window.webContents.isFocused(),
    "Owned native window and renderer focus",
  );
  window.webContents.sendInputEvent({
    type: "mouseDown",
    button: "left",
    clickCount: 1,
    ...p,
  });
  window.webContents.sendInputEvent({
    type: "mouseUp",
    button: "left",
    clickCount: 1,
    ...p,
  });
  result.steps.push(label);
  console.log(
    "CV_READING_STAGE " +
      JSON.stringify({
        phase: "native-input-dispatched",
        label,
        mainMs: performance.now(),
      }),
  );
  delete result.pendingOperation;
}
// Electron wheel delta sign is opposite to DOM deltaY (existing native capture contract).
function sidebarWheelDelta(row, viewport) {
  if (row.top >= viewport.top + 4 && row.bottom <= viewport.bottom - 4)
    return 0;
  if (row.bottom > viewport.bottom - 4)
    return -Math.ceil(
      Math.min(360, Math.max(80, row.bottom - viewport.bottom + 16)),
    );
  return Math.ceil(Math.min(360, Math.max(80, viewport.top - row.top + 16)));
}
async function revealThreadWithSidebarWheel(expression) {
  result.sidebarSelectionScroll = [];
  window.show();
  window.focus();
  window.webContents.focus();
  await until(
    async () => window.isFocused() && window.webContents.isFocused(),
    "Owned window focus for sidebar selection",
  );
  for (let attempt = 0; attempt < 6; attempt++) {
    const state = await evaluate(
      `(()=>{const row=${expression},scroller=row?.closest('.sidebar-scroll');if(!row||!scroller)throw Error('Thread row is not in the left sidebar scroller');const r=row.getBoundingClientRect(),v=scroller.getBoundingClientRect(),footer=document.querySelector('.sidebar-footer')?.getBoundingClientRect(),viewport={left:v.left,right:v.right,top:Math.max(0,v.top),bottom:Math.min(innerHeight,v.bottom,footer?.top??innerHeight)},x=Math.round((viewport.left+viewport.right)/2),y=Math.round((viewport.top+viewport.bottom)/2);if(!scroller.contains(document.elementFromPoint(x,y)))throw Error('Left sidebar wheel point is obscured');return {row:{top:r.top,bottom:r.bottom},viewport,point:{x,y},scrollTop:scroller.scrollTop,scrollLeft:scroller.scrollLeft}})()`,
    );
    const deltaY = sidebarWheelDelta(state.row, state.viewport);
    if (deltaY === 0) return;
    result.sidebarSelectionScroll.push({
      attempt,
      ...state,
      deltaX: 0,
      deltaY,
    });
    window.webContents.sendInputEvent({ type: "mouseMove", ...state.point });
    window.webContents.sendInputEvent({
      type: "mouseWheel",
      ...state.point,
      deltaX: 0,
      deltaY,
      canScroll: true,
      hasPreciseScrollingDeltas: true,
    });
    result.steps.push(
      "Diagnostic preparation: native vertical wheel in LEFT sidebar only",
    );
    await pause(300);
  }
  throw Error(
    "Created Thread was not fully visible after six bounded left-sidebar vertical wheel steps",
  );
}
const networkReady = app.whenReady().then(() => {
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
  });
});

// All observer helpers read current DOM; only their own bounded diagnostic state is written.
// No DOM insertion, property assignment, focus(), scrollTo(), Range mutation or RPC write.
function installObservation() {
  const q = (selector) => document.querySelector(selector);
  const bounds = () => {
    const view = q(".messages"),
      r = view.getBoundingClientRect(),
      z = q(".thread-view > .bottom-zone")?.getBoundingClientRect();
    return {
      left: Math.max(0, r.left),
      right: Math.min(innerWidth, r.right),
      top: Math.max(0, r.top),
      bottom: Math.min(innerHeight, r.bottom, z?.top ?? Infinity),
    };
  };
  const item = (id) =>
    q(
      `[data-quote-item-id=${JSON.stringify(id)}], [data-sent-message-id=${JSON.stringify(id)}]`,
    );
  const measure = (id) => {
    const e = item(id),
      b = bounds(),
      r = e?.getBoundingClientRect();
    if (!r) return null;
    const top = Math.max(r.top, b.top),
      bottom = Math.min(r.bottom, b.bottom),
      left = Math.max(r.left, b.left),
      right = Math.min(r.right, b.right);
    const hit = (y) => {
      const h = document.elementFromPoint((left + right) / 2, y);
      return h === e || e.contains(h);
    };
    return {
      id,
      turnId: e.closest("[data-turn-id]")?.dataset.turnId,
      top: r.top,
      bottom: r.bottom,
      height: r.height,
      bounds: b,
      offset: b.top - r.top,
      focused: document.activeElement === e,
      uncovered:
        bottom > top &&
        right > left &&
        hit(top + Math.min(1, (bottom - top) / 2)) &&
        hit(bottom - Math.min(1, (bottom - top) / 2)),
      pin: e.closest("[data-turn-id]")?.hasAttribute("data-reading-reveal"),
      scrollTop: q(".messages").scrollTop,
    };
  };
  const anchor = () => {
    const b = bounds(),
      h = b.bottom - b.top,
      w = b.right - b.left;
    // The same bounded nine hit positions as the public reading contract, no full-history rect scan.
    for (const y of [1, Math.min(24, h / 2), h / 2])
      for (const x of [0.5, 0.25, 0.75]) {
        const hit = document.elementFromPoint(b.left + w * x, b.top + y),
          turn = hit?.closest("[data-turn-id]");
        if (!turn || !q(".messages").contains(turn)) continue;
        const e =
            hit.closest("[data-quote-item-id], [data-sent-message-id]") ?? turn,
          r = e.getBoundingClientRect();
        if (
          r.width <= 0 ||
          r.height <= 0 ||
          r.bottom <= b.top ||
          r.top >= b.bottom
        )
          continue;
        return {
          turnId: turn.dataset.turnId,
          itemId: e.dataset.quoteItemId ?? e.dataset.sentMessageId ?? null,
          offset: b.top - r.top,
          top: q(".messages").scrollTop,
        };
      }
    return null;
  };
  const measureAnchor = (a) => {
    const turn = q(`[data-turn-id=${JSON.stringify(a.turnId)}]`),
      e = a.itemId ? item(a.itemId) : turn;
    if (!e || (!turn?.contains(e) && e !== turn)) return null;
    return {
      turnId: turn.dataset.turnId,
      itemId: a.itemId,
      offset: bounds().top - e.getBoundingClientRect().top,
      top: q(".messages").scrollTop,
    };
  };
  let stop = () => {},
    timeline = null;
  const begin = (id) => {
    stop();
    const view = q(".messages"),
      target = item(id),
      popup = q(".reference-details-popover"),
      dialog = q(".queued-message-editor");
    const events = [],
      closes = { popup: null, dialog: null },
      initial = {
        top: view.scrollTop,
        popup: !!popup,
        dialog: !!dialog,
        popupAnimation: popup
          ? getComputedStyle(popup).animationDuration
          : null,
        dialogAnimation: dialog
          ? getComputedStyle(dialog).animationDuration
          : null,
      };
    const push = (type, extra = {}) => {
      if (events.length < 160)
        events.push({ at: performance.now(), type, ...extra });
    };
    let popupClosed = false,
      dialogClosed = false,
      pinned = false;
    let resolveClosing;
    const closing = new Promise((resolve) => {
      resolveClosing = resolve;
    });
    const sample = () => {
      for (const [name, node] of [
        ["popup", popup],
        ["dialog", dialog],
      ])
        if (node) {
          if (
            node.isConnected &&
            node.dataset.state === "closed" &&
            !(name === "popup" ? popupClosed : dialogClosed)
          ) {
            if (name === "popup") popupClosed = true;
            else dialogClosed = true;
            push(name + "-closed-presence", {
              animationName: getComputedStyle(node).animationName,
              animationDuration: getComputedStyle(node).animationDuration,
            });
            if (name === "popup") resolveClosing(true);
          }
          if (!node.isConnected && closes[name] === null) {
            closes[name] = performance.now();
            push(name + "-removed");
          }
        }
      const pin =
        target
          ?.closest("[data-turn-id]")
          ?.hasAttribute("data-reading-reveal") ?? false;
      if (pin !== pinned) {
        pinned = pin;
        push(pin ? "pin-added" : "pin-removed");
      }
    };
    const scroll = () =>
      push("scroll", {
        top: view.scrollTop,
        pin:
          target
            ?.closest("[data-turn-id]")
            ?.hasAttribute("data-reading-reveal") ?? false,
      });
    const input = (e) =>
      push("input", {
        kind: e.type,
        trusted: e.isTrusted,
        popupConnected: popup?.isConnected ?? false,
        popupState: popup?.dataset.state ?? null,
        sidebarThreadId:
          e.target?.closest?.(".thread-row-shell")?.dataset.threadId ?? null,
      });
    const focus = (e) =>
      push("focus", {
        target:
          e.target === target
            ? "target"
            : e.target?.id === "thread-composer"
              ? "composer"
              : "other",
      });
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state", "data-reading-reveal"],
      childList: true,
    });
    view.addEventListener("scroll", scroll);
    document.addEventListener("focusin", focus, true);
    for (const type of ["wheel", "pointerdown", "keydown", "selectionchange"])
      document.addEventListener(type, input, true);
    timeline = { id, initial, events, closes };
    window.__readingProof.closing = () => closing;
    stop = () => {
      sample();
      observer.disconnect();
      view.removeEventListener("scroll", scroll);
      document.removeEventListener("focusin", focus, true);
      for (const type of ["wheel", "pointerdown", "keydown", "selectionchange"])
        document.removeEventListener(type, input, true);
    };
    return initial;
  };
  window.__readingProof = {
    bounds,
    item,
    measure,
    anchor,
    measureAnchor,
    begin,
    finish: () => {
      stop();
      return timeline;
    },
    oldView: null,
  };
  return true;
}
const expr = (fn, ...args) =>
  `(${fn.toString()})(${args.map((x) => JSON.stringify(x)).join(",")})`;
const read = (fn, ...args) => evaluate(expr(fn, ...args));
const frames = async () =>
  evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))))",
  );
const element = (selector) =>
  "document.querySelector(" + JSON.stringify(selector) + ")";
const message = (id) => `[data-sent-message-id=${JSON.stringify(id)}]`;
let fixture;
async function screenshot(name) {
  await frames();
  const capture = await window.webContents.capturePage();
  await fs.writeFile(
    path.join(directory, `reading-${name}.png`),
    capture.toPNG(),
  );
}
async function waitForFixtureRow(id) {
  result.stage = "fixture-row-readiness";
  await until(
    async () =>
      await read((id) => {
        const row = document.querySelector(
          `.thread-row-shell[data-thread-id=${JSON.stringify(id)}] > button.thread-row`,
        );
        return row instanceof HTMLButtonElement && row.isConnected;
      }, id),
    "exact-fixture-thread-row",
  );
  result.fixtureRowReady = true;
}
async function chooseThread(id) {
  const row = element(
    `.thread-row-shell[data-thread-id=${JSON.stringify(id)}] > button.thread-row`,
  );
  await revealThreadWithSidebarWheel(row);
  await click(row, "select-thread");
  await until(
    async () =>
      await evaluate(
        "Boolean(document.querySelector('#thread-composer:not(:disabled)'))",
      ),
    "thread-composer",
  );
  if (id === fixture.threadId)
    await until(
      async () =>
        await read(
          (last) =>
            Boolean(
              document.querySelector(
                `[data-sent-message-id=${JSON.stringify(last)}]`,
              ),
            ),
          fixture.lastId,
        ),
      "exact-thread-messages",
    );
  else
    await until(
      async () =>
        await read(
          (last) =>
            !document.querySelector(
              `[data-sent-message-id=${JSON.stringify(last)}]`,
            ),
          fixture.lastId,
        ),
      "old-thread-unmounted",
    );
}
async function live() {
  if (await evaluate("Boolean(document.querySelector('.back-live'))"))
    await click(element(".back-live"), "back-to-live");
  await frames();
  await until(
    async () =>
      await read((id) => {
        const e = document.querySelector(
          `[data-sent-message-id=${JSON.stringify(id)}] .reference-token-details`,
        );
        if (!e) return false;
        const r = e.getBoundingClientRect(),
          b = window.__readingProof.bounds();
        return r.top >= b.top && r.bottom <= b.bottom;
      }, fixture.lastId),
    "last-reference-visible",
  );
}
async function wheel(deltaY) {
  const p = await read(() => {
    const b = window.__readingProof.bounds(),
      x = Math.round((b.left + b.right) / 2),
      y = Math.round((b.top + b.bottom) / 2);
    return { x, y, top: document.querySelector(".messages").scrollTop };
  });
  window.webContents.sendInputEvent({ type: "mouseMove", x: p.x, y: p.y });
  window.webContents.sendInputEvent({
    type: "mouseWheel",
    x: p.x,
    y: p.y,
    deltaX: 0,
    deltaY,
    canScroll: true,
    hasPreciseScrollingDeltas: true,
  });
  await until(
    async () =>
      await read(
        (top) =>
          Math.abs(document.querySelector(".messages").scrollTop - top) > 0.5,
        p.top,
      ),
    "native-wheel-moved",
  );
  return p;
}
function key(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
}
async function openSent(index) {
  await live();
  const selector = `${message(fixture.lastId)} .reference-token-details`;
  await click(
    `document.querySelectorAll(${JSON.stringify(selector)})[${index}]`,
    "open-reference-popup",
  );
  await until(
    async () =>
      await evaluate(
        "Boolean(document.querySelector('.reference-details-popover[data-state=\"open\"] .reference-open-source'))",
      ),
    "reference-popup-open",
  );
}
async function observeSource(id) {
  await read((id) => window.__readingProof.begin(id), id);
  await click(
    element(".reference-details-popover .reference-open-source"),
    "open-source",
  );
}
async function settledNavigation(id) {
  await until(
    async () =>
      await read((id) => {
        const e = window.__readingProof.item(id);
        return (
          e === document.activeElement &&
          !document.querySelector(
            ".reference-details-popover, .queued-message-editor",
          )
        );
      }, id),
    "source-focused-after-close",
  );
  await frames();
  const m = await read((id) => window.__readingProof.measure(id), id),
    trace = await read(() => window.__readingProof.finish());
  result.lastGeometry = m;
  result.lastTimeline = trace;
  assert.ok(m?.focused && m.uncovered, "actual-target-uncovered-and-focused");
  const height = m.bounds.bottom - m.bounds.top;
  if (m.height > height)
    assert.ok(
      Math.abs(m.top - (m.bounds.top + Math.min(8, height / 4))) <= 2,
      "tall-leading-edge-aligned",
    );
  else
    assert.ok(
      m.top >= m.bounds.top - 2 && m.bottom <= m.bounds.bottom + 2,
      "short-entire-target-visible",
    );
  assert.ok(
    trace.events.some(
      (e) => e.type === "popup-closed-presence" && e.animationName !== "none",
    ),
    "actual-popup-exit-presence-observed",
  );
  assert.ok(trace.closes.popup !== null, "actual-popup-removed");
  const lastClose = Math.max(trace.closes.popup, trace.closes.dialog ?? 0);
  assert.ok(
    trace.events
      .filter(
        (e) => e.type === "scroll" && Math.abs(e.top - trace.initial.top) > 0.5,
      )
      .every((e) => e.at >= lastClose),
    "no-scroll-before-actual-close",
  );
  assert.ok(
    trace.events
      .filter(
        (e) =>
          e.type === "pin-added" ||
          (e.type === "focus" && e.target === "target"),
      )
      .every((e) => e.at >= lastClose),
    "no-positioning-or-focus-before-actual-close",
  );
  return { geometry: m, timeline: trace };
}
function assertWaitingCancellation(timeline, kind, sidebarThreadId = null) {
  const input = timeline.events.find(
    (e) =>
      e.type === "input" &&
      e.kind === kind &&
      e.trusted &&
      (sidebarThreadId === null || e.sidebarThreadId === sidebarThreadId),
  );
  assert.ok(
    input?.popupConnected &&
      input.popupState === "closed" &&
      timeline.closes.popup !== null &&
      input.at < timeline.closes.popup,
    "cancellation-input-missed-closing-presence",
  );
  assert.ok(
    !timeline.events.some((e) => e.type === "pin-added"),
    "canceled-navigation-must-not-pin",
  );
}
async function record(name, runCase) {
  result.stage = name;
  delete result.lastGeometry;
  delete result.lastTimeline;
  const entry = { name, passed: false, evidence: null };
  result.cases.push(entry);
  try {
    entry.evidence = await runCase();
    entry.passed = true;
    await screenshot(name);
  } catch (error) {
    entry.evidence = {
      lastGeometry: result.lastGeometry ?? null,
      lastTimeline: result.lastTimeline ?? null,
    };
    try {
      entry.evidence.currentTimeline = await read(() =>
        window.__readingProof.finish(),
      );
      entry.evidence.currentAnchor = await read(() =>
        window.__readingProof.anchor(),
      );
    } catch {}
    throw error;
  }
}
async function run() {
  await networkReady;
  await until(async () => {
    window = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith("/renderer/index.html"),
    );
    return !!window;
  }, "production-renderer");
  const p = window.webContents.getLastWebPreferences();
  assert.equal(p.sandbox, true);
  assert.equal(p.contextIsolation, true);
  assert.equal(p.nodeIntegration, false);
  result.runtimePreferences = {
    sandbox: p.sandbox,
    contextIsolation: p.contextIsolation,
    nodeIntegration: p.nodeIntegration,
  };
  window.setSize(1280, 820);
  window.show();
  window.focus();
  window.webContents.focus();
  await until(
    async () =>
      await evaluate(
        "Boolean(document.querySelector('.app-shell')&&window.zenx?.protocol)",
      ),
    "production-app-mounted",
  );
  await until(
    async () =>
      await evaluate(
        "window.zenx.protocol.getStatus().then(s=>s.type==='ready')",
      ),
    "fake-host-ready",
  );
  const settings = await evaluate("window.zenx.settings.get()");
  assert.equal(settings.profile.defaultModel.providerProfileId, "fake");
  assert.equal(settings.hasApiKey, false);
  assert.equal(settings.subscription.authenticated, false);
  fixture = JSON.parse(
    await fs.readFile(path.join(temporary, "reading-fixture.json"), "utf8"),
  );
  result.fixture = { ...fixture };
  // Match the established paired driver's readiness boundary before any sidebar geometry/input.
  await waitForFixtureRow(fixture.threadId);
  result.stage = "fixture-thread-selection";
  await chooseThread(fixture.threadId);
  await read(installObservation);
  const initial = await read(() => ({
    turns: document.querySelectorAll(".messages [data-turn-id]").length,
    users: document.querySelectorAll(".messages [data-sent-message-id]").length,
  }));
  assert.equal(initial.turns, 1000);
  assert.equal(initial.users, 1000);
  result.initial = initial;
  await record("cv-skip", async () => {
    const value = await read(() => {
      const e = document.querySelector('.turn[data-history-layout="auto"]');
      if (!e) return null;
      const s = getComputedStyle(e);
      return {
        turnId: e.dataset.turnId,
        contentVisibility: s.contentVisibility,
        intrinsicBlockSize: s.containIntrinsicBlockSize,
        ignoringAuto: e.checkVisibility(),
        includingAuto: e.checkVisibility({ contentVisibilityAuto: true }),
      };
    });
    assert.ok(value);
    assert.equal(value.contentVisibility, "auto");
    assert.equal(value.ignoringAuto, true);
    assert.equal(value.includingAuto, false);
    return value;
  });
  await record("short-quote-close", async () => {
    await openSent(0);
    await observeSource(fixture.shortId);
    const e = await settledNavigation(fixture.shortId);
    assert.ok(
      e.geometry.height < e.geometry.bounds.bottom - e.geometry.bounds.top,
    );
    return e;
  });
  await record("tall-quote-close", async () => {
    await openSent(1);
    await observeSource(fixture.tallId);
    const e = await settledNavigation(fixture.tallId);
    assert.ok(
      e.geometry.height > e.geometry.bounds.bottom - e.geometry.bounds.top,
    );
    return e;
  });
  await record("cold-thread-restore", async () => {
    await wheel(-180);
    await frames();
    const before = await read(() => {
      window.__readingProof.oldView = document.querySelector(".messages");
      return window.__readingProof.anchor();
    });
    assert.ok(before);
    await chooseThread(fixture.otherId);
    assert.equal(
      await read(() => window.__readingProof.oldView.isConnected),
      false,
    );
    await chooseThread(fixture.threadId);
    await frames();
    const after = await read(
      (a) => window.__readingProof.measureAnchor(a),
      before,
    );
    assert.ok(after);
    assert.ok(
      Math.abs(after.offset - before.offset) <= 2,
      "cold-restore-same-anchor-offset",
    );
    return { before, after, oldDomUnmounted: true };
  });
  await record("resize-anchor", async () => {
    const before = await read(() => window.__readingProof.anchor());
    assert.ok(before);
    await read(
      (id) => window.__readingProof.begin(id),
      before.itemId ?? fixture.tallId,
    );
    const values = [];
    for (const width of [1024, 1280]) {
      window.setSize(width, 820);
      await frames();
      const actual = await read(
        (a) => window.__readingProof.measureAnchor(a),
        before,
      );
      assert.ok(actual);
      values.push({ width, ...actual });
      assert.ok(
        Math.abs(actual.offset - before.offset) <= 2,
        "width-resize-preserves-anchor-offset",
      );
    }
    return {
      before,
      values,
      timeline: await read(() => window.__readingProof.finish()),
      overflowAnchor: await read(
        () =>
          getComputedStyle(document.querySelector(".messages")).overflowAnchor,
      ),
    };
  });
  await record("native-selection", async () => {
    // Navigate the short source then drag from it into the adjacent assistant, using native pointer input.
    await openSent(0);
    await observeSource(fixture.shortId);
    await settledNavigation(fixture.shortId);
    const points = await read((id) => {
      const e = window.__readingProof.item(id),
        other = e.closest("[data-turn-id]").querySelector(".agent-copy"),
        a = e.querySelector(".user-bubble p") ?? e,
        b = other?.querySelector("p");
      if (!b) return null;
      const r = a.getBoundingClientRect(),
        s = b.getBoundingClientRect(),
        v = window.__readingProof.bounds();
      return {
        from: { x: Math.round(r.left + 1), y: Math.round(r.top + 10) },
        to: {
          x: Math.round(s.right - 1),
          y: Math.round(s.top + 10),
        },
        within: r.top >= v.top && s.top + 15 < v.bottom,
      };
    }, fixture.shortId);
    assert.ok(points?.within, "two-real-message-selection-endpoints-visible");
    window.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      ...points.from,
    });
    for (let i = 1; i <= 8; i++) {
      window.webContents.sendInputEvent({
        type: "mouseMove",
        button: "left",
        modifiers: ["leftButtonDown"],
        x: Math.round(points.from.x + ((points.to.x - points.from.x) * i) / 8),
        y: Math.round(points.from.y + ((points.to.y - points.from.y) * i) / 8),
      });
      await pause(16);
    }
    window.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      ...points.to,
    });
    await until(
      async () => await read(() => !getSelection().isCollapsed),
      "native-selection-created",
    );
    const before = await read(() => ({
      text: getSelection().toString(),
      anchor: getSelection().anchorNode?.parentElement?.closest(
        "[data-quote-item-id], [data-sent-message-id]",
      )?.dataset.quoteItemId,
      focus: getSelection().focusNode?.parentElement?.closest(
        "[data-quote-item-id], [data-sent-message-id]",
      )?.dataset.quoteItemId,
    }));
    assert.ok(
      before.text.includes("Synthetic short source") &&
        before.text.includes("Synthetic assistant 400"),
      "native-drag-crosses-message-boundary",
    );
    window.setSize(1120, 820);
    await frames();
    assert.equal(
      await read(() => getSelection().toString()),
      before.text,
      "resize-does-not-rewrite-selection",
    );
    window.setSize(1280, 820);
    await frames();
    return before;
  });
  await record("queue-dual-close-draft", async () => {
    await live();
    await click(
      element(
        `[data-queue-id=${JSON.stringify(fixture.queueId)}] .queue-row-edit`,
      ),
      "open-queue-editor",
    );
    await until(
      async () =>
        await evaluate(
          "Boolean(document.querySelector('.queued-message-editor .cm-content'))",
        ),
      "rich-queue-editor",
    );
    await click(
      element(".queued-message-editor .cm-content"),
      "focus-queue-draft",
    );
    await until(
      async () =>
        await read(() =>
          document.activeElement?.classList.contains("cm-content"),
        ),
      "queue-editor-real-focus",
    );
    key("ArrowDown", ["meta"]);
    window.webContents.insertText(" UNSAVED synthetic reading draft");
    await until(
      async () =>
        await read(() =>
          document
            .querySelector(".queued-message-editor .cm-content")
            .textContent.includes("UNSAVED synthetic reading draft"),
        ),
      "queue-draft-input-confirmed",
    );
    await click(
      element(".queued-message-editor .reference-token-details"),
      "open-queue-reference",
    );
    await observeSource(fixture.shortId);
    const evidence = await settledNavigation(fixture.shortId);
    assert.ok(evidence.timeline.initial.dialog);
    assert.ok(
      evidence.timeline.events.some(
        (e) =>
          e.type === "dialog-closed-presence" && e.animationName !== "none",
      ),
    );
    assert.ok(evidence.timeline.closes.dialog !== null);
    await click(
      element(
        `[data-queue-id=${JSON.stringify(fixture.queueId)}] .queue-row-edit`,
      ),
      "reopen-queue-draft",
    );
    await until(
      async () =>
        await read(() =>
          document
            .querySelector(".queued-message-editor .cm-content")
            ?.textContent.includes("UNSAVED synthetic reading draft"),
        ),
      "unsaved-queue-draft-retained",
    );
    key("Escape");
    await until(
      async () =>
        await read(() => !document.querySelector(".queued-message-editor")),
      "ordinary-escape-close",
    );
    return { ...evidence, unsavedDraftRetained: true };
  });
  await record("waiting-wheel-cancels", async () => {
    await openSent(0);
    await observeSource(fixture.shortId);
    await read(() =>
      Promise.race([
        window.__readingProof.closing(),
        new Promise((_, reject) =>
          setTimeout(() => reject(Error("close-signal-unobserved")), 2000),
        ),
      ]),
    );
    assert.equal(
      await read(() =>
        Boolean(
          document.querySelector(
            '.reference-details-popover[data-state="closed"]',
          ),
        ),
      ),
      true,
      "actual-closing-presence-still-current-before-input",
    );
    await wheel(90);
    await until(
      async () =>
        await read(() => !document.querySelector(".reference-details-popover")),
      "popup-removed-after-wheel",
    );
    await frames();
    const timeline = await read(() => window.__readingProof.finish());
    assertWaitingCancellation(timeline, "wheel");
    assert.ok(
      !timeline.events.some((e) => e.type === "focus" && e.target === "target"),
    );
    assert.equal(
      await read(
        (id) => window.__readingProof.item(id) === document.activeElement,
        fixture.shortId,
      ),
      false,
    );
    return timeline;
  });
  await record("waiting-owner-cancels", async () => {
    await openSent(0);
    await observeSource(fixture.shortId);
    await read(() =>
      Promise.race([
        window.__readingProof.closing(),
        new Promise((_, reject) =>
          setTimeout(() => reject(Error("close-signal-unobserved")), 2000),
        ),
      ]),
    );
    assert.equal(
      await read(() =>
        Boolean(
          document.querySelector(
            '.reference-details-popover[data-state="closed"]',
          ),
        ),
      ),
      true,
      "actual-closing-presence-still-current-before-input",
    );
    await chooseThread(fixture.otherId);
    await frames();
    const timeline = await read(() => window.__readingProof.finish());
    assertWaitingCancellation(timeline, "pointerdown", fixture.otherId);
    assert.ok(
      !timeline.events.some((e) => e.type === "focus" && e.target === "target"),
    );
    assert.equal(
      await read(
        (id) => Boolean(window.__readingProof.item(id)),
        fixture.shortId,
      ),
      false,
    );
    return timeline;
  });
  result.stage = "complete";
  result.ok = true;
}

async function verifyPackagedRuntime() {
  const helperHashes = {};
  for (const name of [
    "zenx-accessibility",
    "zenx-bound-target",
    "zenx-foreground-input",
    "zenx-ocr",
  ]) {
    const relative = `native-helpers/${name}`;
    const file = path.join(process.resourcesPath, relative);
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.mode & 0o111);
    helperHashes[relative] = createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
  }
  result.packagedRuntime = {
    isPackaged: app.isPackaged,
    defaultApp: process.defaultApp === true,
    helperHashes,
    productionEntrySha256: createHash("sha256")
      .update(await fs.readFile(path.join(__dirname, "../out/main/index.js")))
      .digest("hex"),
  };
}
const failureReasons = new Set([
  "correctness-assertion-or-owned-driver-failed",
  "true",
  "renderer-observation-failed",
  "ui-readiness-timeout",
  "actual-target-uncovered-and-focused",
  "tall-leading-edge-aligned",
  "short-entire-target-visible",
  "actual-popup-exit-presence-observed",
  "actual-popup-removed",
  "no-scroll-before-actual-close",
  "no-positioning-or-focus-before-actual-close",
  "fake",
  "auto",
  "cold-restore-same-anchor-offset",
  "width-resize-preserves-anchor-offset",
  "two-real-message-selection-endpoints-visible",
  "native-drag-crosses-message-boundary",
  "resize-does-not-rewrite-selection",
  "actual-closing-presence-still-current-before-input",
  "cancellation-input-missed-closing-presence",
  "canceled-navigation-must-not-pin",
]);
void verifyPackagedRuntime()
  .then(
    () =>
      import(pathToFileURL(path.join(__dirname, "../out/main/index.js")).href),
  )
  .then(run)
  .catch(async (error) => {
    const code = error?.diagnosticCode ?? error?.message;
    result.reason = failureReasons.has(code)
      ? code
      : "correctness-assertion-or-owned-driver-failed";
    result.failureClass = [
      "cancellation-input-missed-closing-presence",
      "actual-closing-presence-still-current-before-input",
    ].includes(result.reason)
      ? "fixture-window-not-reached"
      : "assertion-or-driver-failure";
    if (window && !window.isDestroyed())
      try {
        await screenshot("failure");
      } catch {}
  })
  .finally(async () => {
    await fs.writeFile(
      path.join(directory, "reading-correctness.json"),
      JSON.stringify(result, null, 2),
    );
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
  });
