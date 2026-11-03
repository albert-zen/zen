/** Synthetic observer contract tests, not native timing evidence. Run from a
 * checkout with its normal jsdom dependency installed. No Electron is started. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const { JSDOM } = createRequire(path.resolve("package.json"))("jsdom");

const source = readFileSync(
  path.join(__dirname, "capture-send-feedback-verified-frame.cjs"),
  "utf8",
);
const observer = source.slice(
  source.indexOf("function installObservation("),
  source.indexOf("\nasync function run()"),
);
assert.ok(observer.startsWith("function installObservation("));

function fixture({
  layoutObservation = false,
  intersectionObservation = false,
  cachedOwnValue = false,
  activationKind = "click",
  cachedPresenceStyle = false,
  activationSnapshotCost = 0,
  virtual = false,
} = {}) {
  const dom = new JSDOM(
    '<main class="thread-view"><div class="messages"><div class="messages-inner"></div></div><div class="bottom-zone"><textarea id="thread-composer"></textarea><div class="composer-send-control"><button class="action-orb send">Send</button></div></div></main>',
    { runScripts: "outside-only" },
  );
  const { window: w } = dom;
  const d = w.document;
  if (virtual) {
    const scroller = d.querySelector(".messages");
    scroller.classList.add("experimental-transcript-viewport");
    // The real public total-content box contains a relative total-size layer
    // and the pending footer. The inner wrapper is deliberately not observed.
    scroller.innerHTML =
      '<div class="virtual-transcript-content"><div class="fixed-viewport-wrapper"></div><div class="virtual-transcript-footer"></div></div>';
  }
  const content = d.querySelector(
    ".messages > .virtual-transcript-content, .messages-inner",
  );
  let now = 100,
    id = 0,
    listener,
    offCount = 0;
  const frames = new Map();
  let geometryReads = 0;
  const errors = [];
  w.addEventListener("error", (event) => errors.push(String(event.error)));
  let layoutObserver;
  if (layoutObservation)
    w.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.targets = new Set();
        this.disconnected = false;
        layoutObserver = this;
      }
      observe(target) {
        this.targets.add(target);
      }
      disconnect() {
        this.disconnected = true;
        this.targets.clear();
      }
      deliver(target, height) {
        this.callback([{ target, contentRect: { width: 400, height } }]);
      }
    };
  let intersectionObserver;
  if (intersectionObservation)
    w.IntersectionObserver = class {
      constructor(callback, options) {
        this.callback = callback;
        this.targets = new Set();
        this.root = options.root;
        intersectionObserver = this;
      }
      observe(target) {
        this.targets.add(target);
      }
      unobserve(target) {
        this.targets.delete(target);
      }
      disconnect() {
        this.disconnected = true;
        this.targets.clear();
      }
      deliver(target, visible) {
        assert.ok(this.targets.has(target));
        this.callback([
          {
            target,
            isIntersecting: visible,
            intersectionRatio: visible ? 1 : 0,
            time: now,
            intersectionRect: {
              left: 10,
              top: 10,
              width: 400,
              height: visible ? 40 : 0,
            },
          },
        ]);
      }
    };
  Object.defineProperty(w.performance, "now", { value: () => now });
  const marks = new Map();
  w.performance.mark = (name) => marks.set(name, now);
  w.requestAnimationFrame = (callback) => {
    frames.set(++id, callback);
    return id;
  };
  w.cancelAnimationFrame = (key) => frames.delete(key);
  w.zenx = {
    protocol: {
      onNotification: (callback) => {
        listener = callback;
        return () => {
          listener = undefined;
          offCount++;
        };
      },
    },
  };
  const rect = {
    top: 10,
    left: 10,
    right: 410,
    bottom: 50,
    width: 400,
    height: 40,
  };
  w.Element.prototype.getBoundingClientRect = function () {
    geometryReads++;
    now += Number(this.dataset.cost ?? 0);
    return this.dataset.offscreen ? { ...rect, top: 2000, bottom: 2040 } : rect;
  };
  if (cachedOwnValue)
    Object.defineProperty(
      d.querySelector("#thread-composer"),
      "value",
      Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value"),
    );
  const originalOwnValueDescriptor = Object.getOwnPropertyDescriptor(
    d.querySelector("#thread-composer"),
    "value",
  );
  d.querySelector("#thread-composer").value = "synthetic-nonce";
  w.eval(
    observer +
      '; installObservation("synthetic-nonce", "thread-A", 0, ' +
      JSON.stringify(activationKind) +
      ");",
  );
  let presencePanel, presenceStyle;
  if (cachedPresenceStyle) {
    presencePanel = d.createElement("div");
    presencePanel.className = "composer-send-popover";
    presencePanel.dataset.state = "open";
    presencePanel.style.animationName = "private-fixture-animation";
    presencePanel.style.display = "block";
    d.body.append(presencePanel);
    presenceStyle = w.getComputedStyle(presencePanel);
    void presenceStyle.animationName;
  }
  if (layoutObservation) layoutObserver.deliver(content, 1000);
  if (activationSnapshotCost) {
    const query = d.querySelector.bind(d);
    d.querySelector = (selector) => {
      if (selector === '.composer-send-popover[data-state="open"]')
        now += activationSnapshotCost;
      return query(selector);
    };
  }
  if (activationKind === "enter")
    d.querySelector("#thread-composer").dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  else
    d.querySelector("button").dispatchEvent(
      new w.MouseEvent("click", { bubbles: true }),
    );
  d.querySelector("#thread-composer").value = "";
  const row = async (
    kind,
    clientOrMessage = kind === "pending" ? "client-A" : "message-A",
  ) => {
    const article = d.createElement("article");
    article.className = kind === "pending" ? "pending-send-row" : "user-row";
    if (kind === "pending") {
      article.dataset.pendingSendClientId = clientOrMessage;
      article.dataset.sendState = "submitting";
    } else article.dataset.sentMessageId = clientOrMessage;
    const bubble = d.createElement("div");
    bubble.className = "user-bubble";
    bubble.textContent = "synthetic-nonce";
    article.append(bubble);
    (d.querySelector(".virtual-transcript-footer") ?? content).append(article);
    await new Promise(setImmediate);
    return { article, bubble };
  };
  return {
    d,
    w,
    row,
    record: w.__sendLatency,
    originalOwnValueDescriptor,
    presencePanel,
    presenceStyle,
    marks,
    geometryReads: () => geometryReads,
    queuedFrames: () => frames.size,
    resize(height) {
      layoutObserver.deliver(content, height);
    },
    resizeDisconnected: () => layoutObserver?.disconnected,
    layoutTargets: () => [...(layoutObserver?.targets ?? [])],
    intersect(target, visible) {
      intersectionObserver.deliver(target, visible);
    },
    intersectionDisconnected: () => intersectionObserver?.disconnected,
    frame() {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const cb of callbacks) cb(now);
    },
    notify({
      clientId = "client-A",
      messageId = "message-A",
      threadId = "thread-A",
    } = {}) {
      listener?.("zen/thread/event", {
        threadId,
        event: {
          type: "item",
          item: { type: "user_message", id: messageId, clientId },
        },
      });
    },
    close() {
      w.__sendLatency.stop();
      assert.equal(offCount, 1);
      if (intersectionObservation)
        assert.equal(intersectionObserver.disconnected, true);
      dom.window.close();
      assert.deepEqual(
        errors,
        [],
        "observer must not swallow DOM event-handler failures",
      );
    },
  };
}

test("v2 timestamp is retained while verified time includes geometry cost and another frame", async () => {
  const f = fixture();
  try {
    const { bubble } = await f.row("pending");
    bubble.dataset.cost = "250";
    f.frame();
    assert.equal(f.record.pendingVisibleFrameMs - f.record.clickMs, 16);
    assert.ok(
      f.record.feedbackGeometryCompleteMs - f.record.pendingVisibleFrameMs >=
        500,
    );
    assert.equal(f.record.feedbackSubsequentFrameMs, undefined);
    assert.equal(f.record.clearSubsequentFrameMs, undefined);
    f.frame();
    assert.ok(
      f.record.feedbackSubsequentFrameMs > f.record.feedbackGeometryCompleteMs,
    );
    assert.ok(
      f.record.clearSubsequentFrameMs > f.record.clearGeometryCompleteMs,
    );
    assert.equal(f.record.feedbackClientId, "client-A");
  } finally {
    f.close();
  }
});

test("pending can be replaced by exact canonical identity before the next frame", async () => {
  const f = fixture();
  try {
    const pending = await f.row("pending");
    f.frame();
    pending.article.remove();
    f.notify();
    await f.row("canonical");
    f.frame();
    assert.equal(f.record.feedbackGeometryKind, "pending");
    assert.equal(f.record.feedbackSubsequentKind, "canonical");
    assert.equal(f.record.feedbackSubsequentMessageId, "message-A");
    assert.ok(Number.isFinite(f.record.bubbleVisibleFrameMs));
  } finally {
    f.close();
  }
});

test("canonical arriving after verified pending frames is still observed", async () => {
  const f = fixture();
  try {
    const pending = await f.row("pending");
    f.frame();
    f.frame();
    const verifiedGeometryReads = f.geometryReads();
    f.frame();
    assert.equal(
      f.geometryReads(),
      verifiedGeometryReads,
      "new geometry verification stops after both verified metrics settle",
    );
    pending.article.remove();
    f.notify();
    await f.row("canonical");
    f.frame();
    f.frame();
    assert.ok(Number.isFinite(f.record.feedbackSubsequentFrameMs));
    assert.ok(Number.isFinite(f.record.followingFrameMs));
    assert.equal(f.record.messageId, "message-A");
  } finally {
    f.close();
  }
});

for (const mismatch of [
  { clientId: "client-wrong" },
  { threadId: "thread-wrong" },
  { messageId: "message-wrong" },
]) {
  test(
    "canonical identity mismatch cannot complete the pending observation: " +
      JSON.stringify(mismatch),
    async () => {
      const f = fixture();
      try {
        const pending = await f.row("pending");
        f.frame();
        pending.article.remove();
        f.notify(mismatch);
        await f.row("canonical");
        f.frame();
        f.frame();
        assert.equal(f.record.feedbackSubsequentFrameMs, undefined);
      } finally {
        f.close();
      }
    },
  );
}

test("detached pending node does not count as another visible frame", async () => {
  const f = fixture();
  try {
    const pending = await f.row("pending");
    f.frame();
    pending.article.remove();
    f.frame();
    assert.equal(f.record.feedbackSubsequentFrameMs, undefined);
  } finally {
    f.close();
  }
});

for (const hidden of ["hidden", "offscreen"]) {
  test(hidden + " node cannot establish verified feedback", async () => {
    const f = fixture();
    try {
      const { bubble } = await f.row("pending");
      if (hidden === "hidden") bubble.style.visibility = "hidden";
      else bubble.dataset.offscreen = "true";
      f.frame();
      f.frame();
      assert.equal(f.record.feedbackGeometryCompleteMs, undefined);
      assert.equal(f.record.feedbackSubsequentFrameMs, undefined);
    } finally {
      f.close();
    }
  });
}

test("canonical-first path requires native identity, supports same-message remount and stops cleanly", async () => {
  const f = fixture();
  const first = await f.row("canonical");
  f.frame();
  assert.equal(f.record.feedbackGeometryCompleteMs, undefined);
  f.notify();
  f.frame();
  first.article.remove();
  await f.row("canonical");
  f.frame();
  assert.equal(f.record.feedbackClientId, "client-A");
  assert.equal(f.record.feedbackSubsequentKind, "canonical");
  const count = f.record.instrumentation.frameCallbacks;
  f.close();
  f.frame();
  assert.equal(f.record.instrumentation.frameCallbacks, count);
});

test("passive native resize evidence uses supplied entries from the actual total-content box without geometry reads", async () => {
  for (const virtual of [false, true]) {
    const f = fixture({ layoutObservation: true, virtual });
    try {
      const content = f.d.querySelector(
        virtual ? ".messages > .virtual-transcript-content" : ".messages-inner",
      );
      assert.ok(f.layoutTargets().includes(content));
      assert.equal(
        f
          .layoutTargets()
          .includes(f.d.querySelector(".fixed-viewport-wrapper")),
        false,
      );
      assert.equal(f.record.nativeLayoutReady, true);
      assert.deepEqual(
        JSON.parse(JSON.stringify(f.record.nativeLayoutAtClick.content)),
        { width: 400, height: 1000 },
      );
      await f.row("pending");
      const reads = f.geometryReads();
      f.resize(1100);
      assert.equal(f.geometryReads(), reads);
      const event = f.record.nativeLayoutEvents[0];
      assert.equal(event.pendingConnected, true);
      assert.equal(event.boxes[0].target, "content");
      assert.equal(event.boxes[0].height, 1100);
      assert.ok(event.atMs >= f.record.clickMs);
    } finally {
      f.close();
    }
    assert.equal(f.resizeDisconnected(), true);
  }
});
test("DOM mutation alone never fabricates resize delivery evidence", async () => {
  const f = fixture({ layoutObservation: true });
  try {
    const { bubble } = await f.row("pending");
    bubble.textContent = "same-box text change";
    await new Promise(setImmediate);
    assert.equal(f.record.nativeLayoutEvents.length, 0);
    f.resize(1000);
    assert.equal(f.record.nativeLayoutEvents.length, 1);
    assert.equal(f.record.nativeLayoutEvents[0].boxes[0].height, 1000);
  } finally {
    f.close();
  }
});

test("native intersection entry remains independent of geometry reads and is confirmed in a later connected frame", async () => {
  const f = fixture({ intersectionObservation: true });
  try {
    const { bubble } = await f.row("pending");
    const before = f.geometryReads();
    f.intersect(bubble, true);
    assert.equal(f.geometryReads(), before);
    assert.equal(f.record.pendingNativeIntersectionMs, f.record.clickMs);
    assert.equal(f.record.pendingNativeSubsequentFrameMs, undefined);
    f.frame();
    assert.ok(
      f.record.pendingNativeSubsequentFrameMs >
        f.record.pendingNativeIntersectionMs,
    );
  } finally {
    f.close();
  }
});

test("detached or non-intersecting pending cannot pass native subsequent-frame evidence", async () => {
  for (const state of ["detached", "outside"]) {
    const f = fixture({ intersectionObservation: true });
    try {
      const { article, bubble } = await f.row("pending");
      f.intersect(bubble, true);
      if (state === "detached") article.remove();
      else f.intersect(bubble, false);
      f.frame();
      assert.equal(f.record.pendingNativeSubsequentFrameMs, undefined);
    } finally {
      f.close();
    }
  }
});

test("failure evidence distinguishes canonical replacement with the same client from an absent pending node", async () => {
  for (const matches of [true, false]) {
    const f = fixture();
    try {
      const pending = await f.row("pending");
      pending.article.remove();
      await f.row("canonical");
      f.notify({ clientId: matches ? "client-A" : "client-other" });
    } finally {
      f.close();
    }
    assert.deepEqual(
      JSON.parse(JSON.stringify(f.record.nativeFinalOwnership)),
      {
        pendingConnected: false,
        canonicalConnected: true,
        canonicalMatchesPendingClient: matches,
      },
    );
  }
});

test("geometry probes observe existing calls only before pending delivery and restore prototypes on stop", async () => {
  const f = fixture();
  const wrappedRect = f.w.Element.prototype.getBoundingClientRect;
  const wrappedHeight = Object.getOwnPropertyDescriptor(
    f.w.Element.prototype,
    "scrollHeight",
  ).get;
  try {
    const scroll = f.d.querySelector(".messages");
    const content = f.d.querySelector(".messages-inner");
    scroll.getBoundingClientRect();
    content.getBoundingClientRect();
    void scroll.scrollHeight;
    f.w.getComputedStyle(f.d.querySelector("#thread-composer"));
    const counts = f.record.geometryProbes.counts;
    assert.equal(
      counts["getBoundingClientRect:transcript-scrollport"].calls,
      1,
    );
    assert.equal(counts["getBoundingClientRect:transcript-content"].calls, 1);
    assert.equal(counts["get.scrollHeight:transcript-scrollport"].calls, 1);
    assert.equal(counts["getComputedStyle:composer-editor"].calls, 1);
    await f.row("pending");
    scroll.getBoundingClientRect();
    assert.equal(
      counts["getBoundingClientRect:transcript-scrollport"].calls,
      1,
    );
    assert.equal(
      JSON.stringify(f.record.geometryProbes).includes("synthetic-nonce"),
      false,
    );
  } finally {
    f.close();
  }
  assert.notEqual(f.w.Element.prototype.getBoundingClientRect, wrappedRect);
  assert.notEqual(
    Object.getOwnPropertyDescriptor(f.w.Element.prototype, "scrollHeight").get,
    wrappedHeight,
  );
});

test("computed style reads preserve live object identity and attribute its existing CSSOM properties", () => {
  const f = fixture();
  try {
    const editor = f.d.querySelector("#thread-composer");
    const style = f.w.getComputedStyle(editor);
    assert.ok(style instanceof f.w.CSSStyleDeclaration);
    void style.display;
    void style.getPropertyValue("height");
    const counts = f.record.geometryProbes.counts;
    assert.equal(counts["style.display:composer-editor"].calls, 1);
    assert.ok(counts["style.getPropertyValue:composer-editor"].calls >= 1);
    assert.equal(
      JSON.stringify(f.record.geometryProbes).includes("synthetic-nonce"),
      false,
    );
  } finally {
    f.close();
  }
});

test("timeline integration remains single source, bounded and private", () => {
  assert.ok(source.includes("trace_buffer_size_in_kb: 131072"));
  assert.ok(source.includes("120000"));
  assert.ok(
    source.includes("if (result.ok) await reviewAndPublishProfile(rawPath)"),
  );
  assert.ok(
    source.includes("Raw profile withheld: private review did not pass"),
  );
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  assert.ok(launch.includes("timeline.review?.passed"));
  const workflow = readFileSync(
    path.join(
      __dirname,
      "../../../.github/workflows/send-information-layout-ab.yml",
    ),
    "utf8",
  );
  assert.ok(workflow.includes('"1280 enter control baseline candidate"'));
  assert.equal(
    workflow.includes('"1120 click narrow candidate baseline"'),
    false,
  );
  assert.equal(
    workflow.includes("owned-native-send-profile.private.json"),
    false,
  );
});

test("backend pair locks identical real Legend frontend and keeps reader regression outside timing", () => {
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  for (const identity of [
    "85ea447d369c144a5d1125fc7c5518ec62b276f2",
    "fa7a613cd33b9bbd2f3205c583a9a12d9c59acab",
    "662484149d6cfe97f427833cc37e9523cad03efe",
    "5a5c07ff286dfb6ba1283b13e0fe4b72ad64da08",
    "3f139c57708aae4abc1e083e401171f4ca39c200",
    "873fe8b84a6dadcf3defd3fa4948a05caefdb362",
  ])
    assert.ok(launch.includes(identity));
  const snapshots = new Function(
    "return (" +
      launch.slice(
        launch.indexOf("const snapshots = {") + "const snapshots = ".length,
        launch.indexOf("\n};", launch.indexOf("const snapshots = {")) + 2,
      ) +
      ")",
  )();
  assert.equal(snapshots.baseline.expectedVirtualTranscript, true);
  assert.equal(snapshots.candidate.expectedVirtualTranscript, true);
  assert.ok(
    launch.includes("const virtual = snapshot.expectedVirtualTranscript"),
  );
  assert.equal(launch.includes('sourceLabel === "candidate"'), false);
  const workflow = readFileSync(
    path.join(
      __dirname,
      "../../../.github/workflows/send-information-layout-ab.yml",
    ),
    "utf8",
  );
  assert.ok(
    workflow.includes("diagnostic/send-backend-fixed-frontend-20261103"),
  );
  assert.ok(workflow.includes("assert.deepEqual(builds[0], builds[1]"));
  for (const contract of [
    "pendingHosts",
    "historyGroups",
    "directTurns",
    "groupTurns",
    "outerGapPx",
    "historyGapPx",
  ])
    assert.ok(launch.includes("result.before.rendered." + contract));
  const samples = source.indexOf("result.samples = []");
  assert.ok(
    source.indexOf("const readerPoint =") >
      source.indexOf("await stopOwnedTrace();", samples),
  );
  assert.ok(
    source.includes("native resize must actually change window height"),
  );
  assert.ok(source.includes("native resize preserves paused reader offset"));
  assert.ok(source.includes("native resize must not restore live following"));
});

test("Selection getter probes preserve values and restore native descriptors", async () => {
  const f = fixture();
  const owner = f.w.Selection.prototype;
  const wrapped = Object.getOwnPropertyDescriptor(owner, "isCollapsed").get;
  try {
    const selection = f.d.getSelection();
    assert.equal(selection.isCollapsed, true);
    assert.equal(selection.anchorNode, null);
    assert.equal(selection.focusNode, null);
    assert.equal(selection.rangeCount, 0);
    assert.equal(selection.type, "None");
    const counts = f.record.geometryProbes.counts;
    assert.ok(counts["get.isCollapsed:document-selection"].calls >= 1);
    assert.ok(counts["get.anchorNode:document-selection"].calls >= 1);
    const calls = counts["get.isCollapsed:document-selection"].calls;
    await f.row("pending");
    assert.equal(selection.isCollapsed, true);
    assert.equal(counts["get.isCollapsed:document-selection"].calls, calls);
    assert.equal(
      JSON.stringify(f.record.geometryProbes).includes("synthetic-nonce"),
      false,
    );
  } finally {
    f.close();
  }
  assert.notEqual(
    Object.getOwnPropertyDescriptor(owner, "isCollapsed").get,
    wrapped,
  );
});

test("responsive checks stay after timing and assert real gap, bounds and reachability", () => {
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  assert.ok(
    source.indexOf("result.responsiveHistoryLayout = []") >
      source.indexOf(
        "await stopOwnedTrace();",
        source.indexOf("result.samples = []"),
      ),
  );
  assert.ok(
    source.includes(
      "real historical Turn geometry follows responsive parent gap",
    ),
  );
  assert.ok(source.includes("responsive primary action remains reachable"));
  assert.ok(
    source.includes(
      "responsive full App has no page-level horizontal overflow",
    ),
  );
  assert.ok(launch.includes("responsive-history-(?:390|640|641)"));
});

test("cached own textarea setter is observed without changing its getter or restoration", async () => {
  const f = fixture({ cachedOwnValue: true });
  const editor = f.d.querySelector("#thread-composer");
  try {
    assert.equal(
      Object.getOwnPropertyDescriptor(editor, "value").get,
      f.originalOwnValueDescriptor.get,
    );
    assert.deepEqual(
      Array.from(f.record.geometryProbes.textareaAccessorWrappers),
      [
        "own.value.set",
        "prototype.defaultValue.set",
        "prototype.selectionStart.get",
        "prototype.selectionEnd.get",
      ],
    );
    editor.defaultValue = "";
    void editor.selectionStart;
    void editor.selectionEnd;
    const counts = f.record.geometryProbes.counts;
    assert.equal(counts["set.value:composer-editor"].calls, 1);
    assert.equal(counts["set.defaultValue:composer-editor"].calls, 1);
    assert.ok(counts["get.selectionStart:composer-editor"].calls >= 1);
    assert.ok(counts["get.selectionEnd:composer-editor"].calls >= 1);
    await f.row("pending");
    editor.value = "private-later-draft";
    assert.equal(editor.value, "private-later-draft");
    assert.equal(counts["set.value:composer-editor"].calls, 1);
    assert.equal(
      JSON.stringify(f.record.geometryProbes).includes("private-later-draft"),
      false,
    );
  } finally {
    f.close();
  }
  const restored = Object.getOwnPropertyDescriptor(editor, "value");
  assert.equal(restored.get, f.originalOwnValueDescriptor.get);
  assert.equal(restored.set, f.originalOwnValueDescriptor.set);
});

test("synthetic Enter observer uses the activation clock without clicking Send", async () => {
  const f = fixture({ activationKind: "enter" });
  try {
    assert.equal(f.record.activationKind, "enter");
    assert.equal(f.record.sendPanelOpenAtActivation, false);
    await f.row("pending");
    f.frame();
    f.frame();
    assert.ok(Number.isFinite(f.record.feedbackSubsequentFrameMs));
  } finally {
    f.close();
  }
});
test("native activation trace mark precedes optional DOM snapshot work", () => {
  for (const activationKind of ["click", "enter"]) {
    const f = fixture({ activationKind, activationSnapshotCost: 12 });
    try {
      assert.equal(
        f.marks.get("zen-send-0-native-click") - f.record.clickMs,
        0,
        "DOM queries must not skew the existing record-to-trace clock contract",
      );
    } finally {
      f.close();
    }
  }
});
test("cached exact-panel style Proxy measures existing reads and restores without CSS value export", () => {
  const f = fixture({ cachedPresenceStyle: true });
  try {
    const style = f.presenceStyle,
      panel = f.presencePanel;
    panel.dataset.state = "closed";
    assert.equal(style.animationName, "private-fixture-animation");
    assert.equal(style.display, "block");
    assert.equal(style.getPropertyValue("display"), "block");
    const metadata = f.record.geometryProbes.cssReturnProxy;
    assert.equal(metadata.cachedStylesWrapped, 1);
    assert.equal(metadata.returnedObjectIdentityChanged, true);
    assert.equal(
      f.record.geometryProbes.counts["style.cached.animationName:send-controls"]
        .calls,
      1,
    );
    assert.equal(metadata.readSemantics[0].closedAtRead, true);
    assert.equal(
      metadata.readSemantics[0].matchesLastObservedOpenAnimationName,
      true,
    );
    assert.equal(
      JSON.stringify(f.record.geometryProbes).includes(
        "private-fixture-animation",
      ),
      false,
    );
    assert.equal(f.record.sendPanelOpenAtActivation, true);
  } finally {
    f.close();
  }
  assert.equal(f.record.geometryProbes.cssReturnProxy.stopped, true);
  const count =
    f.record.geometryProbes.counts["style.cached.animationName:send-controls"]
      .calls;
  void f.presenceStyle.animationName;
  assert.equal(
    f.record.geometryProbes.counts["style.cached.animationName:send-controls"]
      .calls,
    count,
  );
});

test("native invalidation causes keep only fixed reason/target codes and owned numeric locations", () => {
  const { styleInvalidationCauses } = require("./summarize-send-timeline.cjs");
  const bundle = { url: "file:///private/owned.js", sha256: "a".repeat(64) };
  const events = Array.from({ length: 30 }, (_, index) => ({
    name: "StyleRecalcInvalidationTracking",
    cat: "disabled-by-default-devtools.timeline.invalidationTracking",
    ph: "I",
    ts: 100 + index,
    args: {
      data: {
        reason: index === 0 ? "private-unknown-reason" : "Related style rule",
        nodeName:
          index === 0
            ? "private-unknown-node"
            : "SECTION class='turn completed'",
        nodeId: 8000 + index,
        extraData: "private-extra",
        selectorPart: "private-selector",
        subtree: true,
        stackTrace: [
          {
            url: bundle.url,
            lineNumber: index,
            columnNumber: 1,
            functionName: "private-function",
          },
          { url: "file:///private/foreign.js", lineNumber: 1, columnNumber: 1 },
        ],
      },
    },
  }));
  const result = styleInvalidationCauses(events, 100, 125, [bundle]);
  assert.equal(result.eventCount, 25);
  assert.equal(result.uniqueNodeCount, 25);
  assert.equal(
    result.groups.reduce((sum, group) => sum + group.events, 0),
    25,
  );
  assert.ok(
    result.groups.some(
      (group) =>
        group.reason === "related-rule" &&
        group.target === "turn" &&
        group.events === 24,
    ),
  );
  assert.ok(
    result.groups.some(
      (group) => group.reason === "unknown" && group.target === "other",
    ),
  );
  assert.equal(result.ownedLocations.length, 8);
  assert.ok(
    result.ownedLocations.every(
      (frame) =>
        frame.bundleIndex === 0 && frame.bundleSha256 === bundle.sha256,
    ),
  );
  assert.equal(JSON.stringify(result).includes("private-"), false);
  assert.equal(JSON.stringify(result).includes("nodeId"), false);
  const targets =
    "turn turn-history turn-final user-row agent-copy messages messages-inner composer composer-send-popover".split(
      " ",
    );
  const diverse = Array.from({ length: 27 }, (_, index) => ({
    ...events[1],
    name: [
      "ScheduleStyleInvalidationTracking",
      "StyleRecalcInvalidationTracking",
      "StyleInvalidatorInvalidationTracking",
    ][index % 3],
    args: {
      data: {
        ...events[1].args.data,
        nodeId: index + 1,
        nodeName: `DIV class='${targets[Math.floor(index / 3)]}'`,
        stackTrace: { callFrames: events[1].args.data.stackTrace },
      },
    },
  }));
  const capped = styleInvalidationCauses(diverse, 100, 125, [bundle]);
  assert.equal(capped.eventCount, 27);
  assert.equal(capped.groups.length, 16);
  assert.equal(capped.omittedGroups, 11);
  assert.equal(capped.ownedLocations.length, 1);
  const isolated = styleInvalidationCauses(
    [
      { ...events[1], cat: "blink.user_timing" },
      {
        ...events[1],
        args: {
          data: {
            ...events[1].args.data,
            nodeName: "DIV id='turn' class='unrelated'",
          },
        },
      },
    ],
    100,
    125,
    [bundle],
  );
  assert.equal(isolated.eventCount, 1);
  assert.equal(isolated.groups[0].target, "other");
  const tagged = styleInvalidationCauses(
    [
      {
        ...events[1],
        name: "ScheduleStyleInvalidationTracking",
        args: {
          data: {
            ...events[1].args.data,
            nodeName: "svg id='private-id'",
            selectorPart: "svg",
            changedPseudo: ":disabled",
          },
        },
      },
    ],
    100,
    125,
    [bundle],
  );
  assert.equal(tagged.groups[0].nodeTag, "svg");
  assert.equal(tagged.groups[0].selectorTag, "svg");
  assert.equal(tagged.groups[0].change, "disabled");
  assert.deepEqual(tagged.scheduledChanges, [
    { code: "changedPseudo:disabled", events: 1 },
  ]);
  assert.equal(JSON.stringify(tagged).includes("private-"), false);
  assert.throws(() =>
    styleInvalidationCauses([{ ...events[0], ts: NaN }], 0, 200, [bundle]),
  );
});
test("invalidation trace is bounded to first sample while all three native sends remain", () => {
  assert.ok(source.includes("traceSampleLimit: 1"));
  assert.ok(source.includes("if (repetition === 0) await stopOwnedTrace();"));
  assert.ok(source.includes("repetition < 3"));
});

test("real Legend experiment keeps full canonical data and natural buffer replacement outside measured sends", async () => {
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  assert.ok(launch.includes("mountedCount >= 2 && mountedCount < 200"));
  assert.ok(launch.includes("result.before.turns, count"));
  assert.ok(launch.includes("result.before.messages, count * 2"));
  assert.ok(
    launch.includes("result.before.rendered.canonicalMembers, mountedCount"),
  );
  assert.ok(
    launch.includes("result.before.rendered.exactCanonicalSuffix, true"),
  );
  assert.ok(
    source.includes("Mounted user ID belongs to full canonical projection"),
  );
  assert.ok(
    source.includes(
      "Geometry-ordered mounted rows preserve contiguous canonical order",
    ),
  );
  const natural = source.indexOf("if (result.before.rendered.virtual)");
  assert.ok(
    natural >
      source.indexOf(
        "await stopOwnedTrace();",
        source.indexOf("result.samples = []"),
      ),
  );
  assert.ok(natural > source.indexOf("const finalItems ="));
  assert.ok(
    source.includes(
      "Natural wheel replaces the actual Legend buffer, not an expanding page",
    ),
  );
  assert.ok(source.includes("experimental Back to live reaches actual bottom"));
  assert.equal(source.includes("mount previous 100 history rows"), false);
  assert.equal(source.includes("window.__historyMountAnchor"), false);
  const reload = source.indexOf("window.webContents.reload()");
  assert.ok(
    reload >
      source.indexOf(
        "sessionStorage.setItem('zenx.experimental.virtualTranscript','1')",
      ),
  );
  assert.ok(reload < source.indexOf("Select seeded production Thread"));
  for (const screenshot of [
    "legend-history-after-canonical.png",
    "legend-history-before-natural-up.png",
    "legend-history-after-natural-up.png",
  ])
    assert.ok(source.includes(screenshot));
  assert.ok(
    source.includes("if(virtual)turns.sort((a,b)=>a.rect.top-b.rect.top)"),
  );
  assert.ok(
    source.includes("const rect=virtual?row.getBoundingClientRect():null"),
  );
  assert.ok(source.includes("if(virtual)rows.sort((a,b)=>a.top-b.top)"));
  assert.ok(source.includes("turnNodes.slice(0,2)"));
  assert.ok(source.includes("clearTimeout(reloadTimer)"));
  assert.ok(
    source.includes(
      'window.webContents.removeListener("did-finish-load", reloadFinished)',
    ),
  );
  assert.ok(launch.includes(".messages > .virtual-transcript-content"));
  assert.equal(launch.includes("? 100 : count"), false);
  assert.ok(source.includes("not a user SLA or an acceptance threshold"));

  const mountedInspector = source.slice(
    source.indexOf("async function inspectMountedTranscript("),
    source.indexOf(
      "// Instrumented getter attribution plus existing browser observations.",
    ),
  );
  const canonical = Array.from({ length: 5 }, (_, index) => ({
    id: "turn-" + index,
    items: [{ type: "userMessage", id: "user-" + index }],
  }));
  const dom = new JSDOM('<div class="messages"></div>', {
    runScripts: "outside-only",
  });
  const d = dom.window.document;
  const inspectionResult = {};
  const inspect = new Function(
    "assert",
    "evaluate",
    "result",
    "return (" + mountedInspector + ")",
  )(
    assert,
    async (expression) => dom.window.eval(expression),
    inspectionResult,
  );
  d.querySelector(".messages").getBoundingClientRect = () => ({
    top: 100,
    bottom: 350,
    left: 0,
    right: 400,
    width: 400,
    height: 250,
  });
  let rowRectReads = 0;
  const render = (indices, virtual) => {
    const scroller = d.querySelector(".messages");
    scroller.className =
      "messages" + (virtual ? " experimental-transcript-viewport" : "");
    scroller.innerHTML = virtual
      ? '<div class="virtual-transcript-content" style="display:block"><div class="total-size"></div><div class="virtual-transcript-footer"></div></div>'
      : '<div class="messages-inner" style="display:grid;row-gap:24px"><div class="transcript-history" style="row-gap:24px"></div></div>';
    const parent = scroller.querySelector(
      virtual ? ".total-size" : ".transcript-history",
    );
    for (const index of indices) {
      const row = d.createElement("section");
      row.className = "turn";
      row.innerHTML =
        '<article class="user-row" data-sent-message-id="user-' +
        index +
        '"></article><article class="agent-copy"></article>';
      row.getBoundingClientRect = () => {
        rowRectReads++;
        return {
          top: index * 100,
          bottom: index * 100 + 80,
          left: 10,
          right: 390,
          width: 380,
          height: 80,
        };
      };
      if (virtual) {
        const wrapper = d.createElement("div");
        wrapper.className = "virtual-transcript-row";
        wrapper.style.paddingBottom = "24px";
        wrapper.dataset.transcriptRowKey = JSON.stringify([
          "thread-A",
          "turn",
          "turn-" + index,
        ]);
        wrapper.append(row);
        parent.append(wrapper);
      } else parent.append(row);
    }
  };
  try {
    render([0, 1, 2, 3, 4], false);
    const full = await inspect(canonical, "thread-A");
    assert.equal(full.turnBlocks, 5);
    assert.equal(full.historyGroups, 1);
    assert.equal(full.exactCanonicalSuffix, true);
    assert.equal(
      rowRectReads,
      0,
      "Full-DOM canonical verification adds no per-row rect reads",
    );
    assert.equal(full.inspection.rendererRowRectReads, 0);
    assert.equal(full.inspection.withinSendTiming, false);
    render([4, 2, 3], true); // DOM order differs from real geometry.
    const live = await inspect(canonical, "thread-A", "live");
    assert.equal(live.firstCanonicalIndex, 2);
    assert.equal(live.lastCanonicalIndex, 4);
    assert.equal(live.canonicalMembers, 3);
    assert.equal(rowRectReads, 3);
    assert.equal(live.inspection.rendererRowRectReads, 3);
    assert.equal(live.exactCanonicalSuffix, true);
    assert.equal(
      "rows" in live,
      false,
      "Raw canonical IDs never enter exported snapshot",
    );
    render([2, 0, 1], true);
    const earlier = await inspect(canonical, "thread-A", "earlier");
    assert.equal(earlier.firstCanonicalIndex, 0);
    assert.equal(earlier.lastCanonicalIndex, 2);
    assert.equal(earlier.exactCanonicalSuffix, false);
    render([0, 2], true);
    await assert.rejects(
      inspect(canonical, "thread-A", "returned"),
      /contiguous canonical order/,
    );
    const rejected = JSON.parse(
      JSON.stringify(inspectionResult.mountedInspectionDiagnostic),
    );
    assert.equal(rejected.stage, "returned");
    assert.deepEqual(rejected.mountedIndices, [0, 2]);
    assert.deepEqual(rejected.mountedRanges, [
      [0, 0],
      [2, 2],
    ]);
    assert.equal(rejected.viewportCoverage.rowCount, 1);
    assert.equal(
      rejected.viewportCoverage.canonicalContiguous,
      true,
      "Viewport coverage is distinct from all mounted rows; original all-row assertion still rejects",
    );
    assert.deepEqual(
      rejected.rows.map((row) => row.visible),
      [false, true],
    );
    assert.equal(rejected.spacing.lastCanonicalRowBottom, 280);
    assert.equal(rejected.spacing.finalRowPaddingBottom, 24);
    assert.equal(JSON.stringify(rejected).includes("user-"), false);
    assert.equal(JSON.stringify(rejected).includes("thread-A"), false);
    render([0, 0], true);
    await assert.rejects(inspect(canonical, "thread-A"));
    render([0, 1], true);
    d.querySelector("article.user-row").dataset.sentMessageId = "not-canonical";
    await assert.rejects(
      inspect(canonical, "thread-A"),
      /belongs to full canonical projection/,
    );
    render([0, 1], true);
    d.querySelector("[data-transcript-row-key]").dataset.transcriptRowKey =
      JSON.stringify(["other-thread", "turn", "turn-0"]);
    await assert.rejects(inspect(canonical, "thread-A"));
    const many = Array.from({ length: 201 }, (_, i) => ({
      id: "turn-" + i,
      items: [{ type: "userMessage", id: "user-" + i }],
    }));
    render(
      Array.from({ length: 201 }, (_, i) => i),
      true,
    );
    await assert.rejects(
      inspect(many, "thread-A", "returned"),
      /mounted DOM bounded/,
    );
    assert.equal(inspectionResult.mountedInspectionDiagnostic.rows.length, 32);
    assert.equal(
      inspectionResult.mountedInspectionDiagnostic.mountedIndices.length,
      200,
    );
    assert.equal(
      inspectionResult.mountedInspectionDiagnostic.rowsTruncated,
      true,
    );
    assert.equal(
      inspectionResult.mountedInspectionDiagnostic.mountedIndicesTruncated,
      true,
    );
  } finally {
    dom.window.close();
  }
});

test("native continuity keeps pending RO/IO but permits exact independently native-observed canonical handoff", async () => {
  for (const notificationFirst of [true, false]) {
    const f = fixture({
      layoutObservation: true,
      intersectionObservation: true,
    });
    try {
      const pending = await f.row("pending");
      f.resize(1100);
      f.intersect(pending.bubble, true);
      pending.article.remove();
      const canonical = await f.row("canonical");
      if (notificationFirst) f.notify();
      const reads = f.geometryReads();
      f.intersect(canonical.bubble, true);
      assert.equal(
        f.geometryReads(),
        reads,
        "Canonical IO callback adds no geometry reads",
      );
      if (!notificationFirst) {
        f.frame();
        assert.equal(f.record.nativeFeedbackContinuity, undefined);
        f.notify();
      }
      f.frame();
      assert.equal(
        f.record.pendingNativeSubsequentFrameMs,
        undefined,
        "Canonical frame is never relabeled pending",
      );
      assert.equal(f.record.nativeFeedbackContinuity.owner, "canonical");
      assert.equal(f.record.nativeFeedbackContinuity.pendingToCanonical, true);
      assert.equal(f.record.nativeFeedbackContinuity.identityVerified, true);
      assert.ok(
        f.record.nativeFeedbackContinuity.subsequentFrameMs >
          f.record.canonicalNativeIntersectionMs,
      );
      assert.equal(f.record.nativeLayoutEvents[0].pendingConnected, true);
    } finally {
      f.close();
    }
  }
});

test("canonical handoff rejects wrong identity, offscreen, detached, remounted or never-native-observed owners", async () => {
  for (const failure of [
    "client",
    "thread",
    "message",
    "offscreen",
    "detached",
    "remounted",
    "no-canonical-IO",
    "no-pending-IO",
  ]) {
    const f = fixture({ intersectionObservation: true });
    try {
      const pending = await f.row("pending");
      if (failure !== "no-pending-IO") f.intersect(pending.bubble, true);
      pending.article.remove();
      const canonical = await f.row("canonical");
      f.notify(
        failure === "client"
          ? { clientId: "wrong" }
          : failure === "thread"
            ? { threadId: "wrong" }
            : failure === "message"
              ? { messageId: "wrong" }
              : {},
      );
      const reads = f.geometryReads();
      if (failure !== "no-canonical-IO")
        f.intersect(canonical.bubble, failure !== "offscreen");
      assert.equal(f.geometryReads(), reads);
      if (failure === "detached" || failure === "remounted")
        canonical.article.remove();
      if (failure === "remounted") await f.row("canonical");
      f.frame();
      assert.equal(f.record.pendingNativeSubsequentFrameMs, undefined);
      assert.equal(
        f.record.nativeFeedbackContinuity,
        undefined,
        failure + " cannot establish native owner continuity",
      );
    } finally {
      f.close();
    }
  }
});

test("stopping cancels the queued native owner frame and disconnects both owner observations", async () => {
  const f = fixture({ intersectionObservation: true });
  const pending = await f.row("pending");
  f.intersect(pending.bubble, true);
  assert.ok(f.queuedFrames() > 0);
  f.close();
  assert.equal(f.queuedFrames(), 0);
  assert.equal(f.intersectionDisconnected(), true);
  f.frame();
  assert.equal(f.record.nativeFeedbackContinuity, undefined);
});

test("native continuity export retains separate owner/handoff clocks and rejects malformed ownership", () => {
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  const code = launch.slice(
    launch.indexOf("function projectNativeContinuity("),
    launch.indexOf("// One fixed image allowlist"),
  );
  const project = new Function("assert", "return (" + code + ")")(assert);
  const sample = {
    clickMs: 100,
    nativeFeedbackContinuity: {
      owner: "canonical",
      pendingToCanonical: true,
      identityVerified: true,
      ownerConnected: true,
      pendingNativeIntersectionMs: 110,
      ownerNativeIntersectionEntryMs: 120,
      ownerNativeIntersectionMs: 121,
      subsequentFrameMs: 140,
    },
  };
  assert.deepEqual(project(sample), {
    owner: "canonical",
    pendingToCanonical: true,
    identityVerified: true,
    ownerConnected: true,
    pendingNativeIntersectionMs: 10,
    ownerNativeIntersectionEntryMs: 20,
    ownerNativeIntersectionMs: 21,
    subsequentFrameMs: 40,
  });
  assert.throws(() =>
    project({
      ...sample,
      nativeFeedbackContinuity: {
        ...sample.nativeFeedbackContinuity,
        identityVerified: false,
      },
    }),
  );
  assert.throws(() =>
    project({
      ...sample,
      nativeFeedbackContinuity: {
        ...sample.nativeFeedbackContinuity,
        ownerConnected: false,
      },
    }),
  );
  assert.throws(() =>
    project({
      ...sample,
      nativeFeedbackContinuity: {
        ...sample.nativeFeedbackContinuity,
        pendingToCanonical: false,
      },
    }),
  );
  assert.throws(() =>
    project({
      ...sample,
      nativeFeedbackContinuity: {
        ...sample.nativeFeedbackContinuity,
        subsequentFrameMs: 120,
      },
    }),
  );
  assert.ok(
    source.includes(
      "Real inserted pending row must cause a native observed content growth before canonical replacement",
    ),
  );
});

test("fixed synthetic screenshot exporter preserves failed-case PNGs and rejects unsafe inputs without exporting private files", async () => {
  const fs = require("node:fs/promises"),
    os = require("node:os"),
    fsConstants = require("node:fs").constants;
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  const code = launch.slice(
    launch.indexOf("async function copyOwnedSyntheticScreenshots("),
    launch.indexOf("let cleanupSafe ="),
  );
  const copy = new Function(
    "assert",
    "readdir",
    "open",
    "writeFile",
    "path",
    "fsConstants",
    "return (" + code + ")",
  )(assert, fs.readdir, fs.open, fs.writeFile, path, fsConstants);
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "zen-native-synthetic-shots-unit-"),
  );
  const directory = path.join(root, "private"),
    uploadDirectory = path.join(root, "upload");
  await fs.mkdir(directory);
  await fs.mkdir(uploadDirectory);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS0AAAAASUVORK5CYII=",
    "base64",
  );
  const names = [
    "messages-10000-sample-0-before.png",
    "legend-history-after-canonical.png",
    "send-latency-failure.png",
  ].sort();
  const capture = {
    ok: false,
    seed: { synthetic: true, userMessageCount: 5000 },
    fixtureModel: { provider: "fake" },
    packagedRuntime: { isPackaged: true },
  };
  let scans = 0;
  const args = {
    directory,
    uploadDirectory,
    capture,
    close: { code: 1, signal: null },
    privateConfig: "synthetic-only-private-config",
    guard: {
      scan(serialized, config) {
        scans++;
        assert.equal(config, "synthetic-only-private-config");
        assert.equal(serialized.includes(config), false);
      },
    },
  };
  try {
    for (const name of names)
      await fs.writeFile(path.join(directory, name), png);
    for (const name of [
      "owned-native-send-profile.private.json",
      "native-process.log",
      "host-profile.json",
      "unlisted.png",
    ])
      await fs.writeFile(path.join(directory, name), "synthetic private bytes");
    assert.deepEqual(await copy(args), names);
    assert.equal(scans, 1);
    assert.deepEqual((await fs.readdir(uploadDirectory)).sort(), names);
    for (const name of names)
      assert.deepEqual(
        await fs.readFile(path.join(uploadDirectory, name)),
        png,
      );
    for (const [i, override] of [
      { capture: undefined },
      {
        capture: {
          ...capture,
          seed: { synthetic: false, userMessageCount: 5000 },
        },
      },
      { capture: { ...capture, fixtureModel: { provider: "real" } } },
      { close: { code: null, signal: "SIGTERM" } },
      { guard: undefined },
      {
        guard: {
          scan() {
            throw Error("private export guard rejected");
          },
        },
      },
    ].entries()) {
      const target = path.join(root, "denied-" + i);
      await fs.mkdir(target);
      await assert.rejects(
        copy({ ...args, ...override, uploadDirectory: target }),
      );
      assert.deepEqual(await fs.readdir(target), []);
    }
    const bad = path.join(root, "bad"),
      badOutput = path.join(root, "bad-output");
    await fs.mkdir(bad);
    await fs.mkdir(badOutput);
    await fs.writeFile(
      path.join(bad, "send-latency-failure.png"),
      "not a PNG payload",
    );
    await assert.rejects(
      copy({ ...args, directory: bad, uploadDirectory: badOutput }),
    );
    await fs.rm(path.join(bad, "send-latency-failure.png"));
    await fs.symlink(
      path.join(directory, names[0]),
      path.join(bad, "send-latency-failure.png"),
    );
    await assert.rejects(
      copy({ ...args, directory: bad, uploadDirectory: badOutput }),
    );
    assert.deepEqual(await fs.readdir(badOutput), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("later diagnostic failure retains only finite or null observed main handler duration", () => {
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  const observed = launch.slice(launch.indexOf("observedSamples:"));
  const projection = observed
    .slice(
      observed.indexOf("ipcDurationMs:") + "ipcDurationMs:".length,
      observed.indexOf(",\n        activationKind:"),
    )
    .trim()
    .replace(/,$/, "");
  const project = new Function("sample", "return (" + projection + ")");
  for (const durationMs of [0, 12.5, 1400])
    assert.equal(project({ ipc: [{ durationMs }] }), durationMs);
  for (const durationMs of [undefined, null, NaN, Infinity, "private-value"])
    assert.equal(project({ ipc: [{ durationMs }] }), null);
  assert.equal(project({}), null);
  assert.equal(project({ ipc: [] }), null);
  assert.ok(source.includes('clockDomain: "electron-main"'));
  assert.ok(
    source.includes(
      "Main-process durations are never subtracted from renderer performance.now()",
    ),
  );
});
