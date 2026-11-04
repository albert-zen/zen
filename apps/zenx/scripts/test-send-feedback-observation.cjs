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
  assert.ok(workflow.includes('"1280 enter control candidate"'));
  assert.equal(
    workflow.includes('"1120 click narrow candidate baseline"'),
    false,
  );
  assert.equal(
    workflow.includes("owned-native-send-profile.private.json"),
    false,
  );
});

test("selection performance pair locks each exact Legend source and keeps reader regression outside timing", () => {
  // Reuse run 41743199059 only while every unchanged observer/dependency byte matches.
  const digest = (bytes) =>
    require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  for (const [file, expectedHash] of Object.entries({
    "capture-send-feedback-verified-frame.cjs":
      "056f7314b019b3bdfe27262c8a6775367dd69e5ab1b690ba05527114a8bf4cce",
    "long-thread-domain-seed.mjs":
      "b535d48f6fc94ebe0039271438213cd5d91a4a72fbab010ef8d8a77d044e0054",
    "summarize-send-timeline.cjs":
      "9a947307797d277d2d480e97174d711e1546fffe9533d1c933ea580e50d4074b",
    "../../../package-lock.json":
      "d1d5633673931da6b4a8e9b5881930669ac070b05d3197997189a3c84c8a4ea8",
    "../../../package.json":
      "73d3b8ba4a68a827f7b6dd35ae0a394d195162888c9c76c1ee7cb380b2f47c4c",
    "../package.json":
      "4e9e407d940eb3743ddd62124c19e4abb6b7a5996691a78850e5998d6fde0511",
  }))
    assert.equal(
      digest(readFileSync(path.join(__dirname, file))),
      expectedHash,
      file,
    );
  // JSDOM resolves from the product checkout cwd, not the diagnostic directory.
  for (const [file, expectedHash] of Object.entries({
    "package-lock.json":
      "308b3d642cf1dd9e25a2d8ebf849da0a7584e5aa1825f445977cdca026c5d2cb",
    "package.json":
      "44c7a345a7c51e4c0b829225ace3d1a54540b65ca3aff11256c5b9e521320eb6",
    "apps/zenx/package.json":
      "9317909d3954416db0258b37583a9307cb241750171c66a332c84c5ef87e72ee",
  }))
    assert.equal(digest(readFileSync(path.resolve(file))), expectedHash, file);
  const observerTest = readFileSync(__filename, "utf8");
  assert.equal(
    digest(
      observerTest.slice(
        0,
        observerTest.indexOf('\ntest("selection performance pair'),
      ) +
        observerTest.slice(
          observerTest.indexOf('\ntest("Selection getter probes'),
        ),
    ),
    "405fa2f8e728ffbe5fa37b382dea83287698ac856fa26c4b6b558d85e6c40d71",
    "Unchanged observer contracts must match the completed full-preflight run",
  );
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  const snapshots = new Function(
    "return (" +
      launch.slice(
        launch.indexOf("const snapshots = {") + "const snapshots = ".length,
        launch.indexOf("\n};", launch.indexOf("const snapshots = {")) + 2,
      ) +
      ")",
  )();
  assert.deepEqual(snapshots, {
    baseline: {
      commit: "3005aa82f567fb021ebd0ab1058d16beb04e13e4",
      tree: "9663d3a988cd463bbe4b82268f9e36e705f9084e",
      frontendSourceTree: "5feb43dba2ab9ca60d9aa8191e9d28b48397a1d2",
      rendererSourceTree: "d76aaff53d99ce140ad8ebf714719060cdd12db9",
      expectedVirtualTranscript: true,
    },
    candidate: {
      commit: "572fe27e806950a6f7d1f78cbe809bf64c8d48c6",
      tree: "bbe3befd1a3408135bb72f754a0429e3f7900ec7",
      frontendSourceTree: "6d45e24fa68e152b0c7b5eca873b1d577dcc40d8",
      rendererSourceTree: "edf4c9e8227fdf046ef7b0acfb1ed3aa9ca2cc2c",
      expectedVirtualTranscript: true,
    },
  });
  assert.ok(
    launch.includes(
      "const { frontendSourceTree, rendererSourceTree } = snapshot",
    ),
  );
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
  assert.ok(workflow.includes("diagnostic/send-legend-ui-quality-20261103"));
  assert.equal(
    workflow.includes("assert.deepEqual(builds[0], builds[1]"),
    false,
  );
  for (const [label, snapshot] of Object.entries(snapshots))
    assert.ok(
      workflow.includes(
        `ref: ${snapshot.commit}\n          persist-credentials: false\n          path: ${label}`,
      ),
    );
  assert.ok(
    workflow.includes(
      'for case_spec in "1280 enter control baseline" "1280 enter control candidate"; do',
    ),
  );
  assert.equal(
    workflow.match(/for source in baseline candidate; do/g).length,
    2,
  );
  assert.equal(workflow.match(/node --test/g).length, 2);
  assert.ok(
    workflow.includes(
      "--test-name-pattern='selection performance pair|source identity guards|timeline integration' ../diagnostic/apps/zenx/scripts/test-send-feedback-observation.cjs",
    ),
  );
  assert.ok(workflow.includes("timeout-minutes: 35"));
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

test("source identity guards execute exact launcher checks for both labels and reject substitutions", () => {
  const vm = require("node:vm");
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  const start = launch.indexOf("const snapshots = {");
  const prefix = launch.slice(
    start,
    launch.indexOf("\nawait mkdir(uploadDirectory"),
  );
  assert.ok(
    start >= 0 &&
      prefix.includes("Tracked production checkout must be unchanged"),
  );
  const snapshots = vm.runInNewContext(
    launch.slice(start, launch.indexOf("\n};", start) + 3) + "\nsnapshots",
  );
  for (const [sourceLabel, snapshot] of Object.entries(snapshots)) {
    const values = {
      "rev-parse HEAD:apps/zenx": snapshot.frontendSourceTree,
      "rev-parse HEAD:apps/zenx/src/renderer": snapshot.rendererSourceTree,
      "rev-parse HEAD": snapshot.commit,
      "rev-parse HEAD^{tree}": snapshot.tree,
      "diff --name-only HEAD": "",
    };
    const check = (answers) => {
      const calls = [];
      vm.runInNewContext(prefix, {
        assert,
        sourceLabel,
        execFileSync(command, args, options) {
          assert.equal(command, "git");
          assert.equal(options.encoding, "utf8");
          const key = args.join(" ");
          assert.ok(Object.hasOwn(answers, key));
          calls.push(key);
          return answers[key] + "\n";
        },
      });
      assert.deepEqual(calls, Object.keys(values));
    };
    check(values);
    for (const key of Object.keys(values))
      assert.throws(() => check({ ...values, [key]: "0".repeat(40) }), {
        code: "ERR_ASSERTION",
      });
  }
  assert.throws(
    () =>
      vm.runInNewContext(prefix, {
        assert,
        sourceLabel: "unknown",
        execFileSync() {
          throw new Error("Unknown labels must fail before git");
        },
      }),
    { code: "ERR_ASSERTION" },
  );
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
    source.includes("Visible rows preserve contiguous canonical order"),
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
  const reload = source.indexOf(
    "await reloadOwnedRenderer();",
    source.indexOf("async function run()"),
  );
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
    source.includes(
      '"Responsive gap uses real adjacent canonical rows touching the viewport"',
    ),
  );
  assert.ok(source.includes('"adjacent canonical rows, at least one visible"'));
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
  let viewportTop = 100,
    viewportBottom = 350;
  d.querySelector(".messages").getBoundingClientRect = () => ({
    top: viewportTop,
    bottom: viewportBottom,
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
    const footer = scroller.querySelector(".virtual-transcript-footer");
    if (footer)
      footer.getBoundingClientRect = () => ({
        top: Math.max(...indices) * 100 + 104,
        bottom: Math.max(...indices) * 100 + 254,
      });
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
    viewportTop = 250;
    viewportBottom = 450;
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
    viewportTop = 50;
    viewportBottom = 250;
    render([2, 0, 1], true);
    const earlier = await inspect(canonical, "thread-A", "earlier");
    assert.equal(earlier.firstCanonicalIndex, 0);
    assert.equal(earlier.lastCanonicalIndex, 2);
    assert.equal(earlier.exactCanonicalSuffix, false);
    viewportTop = 0;
    viewportBottom = 280;
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
    assert.equal(rejected.viewportCoverage.rowCount, 2);
    assert.equal(
      rejected.viewportCoverage.canonicalContiguous,
      false,
      "Missing canonical rows inside the visible interval remain rejected",
    );
    assert.deepEqual(
      rejected.rows.map((row) => row.visible),
      [true, true],
    );
    assert.equal(rejected.spacing.lastCanonicalRowBottom, 280);
    assert.equal(rejected.spacing.finalRowPaddingBottom, 24);
    assert.equal(JSON.stringify(rejected).includes("user-"), false);
    assert.equal(JSON.stringify(rejected).includes("thread-A"), false);
    viewportTop = 250;
    viewportBottom = 450;
    render([0, 4, 2, 3], true);
    const retained = await inspect(canonical, "thread-A", "returned");
    assert.equal(retained.canonicalContiguous, false);
    assert.equal(retained.viewportCanonicalContiguous, true);
    assert.equal(retained.exactCanonicalSuffix, true);
    assert.deepEqual(
      inspectionResult.mountedInspectionDiagnostic.mountedRanges,
      [
        [0, 0],
        [2, 4],
      ],
    );
    viewportTop = 100;
    viewportBottom = 350;
    render([0, 2], true);
    await assert.rejects(
      inspect(canonical, "thread-A", "returned"),
      /coverage reaches the viewport leading edge/,
    );
    render([1, 2], true);
    d.querySelectorAll("section.turn")[1].getBoundingClientRect = () => ({
      top: 260,
      bottom: 340,
      left: 10,
      right: 390,
      width: 380,
      height: 80,
    });
    await assert.rejects(
      inspect(canonical, "thread-A", "earlier"),
      /physical gap or overlap/,
    );
    viewportBottom = 450;
    render([1, 2, 4], true);
    d.querySelectorAll("section.turn")[2].getBoundingClientRect = () => ({
      top: 1000,
      bottom: 1080,
      left: 10,
      right: 390,
      width: 380,
      height: 80,
    });
    d.querySelector(".virtual-transcript-footer").getBoundingClientRect =
      () => ({ top: 304, bottom: 454 });
    await assert.rejects(
      inspect(canonical, "thread-A", "returned"),
      /coverage reaches the viewport or actual footer/,
      "An offscreen final row cannot let a premature footer hide a visible tail gap",
    );
    viewportTop = 250;
    render([2, 3, 4], true);
    d.querySelector(".virtual-transcript-footer").getBoundingClientRect =
      () => ({ top: 400, bottom: 550 });
    await assert.rejects(
      inspect(canonical, "thread-A", "returned"),
      /footer cannot precede the final visible canonical row/,
    );
    viewportTop = 100;
    render([1, 2], true);
    d.querySelector(".virtual-transcript-footer").getBoundingClientRect =
      () => ({ top: 1000, bottom: 1150 });
    await assert.rejects(
      inspect(canonical, "thread-A", "earlier"),
      /coverage reaches the viewport or actual footer/,
    );
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
    "native-select-all.png",
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

test("native returned-buffer geometry permits only offscreen retained gaps", async () => {
  const mountedInspector = source.slice(
    source.indexOf("async function inspectMountedTranscript("),
    source.indexOf(
      "// Instrumented getter attribution plus existing browser observations.",
    ),
  );
  const canonical = Array.from({ length: 5003 }, (_, index) => ({
    id: "turn-" + index,
    items: [{ type: "userMessage", id: "user-" + index }],
  }));
  // Numeric geometry from native macOS85e run41673312561 attempt2. Synthetic
  // identities are reconstructed here; no original IDs or content are saved.
  const geometry = [
    [4990, -2873, -2628.90625, false],
    [4991, -2605, -2360.90625, false],
    [4996, -1220, -975.90625, false],
    [4997, -952, -707.90625, false],
    [4998, -684, -439.90625, false],
    [4999, -416, -171.90625, false],
    [5000, -148, 52.71875, true],
    [5001, 77, 277.71875, true],
    [5002, 302, 502.71875, true],
  ];
  const snapshot = {
    virtual: true,
    viewport: { top: 44, bottom: 677 },
    spacing: { footerTop: 527, footerBottom: 677 },
    rowGapPx: 24,
    contentDisplay: "block",
    turnBlocks: 9,
    virtualRows: 9,
    rows: geometry.map(([index, top, bottom, visible]) => ({
      userId: "user-" + index,
      key: JSON.stringify(["thread-A", "turn", "turn-" + index]),
      top,
      bottom,
      visible,
      paddingBottom: 24,
    })),
  };
  const result = {};
  const inspect = new Function(
    "assert",
    "evaluate",
    "result",
    "return (" + mountedInspector + ")",
  )(assert, async () => structuredClone(snapshot), result);
  const returned = await inspect(canonical, "thread-A", "returned");
  assert.equal(returned.canonicalContiguous, false);
  assert.equal(returned.viewportCanonicalContiguous, true);
  assert.equal(returned.exactCanonicalSuffix, true);
  assert.deepEqual(result.mountedInspectionDiagnostic.viewportCoverage.ranges, [
    [5000, 5002],
  ]);
  snapshot.rows.splice(7, 1);
  snapshot.turnBlocks--;
  snapshot.virtualRows--;
  await assert.rejects(
    inspect(canonical, "thread-A", "returned"),
    /Visible rows preserve contiguous/,
  );
});

test("responsive gap selects adjacent canonical rows touching the viewport, not retained offscreen fragments", () => {
  const start = source.indexOf("const pairIndex = responsiveRows.findIndex(");
  const end = source.indexOf(
    "\n    }\n    result.responsiveHistoryLayout.push(geometry)",
    start,
  );
  assert.ok(start > 0 && end > start);
  const select = new Function(
    "assert",
    "responsiveRows",
    "const geometry={};" + source.slice(start, end) + ";return geometry;",
  );
  const rows = [
    { canonicalIndex: 4990, top: -1800, bottom: -1600, visible: false },
    { canonicalIndex: 4996, top: -727.296875, bottom: -500, visible: false },
    { canonicalIndex: 5000, top: 100, bottom: 300, visible: true },
    { canonicalIndex: 5001, top: 324.28125, bottom: 650, visible: true },
  ];
  const actual = select(assert, rows);
  assert.deepEqual(actual.turnGapCanonicalIndices, [5000, 5001]);
  assert.equal(actual.turnGapPx, 24.28125);
  assert.throws(
    () => select(assert, rows.slice(0, 3)),
    /adjacent canonical rows/,
  );
  const tall = select(assert, [
    { canonicalIndex: 20, top: -700, bottom: -20, visible: false },
    { canonicalIndex: 21, top: 0, bottom: 900, visible: true },
    { canonicalIndex: 22, top: 920, bottom: 1600, visible: false },
  ]);
  assert.deepEqual(tall.turnGapCanonicalIndices, [20, 21]);
  assert.equal(tall.turnGapPx, 20);
});

test("backend pair explicitly prepares and reports real live reader state before timing", () => {
  const preparation = source.slice(
    source.indexOf("result.initialReaderPreparation ="),
    source.indexOf(
      "result.before =",
      source.indexOf("result.initialReaderPreparation ="),
    ),
  );
  assert.ok(preparation.includes("bottomDistance > 3"));
  assert.ok(preparation.includes("await click("));
  assert.ok(preparation.includes("\"document.querySelector('.back-live')\""));
  assert.ok(preparation.includes('"Prepare actual live reader"'));
  assert.ok(preparation.includes("nativeBackToLiveUsed = true"));
  assert.ok(
    preparation.includes(
      "canonical history mounted at live bottom before timing",
    ),
  );
  assert.equal(
    /scrollTop\s*=/.test(preparation),
    false,
    "Never force a test-only offset instead of using the actual UI",
  );
  assert.ok(
    source.indexOf("result.initialReaderPreparation =") <
      source.indexOf("result.samples = []"),
  );
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  assert.ok(
    launch.includes(
      "initialReaderPreparation: result.initialReaderPreparation",
    ),
  );
  assert.ok(
    launch.includes(
      "initialReaderPreparation: capture?.initialReaderPreparation",
    ),
  );
});

test("native Find and Selection quality use real input after timing and bounded synthetic export", () => {
  const start = source.indexOf("result.emptyFooterGeometry =");
  assert.ok(
    start >
      source.indexOf(
        "await stopOwnedTrace();",
        source.indexOf("result.samples = []"),
      ),
  );
  for (const contract of [
    "nativeKey('F',['meta'])",
    "window.webContents.insertText('Synthetic user 42.')",
    "nativeKey('Return',['shift'])",
    "CSS.highlights.get('zenx-thread-find-active')",
    "range.startContainer.isConnected",
    "range.toString()===",
    "mountedRows<200",
    "modifiers:['leftButtonDown']",
    "s.anchorNode===b.anchor",
    "b.anchor.isConnected",
    "assertNativeSelectionQuality(result.nativeSelectionQuality)",
  ])
    assert.ok(
      source
        .replace(/\s+/g, " ")
        .replace(/"/g, "\'")
        .replace(/\s+/g, "")
        .includes(contract.replace(/\s+/g, "").replace(/"/g, "\'")),
      contract,
    );
  assert.equal(source.slice(start).includes("addRange("), false);
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  assert.ok(launch.includes("names.length <= 19"));
  assert.ok(launch.includes("virtual-find-(?:old-history|wrapped-tail)"));
  assert.ok(launch.includes("virtual-selection-before-scroll"));
  assert.ok(launch.includes("virtualFindQuality: result.virtualFindQuality"));
});

test("native Selection oracle rejects no movement, wrong row, onscreen retention and node loss", () => {
  const start = source.indexOf("function assertNativeSelectionQuality(");
  const end = source.indexOf("\nasync function run()", start);
  const validate = new Function(
    "assert",
    source.slice(start, end) + ";return assertNativeSelectionQuality;",
  )(assert);
  const good = {
    selectionOwnedByTarget: true,
    preservedAfterNativeWheel: true,
    beforeViewportHeight: 600,
    beforeScrollTop: 10000,
    afterScrollTop: 7000,
    targetOffscreenAfterWheel: true,
    pausedReader: true,
    bottomDistance: 3500,
    mountedRows: 12,
  };
  validate(good);
  for (const bad of [
    { afterScrollTop: 10000 }, // Already-paused Find state must not masquerade as scrolling.
    { afterScrollTop: 9700 },
    { selectionOwnedByTarget: false },
    { preservedAfterNativeWheel: false },
    { targetOffscreenAfterWheel: false },
    { mountedRows: 5000 },
    { beforeViewportHeight: 0 },
    { pausedReader: false },
  ])
    assert.throws(() => validate({ ...good, ...bad }));
});

test("native startup opt-in is executable inside the real diagnostic expression wrapper", async () => {
  const start = source.indexOf("function diagnosticEvaluation(");
  const makeExpression = new Function(
    source.slice(start, source.indexOf("\nconst evaluate =", start)) +
      "; return diagnosticEvaluation;",
  )();
  const preparation = source.indexOf("// Test-only opt-in");
  const call =
    source.indexOf("await evaluate(", preparation) + "await evaluate(".length;
  const literal = source
    .slice(call, source.indexOf("\n  );", call))
    .trim()
    .replace(/,$/, "");
  const expression = JSON.parse(literal);
  const dom = new JSDOM("", {
    runScripts: "outside-only",
    url: "https://synthetic.invalid",
  });
  try {
    const reply = await dom.window.eval(makeExpression(expression));
    assert.equal(reply.ok, true);
    assert.equal(
      dom.window.sessionStorage.getItem("zenx.experimental.virtualTranscript"),
      "1",
    );
    assert.equal(
      dom.window.sessionStorage.getItem(
        "zenx.experimental.virtualTranscriptFind",
      ),
      "1",
    );
  } finally {
    dom.window.close();
  }
});

test("native Find replacement observes native responder selection before insertText", async () => {
  const insert = source.indexOf(
    '  await window.webContents.insertText("Synthetic user ");',
  );
  const start = Math.max(
    source.lastIndexOf('  nativeKey("A", ["meta"]);', insert),
    source.lastIndexOf(
      '  Menu.sendActionToFirstResponder("selectAll:");',
      insert,
    ),
  );
  assert.ok(start > 0 && insert > start);
  const end = source.indexOf("\n", insert);
  const replace = new (Object.getPrototypeOf(async function () {}).constructor)(
    "nativeKey",
    "Menu",
    "window",
    "until",
    "evaluate",
    source.slice(start, end),
  );
  let selected = false,
    inserted = false,
    awaitedSelection = false;
  await replace(
    () => {}, // macOS DOM key injection does not execute Cocoa editing actions.
    {
      sendActionToFirstResponder(action) {
        assert.equal(action, "selectAll:");
        queueMicrotask(() => {
          selected = true;
        });
      },
    },
    {
      webContents: {
        async insertText(value) {
          assert.equal(
            selected,
            true,
            "only the native responder action establishes input selection",
          );
          assert.equal(
            awaitedSelection,
            true,
            "observe the actual input selection before insertion",
          );
          assert.equal(value, "Synthetic user ");
          inserted = true;
        },
      },
    },
    async (check) => {
      for (let i = 0; i < 3; ++i) {
        if (await check()) {
          awaitedSelection = true;
          return;
        }
      }
      throw Error("No actual native input selection");
    },
    async (expression) => {
      assert.ok(expression.includes("selectionStart"));
      assert.ok(expression.includes("selectionEnd"));
      return selected;
    },
  );
  assert.equal(inserted, true);
});

test("failed native quality exports fixed finite evidence without text or DOM identities", () => {
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  const start = launch.indexOf("function projectFailureTranscriptQuality(");
  assert.ok(start >= 0);
  const project = new Function(
    launch.slice(
      start,
      launch.indexOf("async function readReviewedFailedFirstTrace(", start),
    ) + "; return projectFailureTranscriptQuality;",
  )();
  const result = project({
    virtualFindQuality: {
      oldHistory: {
        accepted: true,
        counts: [1, 1, 999],
        mountedRows: 9,
        text: "NEVER_EXPORT",
      },
      wrappedTail: { accepted: true, counts: [5000, 5000], mountedRows: 10 },
      totalMatches: 5000,
    },
    nativeSelectAllQuality: {
      fullDom: true,
      canonicalOrder: false,
      mountedUserRows: 5003,
      selectedMarkerCount: Infinity,
      copiedMarkerCount: "NEVER_EXPORT",
      selectedUTF16Length: "NEVER_EXPORT",
      copiedUTF16Length: Infinity,
      selectedCRCount: 1,
      copiedCRCount: NaN,
      copiedTABCount: 2,
      clipboardEqualAfterLF: "NEVER_EXPORT",
      clipboardEqualAfterNBSP: false,
      copyComposerEligible: "NEVER_EXPORT",
      copySelectionIntersectsComposer: true,
      copyComposerSnapshotStable: { private: "NEVER_EXPORT" },
      copyPlaceholderUTF16Length: Infinity,
      clipboardAddsOnlyComposerPlaceholderLF: false,
      clipboardPlaceholderInsertionAtStart: "NEVER_EXPORT",
      clipboardPlaceholderInsertionAtEnd: true,
      clipboardPlaceholderInsertionAfterCanonicalMessages: "NEVER_EXPORT",
      selectedMessageCount: Infinity,
      copiedMessageCount: 10006,
      canonicalMessageOrder: "NEVER_EXPORT",
      fullLastAssistantCopied: true,
      menuToSelectionMs: Infinity,
      clearToRestoreMs: 12.5,
      text: "NEVER_EXPORT",
      clipboard: "NEVER_EXPORT",
      anchor: { private: "NEVER_EXPORT" },
    },
    nativeFullDomCopyControl: {
      completed: false,
      defaultOffAfterReload: true,
      defaultSelectAllRole: "NEVER_EXPORT",
      afterVirtualAssertions: true,
      clipboardMatchesSelection: false,
      clipboardAddsOnlyComposerPlaceholderLF: true,
      copiedMessageCount: 10006,
      selectedUTF16Length: Infinity,
      text: "NEVER_EXPORT",
      error: "NEVER_EXPORT",
      wholeCopyMatchesCandidate: true,
      samePausedReaderState: "NEVER_EXPORT",
      candidateCopiedUTF16Length: Infinity,
      nativeCopyCandidate: {
        copied: "NEVER_EXPORT",
        placeholder: "NEVER_EXPORT",
      },
    },
    nativeSelectionQuality: {
      selectionOwnedByTarget: false,
      preservedAfterNativeWheel: false,
      selectedCharacterCount: 0,
      beforeScrollTop: 10000,
      afterScrollTop: 9000,
      beforeViewportHeight: 600,
      targetOffscreenAfterWheel: true,
      pausedReader: true,
      mountedRows: 12,
      bottomDistance: Infinity,
      text: "NEVER_EXPORT",
      anchor: { private: "NEVER_EXPORT" },
    },
  });
  assert.deepEqual(result.find.oldHistory.counts, [1, 1]);
  assert.equal(result.selectAll.fullDom, true);
  assert.equal(result.selectAll.canonicalOrder, false);
  assert.equal(result.selectAll.mountedUserRows, 5003);
  assert.equal(result.selectAll.selectedMarkerCount, null);
  assert.equal(result.selectAll.copiedMarkerCount, null);
  assert.equal(result.selectAll.selectedUTF16Length, null);
  assert.equal(result.selectAll.copiedUTF16Length, null);
  assert.equal(result.selectAll.selectedCRCount, 1);
  assert.equal(result.selectAll.copiedCRCount, null);
  assert.equal(result.selectAll.copiedTABCount, 2);
  assert.equal(result.selectAll.clipboardEqualAfterLF, null);
  assert.equal(result.selectAll.clipboardEqualAfterNBSP, false);
  assert.equal(result.selectAll.copyComposerEligible, null);
  assert.equal(result.selectAll.copySelectionIntersectsComposer, true);
  assert.equal(result.selectAll.copyComposerSnapshotStable, null);
  assert.equal(result.selectAll.copyPlaceholderUTF16Length, null);
  assert.equal(result.selectAll.clipboardAddsOnlyComposerPlaceholderLF, false);
  assert.equal(result.selectAll.clipboardPlaceholderInsertionAtStart, null);
  assert.equal(result.selectAll.clipboardPlaceholderInsertionAtEnd, true);
  assert.equal(
    result.selectAll.clipboardPlaceholderInsertionAfterCanonicalMessages,
    null,
  );
  assert.equal(result.selectAll.selectedMessageCount, null);
  assert.equal(result.selectAll.copiedMessageCount, 10006);
  assert.equal(result.selectAll.canonicalMessageOrder, null);
  assert.equal(result.selectAll.fullLastAssistantCopied, true);
  assert.equal(result.selectAll.menuToSelectionMs, null);
  assert.equal(result.selectAll.clearToRestoreMs, 12.5);
  assert.equal(result.fullDomControl.wholeCopyMatchesCandidate, true);
  assert.equal(result.fullDomControl.samePausedReaderState, null);
  assert.equal(result.fullDomControl.candidateCopiedUTF16Length, null);
  for (const length of [-1, 0.5, 8 * 1024 * 1024 + 1])
    assert.equal(
      project({
        nativeFullDomCopyControl: { candidateCopiedUTF16Length: length },
      }).fullDomControl.candidateCopiedUTF16Length,
      null,
    );
  assert.equal(result.fullDomControl.completed, false);
  assert.equal(result.fullDomControl.defaultOffAfterReload, true);
  assert.equal(result.fullDomControl.defaultSelectAllRole, null);
  assert.equal(result.fullDomControl.clipboardMatchesSelection, false);
  assert.equal(
    result.fullDomControl.clipboardAddsOnlyComposerPlaceholderLF,
    true,
  );
  assert.equal(result.fullDomControl.copiedMessageCount, 10006);
  assert.equal(result.fullDomControl.selectedUTF16Length, null);
  assert.equal(result.selection.selectionOwnedByTarget, false);
  assert.equal(result.selection.beforeScrollTop, 10000);
  assert.equal(result.selection.bottomDistance, null);
  assert.equal(JSON.stringify(result).includes("NEVER_EXPORT"), false);
  assert.deepEqual(project(undefined), {
    find: null,
    selectAll: null,
    fullDomControl: null,
    selection: null,
  });
  assert.ok(
    launch.includes(
      "transcriptQuality: projectFailureTranscriptQuality(capture)",
    ),
  );
});

function wrappedDiagnosticEvaluator(window, expressions = []) {
  const start = source.indexOf("function diagnosticEvaluation(");
  const wrap = new Function(
    source.slice(start, source.indexOf("\nconst evaluate =", start)) +
      "; return diagnosticEvaluation;",
  )();
  return async (expression) => {
    expressions.push(expression.slice(0, 90));
    const reply = await window.eval(wrap(expression));
    assert.equal(reply.ok, true, reply.error?.message);
    return reply.value;
  };
}

test("wrapped-tail Find executes the shipped expression and rejects transient Range/count geometry", async () => {
  const dom = new JSDOM(
    '<div class="messages"><section class="turn"><article class="user-row" data-sent-message-id="tail"><span>Synthetic user 4999.</span></article></section></div><div class="bottom-zone"></div><div class="virtual-transcript-find"><input><div role="status">5000 / 5000</div></div>',
    { runScripts: "outside-only" },
  );
  const w = dom.window,
    d = w.document;
  const input = d.querySelector("input"),
    status = d.querySelector('[role="status"]');
  input.value = "Synthetic user ";
  const range = d.createRange();
  range.setStart(d.querySelector("span").firstChild, 0);
  range.setEnd(d.querySelector("span").firstChild, "Synthetic user".length);
  range.getBoundingClientRect = () => ({ top: 100, bottom: 120, height: 20 });
  d.querySelector(".messages").getBoundingClientRect = () => ({
    top: 20,
    bottom: 400,
  });
  d.querySelector(".bottom-zone").getBoundingClientRect = () => ({ top: 400 });
  w.CSS = { highlights: new Map([["zenx-thread-find-active", [range]]]) };
  const start = source.indexOf("  const findState = async (");
  const read = new Function(
    "evaluate",
    source.slice(start, source.indexOf("\n  await click(", start)) +
      "; return findState;",
  )(wrappedDiagnosticEvaluator(w));
  let frame = 0;
  w.requestAnimationFrame = (callback) =>
    queueMicrotask(() => {
      frame++;
      callback(frame);
    });
  try {
    const stable = await read("tail", "Synthetic user ", true);
    assert.equal(stable.accepted, true);
    assert.deepEqual(Array.from(stable.counts), [5000, 5000]);
    assert.equal(stable.stableAcrossFrames, true);
    assert.equal(stable.stableFrameCount, 2);
    assert.equal(frame, 2);
    // Correct initial/final state is insufficient if the intervening frame is stale.
    frame = 0;
    w.requestAnimationFrame = (callback) =>
      queueMicrotask(() => {
        status.textContent = ++frame === 1 ? "1 / 5000" : "5000 / 5000";
        callback(frame);
      });
    assert.equal(
      (await read("tail", "Synthetic user ", true)).stableAcrossFrames,
      false,
    );
    let rangeTop = 100;
    frame = 0;
    range.getBoundingClientRect = () => ({
      top: rangeTop,
      bottom: rangeTop + 20,
      height: 20,
    });
    w.requestAnimationFrame = (callback) =>
      queueMicrotask(() => {
        rangeTop = ++frame === 1 ? 120 : 100;
        callback(frame);
      });
    assert.equal(
      (await read("tail", "Synthetic user ", true)).stableAcrossFrames,
      false,
    );
    assert.equal((await read("wrong-id", "Synthetic user ")).accepted, false);
    range.setEnd(d.querySelector("span").firstChild, 5);
    assert.equal((await read("tail", "Synthetic user ")).accepted, false);
  } finally {
    w.close();
  }
});

async function nativeSelectAllFixture(
  fault,
  sharedDom,
  fullDomControl = false,
) {
  const dom =
    sharedDom ??
    new JSDOM("", { runScripts: "outside-only", url: "https://owned.invalid" });
  const withPlaceholder =
    fault === "copy-placeholder-variant" ||
    (fullDomControl && fault !== "control-no-role-raw-equal");
  const w = dom.window,
    d = w.document;
  d.body.innerHTML =
    '<main class="app-shell thread-view"><button class="thread-row" data-thread-id="owned-thread">Owned Thread</button><div class="messages experimental-transcript-viewport"></div><button class="back-live">Live</button><textarea id="thread-composer"></textarea></main>';
  const scroller = d.querySelector(".messages"),
    editor = d.querySelector("textarea"),
    backLive = d.querySelector(".back-live");
  w.innerWidth = 1280;
  w.innerHeight = 677;
  backLive.getClientRects = () => [{ width: 100, height: 20 }];
  Object.defineProperties(scroller, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 10000 },
  });
  scroller.scrollTop = 6000;
  if (withPlaceholder) {
    editor.placeholder = "Ask ZenX anything…";
    editor.getClientRects = () => [{ width: 100, height: 20 }];
  }
  w.requestAnimationFrame = (callback) => queueMicrotask(() => callback(1));
  scroller.getBoundingClientRect = () => ({
    left: 0,
    width: 1000,
    top: 20,
    bottom: 620,
  });
  const samples = Array.from({ length: 3 }, (_, i) => ({
    nonce: `Synthetic latency message 10000 ${i} unit-owned`,
  }));
  const markers = [
    ...Array.from({ length: 5000 }, (_, i) => `Synthetic user ${i}.`),
    ...samples.map((sample) => sample.nonce),
  ];
  const turns = markers.map((text, i) => ({
    items: [
      {
        type: "userMessage",
        id: `owned-${i}`,
        content: [{ type: "text", text }],
      },
      {
        type: "agentMessage",
        id: `assistant-${i}`,
        text:
          i < 5000
            ? `Synthetic assistant ${i}. Complete owned reply.`
            : `Echo: ${text}`,
      },
    ],
  }));
  const mount = (all) => {
    const indices = all
      ? Array.from({ length: 5003 }, (_, i) => i)
      : Array.from({ length: 8 }, (_, i) => i + 4980);
    if (
      all &&
      (fault === "wrong-order" || (reloaded && fault === "control-wrong-order"))
    )
      [indices[0], indices[1]] = [indices[1], indices[0]];
    scroller.innerHTML = indices
      .map(
        (i) =>
          `<section class="turn" data-transcript-row-key="row-${i}"><article class="user-row" data-sent-message-id="owned-${i}">${markers[i]}</article><article class="agent-copy" data-read-message-id="assistant-${i}">${turns[i].items[1].text}</article></section>`,
      )
      .join("");
    if (all && fault === "duplicate-assistant-id")
      scroller.querySelector(
        '[data-read-message-id="assistant-2501"]',
      ).dataset.readMessageId = "assistant-2500";
    if (all && fault === "duplicate-user-id")
      scroller.querySelector(
        '[data-sent-message-id="owned-2501"]',
      ).dataset.sentMessageId = "owned-2500";
    if (all && fault === "omitted-user-id")
      scroller
        .querySelector('[data-sent-message-id="owned-2501"]')
        .removeAttribute("data-sent-message-id");
    for (const row of scroller.children) {
      const i = Number(row.dataset.transcriptRowKey.slice(4));
      row.getBoundingClientRect = () => ({
        top:
          (i - 4980) * 100 +
          20 +
          (!all && fault === "lost-anchor" && cleared ? 10 : 0) +
          (fault === "no-visible-anchor" ? 1000 : 0),
        bottom:
          (i - 4980) * 100 + 120 + (fault === "no-visible-anchor" ? 1000 : 0),
      });
    }
    scroller.classList.toggle("experimental-transcript-viewport", !all);
    if (all) scroller.dataset.nativeTranscriptSelection = "complete";
    else delete scroller.dataset.nativeTranscriptSelection;
  };
  let reloaded = false,
    reloadFinished,
    nativeSelectAllCalls = 0,
    revealCalls = 0,
    wheelCalls = 0;
  let cleared = false,
    menuCalls = 0,
    nativeCopyCalls = 0,
    clipboardCleared = false,
    clipboardText = "";
  mount(false);
  const expressions = [],
    images = [];
  const evaluate = wrappedDiagnosticEvaluator(w, expressions);
  const result = {
    seed: { synthetic: true, userMessageCount: 5000 },
    fixtureModel: { provider: "fake" },
  };
  const mainFrame = {};
  if (fullDomControl) {
    w.sessionStorage.setItem("zenx.experimental.virtualTranscript", "1");
    w.sessionStorage.setItem("zenx.experimental.virtualTranscriptFind", "1");
    w.sessionStorage.setItem("owned-control-unrelated", "preserved");
    w.zenx = { protocol: { getStatus: async () => ({ type: "ready" }) } };
  }
  const nativeWindow = {
    getBounds: () => ({ width: w.innerWidth, height: w.innerHeight }),
    setBounds: ({ width, height }) => {
      w.innerWidth = width;
      w.innerHeight = height;
    },
    isFocused: () => true,
    webContents: {
      mainFrame,
      focusedFrame: fault === "wrong-focused-frame" ? {} : mainFrame,
      isFocused: () => true,
      once: (_event, listener) => {
        reloadFinished = listener;
      },
      removeListener: () => {
        reloadFinished = undefined;
      },
      reload() {
        reloaded = true;
        backLive.remove();
        scroller.scrollTop = 9400;
        delete w.__nativeSelectAllQuality;
        w.getSelection().removeAllRanges();
        mount(true);
        delete scroller.dataset.nativeTranscriptSelection;
        if (fault === "control-changed-prefix")
          d.querySelector(".thread-row").textContent = "Other Thread";
        if (fault === "control-changed-extra-ui")
          editor.before(d.createTextNode("Extra owned UI"));
        if (fault === "control-changed-body")
          scroller
            .querySelector(".agent-copy")
            .append(" Extra owned reply text");
        if (fault === "control-changed-placeholder")
          editor.placeholder = "Ask ZenX anything?";
        if (fault === "control-wrong-thread")
          for (const row of scroller.querySelectorAll("article.user-row"))
            row.dataset.sentMessageId = "foreign-" + row.dataset.sentMessageId;
        if (fault === "control-wrong-focus")
          nativeWindow.webContents.focusedFrame = {};
        reloadFinished();
      },
      sendInputEvent(event) {
        if (event.type !== "mouseWheel") return;
        assert.equal(reloaded, true);
        assert.equal(event.deltaY, 3600);
        wheelCalls++;
        if (fault !== "control-no-wheel-movement")
          scroller.scrollTop -= event.deltaY;
        if (fault !== "control-missing-pause") editor.before(backLive);
        if (fault === "control-changed-viewport") w.innerWidth = 1120;
      },
      async insertText(text) {
        editor.setRangeText(
          text,
          editor.selectionStart,
          editor.selectionEnd,
          "end",
        );
      },
    },
  };
  const menuItem = {
    accelerator: "CommandOrControl+A",
    enabled: true,
    click() {
      menuCalls++;
      if (d.activeElement === editor && fault !== "editor-stolen") {
        editor.select();
        return;
      }
      mount(true);
      // Synthetic native-action double only. Production diagnostic never creates a Range.
      if (fault !== "no-native-selection") {
        const range = d.createRange();
        range.selectNodeContents(scroller);
        if (withPlaceholder) range.selectNodeContents(d.body);
        if (fault === "truncated-final-assistant") {
          const lastUser = scroller.querySelector(
            '[data-sent-message-id="owned-5002"]',
          );
          range.setEnd(lastUser.firstChild, lastUser.firstChild.length);
        }
        if (fault === "partial-final-assistant") {
          const lastAssistant = scroller.querySelector(
            '[data-read-message-id="assistant-5002"]',
          );
          range.setEnd(
            lastAssistant.firstChild,
            lastAssistant.firstChild.length - 1,
          );
        }
        w.getSelection().removeAllRanges();
        w.getSelection().addRange(range);
      }
    },
  };
  const Menu = {
    getApplicationMenu: () => ({
      items: [
        {
          submenu: {
            items: [
              { role: "copy" },
              ...(reloaded
                ? [
                    "control-no-default-role",
                    "control-no-role-raw-equal",
                  ].includes(fault)
                  ? [menuItem]
                  : [{ role: "selectAll", enabled: true }]
                : fault === "no-product-handler"
                  ? []
                  : [menuItem]),
            ],
          },
        },
      ],
    }),
    sendActionToFirstResponder(action) {
      if (action === "selectAll:") {
        assert.equal(reloaded, true);
        nativeSelectAllCalls++;
        const range = d.createRange();
        range.selectNodeContents(d.body);
        const first = d.querySelector(".thread-row").firstChild;
        range.setStart(first, 0);
        w.getSelection().removeAllRanges();
        w.getSelection().addRange(range);
      } else if (action === "copy:") {
        nativeCopyCalls++;
        clipboardText = w.getSelection().toString();
        if (fault === "copy-missing-row")
          clipboardText = clipboardText.replace(markers[2500], "");
        if (fault === "copy-missing-assistant")
          clipboardText = clipboardText.replace(turns.at(-1).items[1].text, "");
        if (fault === "copy-lf-variant") clipboardText = "\r\n" + clipboardText;
        if (fault === "copy-nbsp-variant") clipboardText += "\u00a0";
        if (withPlaceholder) clipboardText += editor.placeholder + "\n";
        if (
          fault === "copy-endpoint-mutation" ||
          (reloaded && fault === "control-copy-endpoint-mutation")
        ) {
          const selection = w.getSelection(),
            before = w.__nativeSelectAllQuality,
            empty = d.createTextNode("");
          (reloaded
            ? d.querySelector(".thread-row")
            : scroller.firstElementChild
          ).prepend(empty);
          selection.getRangeAt(0).setStart(empty, 0);
          assert.equal(selection.toString() === before.text, true);
          assert.equal(before.orderedMessages(selection.toString()), 10006);
          assert.equal(
            selection.anchorNode !== before.anchorNode && empty.isConnected,
            true,
          );
          assert.equal(
            !selection.isCollapsed &&
              selection.anchorOffset === before.anchorOffset &&
              selection.focusNode === before.focusNode &&
              selection.focusOffset === before.focusOffset &&
              before.anchorNode.isConnected &&
              before.focusNode.isConnected,
            true,
          );
        }
        if (
          fault === "copy-lost-selection" ||
          (reloaded && fault === "control-copy-lost-selection")
        )
          w.getSelection().removeAllRanges();
      } else {
        assert.equal(action, "deleteBackward:");
        editor.setRangeText(
          "",
          editor.selectionStart,
          editor.selectionEnd,
          "end",
        );
      }
    },
  };
  const clipboard = {
    availableFormats: () =>
      fault === "occupied-clipboard" ||
      (reloaded && fault === "control-occupied-clipboard")
        ? ["text/plain"]
        : [],
    writeText: (text) => {
      clipboardText = text;
    },
    readText: () => clipboardText,
    clear: () => {
      clipboardCleared = true;
      clipboardText = "";
    },
  };
  const click = async (_expression, label) => {
    if (label.includes("Composer")) {
      cleared = true;
      w.getSelection().removeAllRanges();
      editor.focus();
      if (!reloaded && fault !== "no-bounded-restore") mount(false);
    } else editor.blur();
  };
  const until = async (check, label) => {
    for (let i = 0; i < 2; i++) if (await check()) return;
    throw Error(`Synthetic bounded wait failed: ${label}`);
  };
  const start = source.indexOf("function invokeProductSelectAll()");
  const check = new Function(
    "assert",
    "process",
    "window",
    "BrowserWindow",
    "Menu",
    "evaluate",
    "click",
    "result",
    "clipboard",
    "until",
    "screenshot",
    "revealThreadWithSidebarWheel",
    "fullDomControl",
    source.slice(start, source.indexOf("\nasync function run()", start)) +
      "; return { cleared: () => nativeCopyCandidate === undefined, cleanup: () => { nativeCopyCandidate = undefined; }, run: async (...args) => { await checkNativeSelectAll(...args); if (fullDomControl) await checkFullDomNativeCopy(...args, \"document.querySelector('.thread-row[data-thread-id=owned-thread]')\"); assertNativeClipboardMatch(); if (fullDomControl) assert.equal(result.nativeFullDomCopyControl.completed, true, 'Full DOM native Copy control must complete'); } };",
  )(
    assert,
    { platform: "darwin" },
    nativeWindow,
    { getFocusedWindow: () => nativeWindow },
    Menu,
    evaluate,
    click,
    result,
    clipboard,
    until,
    async (name) => images.push(name),
    async (target) => {
      assert.ok(await evaluate("Boolean(" + target + ")"));
      revealCalls++;
    },
    fullDomControl,
  );
  let error;
  try {
    await check.run(turns, samples);
  } catch (caught) {
    error = caught;
  }
  const mainMemoryCleared = check.cleared();
  check.cleanup();
  const privateStateCleaned = !w.__nativeSelectAllQuality;
  const unrelatedSessionPreserved =
    fullDomControl &&
    w.sessionStorage.getItem("owned-control-unrelated") === "preserved";
  delete w.__nativeSelectAllQuality;
  w.getSelection().removeAllRanges();
  d.body.replaceChildren();
  if (!sharedDom) w.close();
  await new Promise(setImmediate);
  return {
    error,
    result,
    expressions,
    images,
    menuCalls,
    nativeCopyCalls,
    clipboardCleared,
    cleared,
    nativeSelectAllCalls,
    revealCalls,
    wheelCalls,
    privateStateCleaned,
    mainMemoryCleared,
    unrelatedSessionPreserved,
  };
}

test("full native Select All diagnostic executes every shipped evaluate expression through its real wrapper", async () => {
  const run = await nativeSelectAllFixture();
  assert.ifError(run.error);
  assert.equal(
    run.menuCalls,
    2,
    "installed product menu covers page and editable input",
  );
  assert.equal(run.nativeCopyCalls, 1);
  assert.equal(run.clipboardCleared, true);
  assert.deepEqual(run.images, ["native-select-all.png"]);
  const quality = run.result.nativeSelectAllQuality;
  assert.equal(quality.mountedUserRows, 5003);
  assert.equal(quality.selectedMarkerCount, 5003);
  assert.equal(quality.copiedMarkerCount, 5003);
  assert.equal(quality.restoredMountedRows, 8);
  assert.equal(quality.mountedMessageRows, 10006);
  assert.equal(quality.selectedMessageCount, 10006);
  assert.equal(quality.copiedMessageCount, 10006);
  for (const field of ["menuToSelectionMs", "clearToRestoreMs"])
    assert.ok(Number.isFinite(quality[field]) && quality[field] >= 0);
  for (const [name, value] of Object.entries(quality))
    if (typeof value === "boolean")
      assert.equal(
        value,
        ![
          "copyComposerEligible",
          "copySelectionIntersectsComposer",
          "copyComposerSnapshotStable",
          "clipboardAddsOnlyComposerPlaceholderLF",
          "clipboardPlaceholderInsertionAtStart",
          "clipboardPlaceholderInsertionAtEnd",
          "clipboardPlaceholderInsertionAfterCanonicalMessages",
        ].includes(name),
        name,
      );
  assert.ok(run.expressions.length >= 8);
  assert.equal(JSON.stringify(quality).includes("owned-"), false);
  assert.equal(JSON.stringify(quality).includes("Synthetic user"), false);
});

test("native Select All quality fails closed for missing bridge, partial selection, reordered DOM, bad copy, lost selection and failed restore", async () => {
  const sharedDom = new JSDOM("", { runScripts: "outside-only" });
  try {
    for (const fault of [
      "no-product-handler",
      "wrong-focused-frame",
      "no-native-selection",
      "wrong-order",
      "duplicate-user-id",
      "omitted-user-id",
      "no-visible-anchor",
      "occupied-clipboard",
      "copy-missing-row",
      "copy-lost-selection",
      "no-bounded-restore",
      "lost-anchor",
      "editor-stolen",
    ]) {
      const run = await nativeSelectAllFixture(fault, sharedDom);
      assert.ok(run.error, fault);
      if (["duplicate-user-id", "omitted-user-id"].includes(fault)) {
        assert.equal(run.result.nativeSelectAllQuality.canonicalOrder, false);
        assert.equal(run.result.nativeSelectAllQuality.mountedUserRows, 5003);
        assert.equal(
          run.result.nativeSelectAllQuality.selectedMarkerCount,
          5003,
        );
      }
      if (
        [
          "no-product-handler",
          "wrong-focused-frame",
          "no-native-selection",
          "wrong-order",
          "duplicate-user-id",
          "omitted-user-id",
          "no-visible-anchor",
          "occupied-clipboard",
        ].includes(fault)
      )
        assert.equal(run.nativeCopyCalls, 0, fault);
      if (["copy-missing-row", "copy-lost-selection"].includes(fault)) {
        assert.equal(run.clipboardCleared, true, fault);
        assert.equal(
          run.cleared,
          false,
          "Endpoint/body failure must stop before native clear",
        );
      }
    }
  } finally {
    sharedDom.window.close();
  }
});

test("native Copy rejects changed connected endpoint identity with identical complete text before clear", async () => {
  const run = await nativeSelectAllFixture("copy-endpoint-mutation"),
    q = run.result.nativeSelectAllQuality;
  assert.ok(run.error);
  assert.equal(q.clipboardMatchesSelection, true);
  assert.equal(q.copiedMessageCount, 10006);
  assert.equal(q.selectionSurvivesCopy, false);
  assert.equal(run.clipboardCleared, true);
  assert.equal(run.cleared, false);
});

test("native canonical message oracle rejects unselected or partial final assistant, invalid assistant IDs and missing copied reply", async () => {
  const sharedDom = new JSDOM("", { runScripts: "outside-only" });
  try {
    for (const fault of [
      "truncated-final-assistant",
      "partial-final-assistant",
      "duplicate-assistant-id",
      "copy-missing-assistant",
    ]) {
      const run = await nativeSelectAllFixture(fault, sharedDom);
      assert.ok(run.error, fault);
      const quality = run.result.nativeSelectAllQuality;
      assert.equal(quality.mountedMessageRows, 10006);
      assert.equal(quality.selectedMarkerCount, 5003);
      if (fault === "copy-missing-assistant") {
        assert.equal(quality.selectedMessageCount, 10006);
        assert.equal(quality.copiedMessageCount, 10005);
        assert.equal(quality.fullLastAssistantCopied, false);
        assert.equal(run.clipboardCleared, true);
      } else {
        assert.equal(run.nativeCopyCalls, 0);
        if (fault === "duplicate-assistant-id") {
          assert.equal(quality.canonicalMessageOrder, false);
          assert.equal(quality.selectedMessageCount, 10006);
        } else {
          assert.equal(quality.canonicalMessageOrder, true);
          assert.equal(quality.selectedMessageCount, 10005);
          assert.equal(quality.fullLastAssistantSelected, false);
        }
      }
    }
  } finally {
    sharedDom.window.close();
  }
});

test("clipboard comparator executes the shipped wrapper with independent transforms and finite character counts", async () => {
  const start = source.indexOf("const copy = await evaluate("),
    literalStart = source.indexOf("`", start),
    literalEnd = source.indexOf("`);", literalStart);
  const expression = new Function(
    "copied",
    "return " + source.slice(literalStart, literalEnd + 1),
  );
  const dom = new JSDOM("<p></p>", { runScripts: "outside-only" }),
    w = dom.window;
  w.requestAnimationFrame = (callback) => queueMicrotask(callback);
  const evaluate = wrappedDiagnosticEvaluator(w);
  const compare = async (selected, copied) => {
    const p = w.document.querySelector("p");
    p.textContent = selected;
    const range = w.document.createRange();
    range.selectNodeContents(p);
    const selection = w.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    w.__nativeSelectAllQuality = {
      text: selected,
      anchorNode: selection.anchorNode,
      focusNode: selection.focusNode,
      anchorOffset: selection.anchorOffset,
      focusOffset: selection.focusOffset,
      orderedMarkers: () => 0,
      orderedMessages: () => 0,
      lastAssistant: () => false,
    };
    return evaluate(expression(copied));
  };
  try {
    const result = await compare("A\r\nB\u00a0\t😀", "A\nB \t😀");
    for (const [key, expected] of Object.entries({
      selectedUTF16Length: 8,
      copiedUTF16Length: 7,
      selectedCRCount: 1,
      copiedCRCount: 0,
      selectedLFCount: 1,
      copiedLFCount: 1,
      selectedNBSPCount: 1,
      copiedNBSPCount: 0,
      selectedTABCount: 1,
      copiedTABCount: 1,
      clipboardMatchesSelection: false,
      clipboardEqualAfterLF: false,
      clipboardEqualAfterNBSP: false,
      clipboardEqualAfterEdgeTrim: false,
      clipboardEqualAfterLFAndNBSP: true,
      clipboardEqualAfterCollapsedWhitespace: true,
      clipboardEqualNonWhitespace: true,
    }))
      assert.equal(result[key], expected, key);
    const edge = await compare(" A ", "A");
    assert.equal(edge.clipboardEqualAfterEdgeTrim, true);
    assert.equal(edge.clipboardEqualAfterCollapsedWhitespace, false);
    assert.equal((await compare("A", "AX")).clipboardEqualNonWhitespace, false);
    assert.ok(
      Object.values(result).every(
        (value) => typeof value === "boolean" || Number.isFinite(value),
      ),
    );
  } finally {
    w.close();
  }
});

test("owned composer placeholder attribution executes both shipped wrappers and rejects unrelated changes", async () => {
  const expression = (marker) => {
    const start = source.indexOf(marker),
      literalStart = source.indexOf("`", start),
      literalEnd = source.indexOf("`", literalStart + 1);
    assert.ok(start >= 0 && literalEnd > literalStart);
    return new Function(
      "copied",
      "return " + source.slice(literalStart, literalEnd + 1),
    );
  };
  const snapshot = expression("// Snapshot only the owned empty composer"),
    copy = expression("const copy = await evaluate("),
    dom = new JSDOM("", { runScripts: "outside-only" }),
    w = dom.window,
    evaluate = wrappedDiagnosticEvaluator(w),
    placeholder = "Ask ZenX anything…",
    token = placeholder + "\n";
  w.requestAnimationFrame = (callback) => queueMicrotask(callback);
  const compare = async (selected, copied, options = {}) => {
    w.document.body.innerHTML =
      '<div id="owned"><p></p><textarea id="thread-composer"></textarea></div>';
    const root = w.document.querySelector("#owned"),
      paragraph = root.querySelector("p"),
      editor = root.querySelector("textarea");
    paragraph.textContent = selected;
    editor.placeholder = options.placeholder ?? placeholder;
    editor.value = options.value ?? "";
    editor.getClientRects = () =>
      options.hidden ? [] : [{ width: 100, height: 20 }];
    if (options.invisible) editor.style.visibility = "hidden";
    const range = w.document.createRange();
    range.selectNodeContents(options.excludeComposer ? paragraph : root);
    const selection = w.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    w.__nativeSelectAllQuality = {
      orderedMarkers: () => 0,
      orderedMessages: (text) => (text === selected ? 10006 : 0),
      lastAssistant: () => false,
    };
    assert.equal(await evaluate(snapshot()), true);
    if (options.changedPlaceholder) editor.placeholder = "Changed owned label";
    if (options.changedValue) editor.value = "Owned draft";
    if (options.replacedComposer) editor.replaceWith(editor.cloneNode());
    return evaluate(copy(copied));
  };
  try {
    for (const [name, selected, copied, expected] of [
      ["head", "A\nB", token + "A\nB", true],
      ["middle", "A\nB", "A\n" + token + "B", true],
      ["tail", "A\nB", "A\nB" + token, true],
      ["other extra", "A\nB", "A\nBUnknown extraneous\n", false],
      ["lost body", "A\nB", "A\n" + token, false],
      ["reordered", "A\nB", "B\nA" + token, false],
      ["duplicate placeholder", "A\nB", token + "A\nB" + token, false],
      [
        "label already selected",
        "A\n" + placeholder,
        "A\n" + placeholder + token,
        false,
      ],
      ["wrong newline", "A\nB", "A\nB" + placeholder + "\r", false],
      ["whitespace change", "A B", "A  B" + token, false],
    ]) {
      const result = await compare(selected, copied);
      assert.equal(
        result.clipboardAddsOnlyComposerPlaceholderLF,
        expected,
        name,
      );
      assert.equal(result.copyComposerEligible, true, name);
      assert.equal(result.copySelectionIntersectsComposer, true, name);
      assert.equal(result.copyComposerSnapshotStable, true, name);
      assert.equal(result.copyPlaceholderUTF16Length, 18, name);
      assert.equal(result.clipboardMatchesSelection, false, name);
      assert.equal(result.selectionSurvivesCopy, true, name);
      assert.equal(
        result.clipboardPlaceholderInsertionAtStart,
        name === "head",
        name,
      );
      assert.equal(
        result.clipboardPlaceholderInsertionAtEnd,
        name === "tail",
        name,
      );
      assert.equal(
        result.clipboardPlaceholderInsertionAfterCanonicalMessages,
        name === "tail",
        name,
      );
      assert.ok(
        Object.values(result).every(
          (v) => typeof v === "boolean" || Number.isFinite(v),
        ),
      );
      assert.equal(JSON.stringify(result).includes(placeholder), false);
    }
    for (const options of [
      { value: "Owned draft" },
      { hidden: true },
      { invisible: true },
      { excludeComposer: true },
      { changedPlaceholder: true },
      { changedValue: true },
      { replacedComposer: true },
      { placeholder: "" },
      { placeholder: "P".repeat(129) },
    ]) {
      const p = options.placeholder ?? placeholder;
      const result = await compare("A\nB", "A\nB" + p + "\n", options);
      assert.equal(result.clipboardAddsOnlyComposerPlaceholderLF, false);
    }
    const limit = "P".repeat(128);
    const bounded = await compare("A\nB", "A\nB" + limit + "\n", {
      placeholder: limit,
    });
    assert.equal(bounded.copyPlaceholderUTF16Length, 128);
    assert.equal(bounded.clipboardAddsOnlyComposerPlaceholderLF, true);
  } finally {
    w.close();
  }
});

test("exact composer placeholder attribution cannot waive raw native clipboard failure", async () => {
  const run = await nativeSelectAllFixture("copy-placeholder-variant"),
    q = run.result.nativeSelectAllQuality;
  assert.match(run.error?.message ?? "", /comparison diagnostics do not waive/);
  assert.equal(q.clipboardAddsOnlyComposerPlaceholderLF, true);
  assert.equal(q.copySelectionIntersectsComposer, true);
  assert.equal(q.clipboardPlaceholderInsertionAtEnd, true);
  assert.equal(q.clipboardPlaceholderInsertionAfterCanonicalMessages, true);
  assert.equal(q.clipboardMatchesSelection, false);
  assert.equal(q.copiedMessageCount, 10006);
  assert.equal(q.fullLastAssistantCopied, true);
  assert.equal(q.selectionSurvivesCopy, true);
  assert.equal(
    q.virtualRestored && q.restoredReaderAnchor && q.editableSelectionPreserved,
    true,
  );
  assert.equal(run.cleared && run.clipboardCleared, true);
});

test("raw native clipboard mismatch remains a final failure after restoration and editable checks", async () => {
  const sharedDom = new JSDOM("", { runScripts: "outside-only" });
  try {
    for (const fault of ["copy-lf-variant", "copy-nbsp-variant"]) {
      const run = await nativeSelectAllFixture(fault, sharedDom),
        q = run.result.nativeSelectAllQuality;
      assert.match(
        run.error?.message ?? "",
        /comparison diagnostics do not waive/,
      );
      assert.equal(q.clipboardMatchesSelection, false);
      assert.equal(q.copiedMessageCount, 10006);
      assert.equal(q.fullLastAssistantCopied, true);
      assert.equal(q.selectionSurvivesCopy, true);
      assert.equal(
        q.selectionCleared &&
          q.virtualRestored &&
          q.restoredReaderAnchor &&
          q.editableSelectionPreserved,
        true,
      );
      assert.equal(
        q.clipboardEqualAfterEdgeTrim && q.clipboardEqualNonWhitespace,
        true,
      );
      assert.equal(
        q.copiedUTF16Length - q.selectedUTF16Length,
        fault === "copy-lf-variant" ? 2 : 1,
      );
      assert.equal(run.cleared && run.clipboardCleared, true);
    }
  } finally {
    sharedDom.window.close();
  }
  assert.ok(
    source.indexOf(
      "  assertNativeClipboardMatch();",
      source.indexOf("async function run()"),
    ) > source.indexOf("await screenshot(`responsive-history-${width}.png`)"),
  );
});

test("same-session default full DOM Copy executes native actions, reuses attribution and keeps virtual raw failure", async () => {
  const run = await nativeSelectAllFixture(undefined, undefined, true);
  assert.match(run.error?.message ?? "", /comparison diagnostics do not waive/);
  const original = run.result.nativeSelectAllQuality,
    control = run.result.nativeFullDomCopyControl;
  assert.equal(original.clipboardMatchesSelection, false);
  assert.equal(
    original.virtualRestored &&
      original.restoredReaderAnchor &&
      original.editableSelectionPreserved,
    true,
  );
  assert.equal(control.completed, true);
  assert.equal(
    control.defaultOffAfterReload &&
      control.defaultSelectAllRole &&
      control.afterVirtualAssertions,
    true,
  );
  assert.equal(control.canonicalOrder && control.canonicalMessageOrder, true);
  assert.equal(control.selectedMessageCount, 10006);
  assert.equal(control.copiedMessageCount, 10006);
  assert.equal(
    control.fullLastAssistantSelected &&
      control.fullLastAssistantCopied &&
      control.selectionSurvivesCopy,
    true,
  );
  assert.equal(control.clipboardMatchesSelection, false);
  assert.equal(control.clipboardAddsOnlyComposerPlaceholderLF, true);
  assert.equal(
    control.clipboardPlaceholderInsertionAfterCanonicalMessages,
    true,
  );
  for (const key of [
    "selectionClearBeforeSelectAll",
    "nativeWheelMovedViewport",
    "sameViewportAsCandidate",
    "candidatePausedAtCopy",
    "pausedAtCopy",
    "samePausedReaderState",
    "wholeCopyMatchesCandidate",
    "samePlaceholderAsCandidate",
    "selectionMatchesCandidateFromExactPlaceholder",
  ])
    assert.equal(control[key], true, key);
  assert.equal(control.candidateCopiedUTF16Length, original.copiedUTF16Length);
  assert.equal(run.wheelCalls, 1);
  assert.equal(JSON.stringify(run.result).includes("Ask ZenX anything"), false);
  assert.equal(control.selectionCleared, true);
  assert.equal(run.nativeSelectAllCalls, 1);
  assert.equal(run.nativeCopyCalls, 2);
  assert.equal(
    run.menuCalls,
    2,
    "control cannot invoke the experimental bridge",
  );
  assert.equal(run.revealCalls, 1);
  assert.equal(
    run.privateStateCleaned &&
      run.mainMemoryCleared &&
      run.unrelatedSessionPreserved &&
      run.clipboardCleared,
    true,
  );
  assert.deepEqual(run.images, ["native-select-all.png"]);
  assert.ok(
    source.indexOf(
      "  await checkFullDomNativeCopy(",
      source.indexOf("async function run()"),
    ) > source.indexOf("await screenshot(`responsive-history-${width}.png`)"),
  );
});

test("full DOM control fails closed for bridge substitution, canonical reorder and copy endpoint loss without hiding virtual raw failure", async () => {
  const sharedDom = new JSDOM("", {
    runScripts: "outside-only",
    url: "https://owned.invalid",
  });
  try {
    for (const fault of [
      "control-no-default-role",
      "control-wrong-order",
      "control-wrong-thread",
      "control-wrong-focus",
      "control-occupied-clipboard",
      "control-copy-endpoint-mutation",
      "control-copy-lost-selection",
    ]) {
      const run = await nativeSelectAllFixture(fault, sharedDom, true);
      assert.match(
        run.error?.message ?? "",
        /comparison diagnostics do not waive/,
        fault,
      );
      assert.equal(
        run.result.nativeSelectAllQuality.clipboardMatchesSelection,
        false,
        fault,
      );
      assert.equal(run.result.nativeFullDomCopyControl.completed, false, fault);
      assert.equal(
        run.privateStateCleaned && run.mainMemoryCleared,
        true,
        fault,
      );
      if (
        [
          "control-copy-lost-selection",
          "control-copy-endpoint-mutation",
        ].includes(fault)
      ) {
        assert.equal(
          run.result.nativeFullDomCopyControl.selectionSurvivesCopy,
          false,
          fault,
        );
        assert.equal(
          run.result.nativeFullDomCopyControl.copiedMessageCount,
          10006,
          fault,
        );
      }
      if (fault === "control-occupied-clipboard")
        assert.equal(run.nativeCopyCalls, 1, fault);
      assert.equal(run.menuCalls, 2, fault);
      assert.equal(
        run.nativeSelectAllCalls,
        [
          "control-copy-lost-selection",
          "control-copy-endpoint-mutation",
          "control-occupied-clipboard",
        ].includes(fault)
          ? 1
          : 0,
        fault,
      );
    }
  } finally {
    sharedDom.window.close();
  }
});

test("same-state whole native Copy comparison rejects missing pause, changed viewport and extra UI/body/prefix", async () => {
  const sharedDom = new JSDOM("", {
    runScripts: "outside-only",
    url: "https://owned.invalid",
  });
  try {
    for (const fault of [
      "control-missing-pause",
      "control-no-wheel-movement",
      "control-changed-viewport",
      "control-changed-extra-ui",
      "control-changed-body",
      "control-changed-prefix",
      "control-changed-placeholder",
    ]) {
      const run = await nativeSelectAllFixture(fault, sharedDom, true),
        control = run.result.nativeFullDomCopyControl;
      assert.match(
        run.error?.message ?? "",
        /comparison diagnostics do not waive/,
        fault,
      );
      assert.notEqual(control.wholeCopyMatchesCandidate, true, fault);
      assert.notEqual(
        control.selectionMatchesCandidateFromExactPlaceholder,
        true,
        fault,
      );
      if (
        [
          "control-missing-pause",
          "control-no-wheel-movement",
          "control-changed-viewport",
        ].includes(fault)
      )
        assert.equal(control.completed, false, fault);
      else {
        assert.equal(control.completed, true, fault);
        assert.equal(control.samePausedReaderState, true, fault);
        assert.equal(control.copiedMessageCount, 10006, fault);
        assert.equal(
          control.clipboardAddsOnlyComposerPlaceholderLF,
          true,
          fault,
        );
      }
      if (fault === "control-changed-prefix")
        assert.equal(
          control.copiedUTF16Length,
          control.candidateCopiedUTF16Length,
        );
      assert.equal(
        run.privateStateCleaned && run.mainMemoryCleared,
        true,
        fault,
      );
    }
  } finally {
    sharedDom.window.close();
  }
});

test("full DOM control independently blocks acceptance when original virtual raw equality passes", async () => {
  const run = await nativeSelectAllFixture(
    "control-no-role-raw-equal",
    undefined,
    true,
  );
  assert.equal(
    run.result.nativeSelectAllQuality.clipboardMatchesSelection,
    true,
  );
  assert.equal(run.result.nativeFullDomCopyControl.completed, false);
  assert.match(
    run.error?.message ?? "",
    /Full DOM native Copy control must complete/,
  );
  assert.equal(run.nativeSelectAllCalls, 0);
  assert.equal(run.privateStateCleaned, true);
});

test("capture and exporter accept only the same fixed 19-image bound including native selection and failure", async () => {
  const names = [
    ...[0, 1, 2].flatMap((i) =>
      ["before", "after"].map(
        (side) => `messages-10000-sample-${i}-${side}.png`,
      ),
    ),
    "information-presentation-before-timing.png",
    ...["after-canonical", "before-natural-up", "after-natural-up"].map(
      (stage) => `legend-history-${stage}.png`,
    ),
    ...["old-history", "wrapped-tail"].map(
      (stage) => `virtual-find-${stage}.png`,
    ),
    "virtual-selection-before-scroll.png",
    "native-select-all.png",
    "paused-reader-after-native-resize.png",
    ...[390, 640, 641].map((width) => `responsive-history-${width}.png`),
    "send-latency-failure.png",
  ];
  assert.equal(names.length, 19);
  const start = source.indexOf("const capturedScreenshots = new Set();");
  const writes = [];
  const capture = new Function(
    "assert",
    "fs",
    "path",
    "directory",
    "window",
    source.slice(start, source.indexOf("// Full-DOM checks", start)) +
      ";return screenshot;",
  )(
    assert,
    { writeFile: async (_path, bytes) => writes.push(bytes) },
    path,
    "/owned",
    {
      webContents: { capturePage: async () => ({ toPNG: () => "owned PNG" }) },
    },
  );
  for (const name of names) await capture(name);
  assert.equal(writes.length, 19);
  await assert.rejects(
    capture("messages-10001-sample-0-before.png"),
    /count stays bounded/,
  );
  await assert.rejects(capture("private-file.png"));
  const fs = require("node:fs/promises"),
    os = require("node:os"),
    fsConstants = require("node:fs").constants;
  const launch = readFileSync(
    path.join(__dirname, "launch-send-focus-paired.mjs"),
    "utf8",
  );
  const copy = new Function(
    "assert",
    "readdir",
    "open",
    "writeFile",
    "path",
    "fsConstants",
    "return (" +
      launch.slice(
        launch.indexOf("async function copyOwnedSyntheticScreenshots("),
        launch.indexOf("let cleanupSafe ="),
      ) +
      ")",
  )(assert, fs.readdir, fs.open, fs.writeFile, path, fsConstants);
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "zen-native-selectall-cap-"),
  );
  try {
    const directory = path.join(root, "source"),
      uploadDirectory = path.join(root, "out");
    await fs.mkdir(directory);
    await fs.mkdir(uploadDirectory);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    for (const name of names)
      await fs.writeFile(path.join(directory, name), png);
    const args = {
      directory,
      uploadDirectory,
      capture: {
        seed: { synthetic: true, userMessageCount: 5000 },
        fixtureModel: { provider: "fake" },
        packagedRuntime: { isPackaged: true },
      },
      close: { code: 1, signal: null },
      guard: { scan() {} },
      privateConfig: "owned",
    };
    assert.deepEqual(await copy(args), [...names].sort());
    await fs.writeFile(
      path.join(directory, "messages-10001-sample-0-before.png"),
      png,
    );
    await assert.rejects(copy(args), /count stays bounded/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
