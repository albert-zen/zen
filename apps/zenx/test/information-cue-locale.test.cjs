const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const {
  assertChineseInformationCue,
  classifySingleSiblingCueFit,
  informationCueLabelMetrics,
} = require("../scripts/information-overflow-acceptance.cjs");
const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});
function sample() {
  return {
    language: "zh-CN",
    storedLanguage: "zh-CN",
    viewport: { width: 1600, height: 970 },
    resource: { open: "true", expanded: "false", primaryActive: "false" },
    overlayCount: 1,
    dockCount: 0,
    ownerKey: "thread:synthetic",
    owned: true,
    panel: rect(700, 100, 360, 676),
    popover: rect(700, 58, 360, 718),
    toolbar: rect(700, 58, 360, 42),
    dismiss: rect(930, 64, 115, 36),
    closeHit: true,
    clientHeight: 676,
    scrollHeight: 1760,
    panelScroll: 0,
    remaining: 1084,
    composer: rect(300, 850, 700, 36),
    composerDraft: "synthetic draft",
    transcript: rect(300, 40, 700, 750),
    transcriptScroll: 100,
    toggle: rect(1020, 4, 36, 36),
    active: { tag: "BUTTON", id: "close" },
    questions: [{ id: "first" }, { id: "second" }],
    cue: {
      text: "下方还有内容",
      hidden: false,
      display: "inline-flex",
      visibility: "visible",
      rect: rect(714, 64, 100, 36),
      ariaHidden: "true",
      tabIndex: -1,
      interactiveCount: 0,
      pointerEvents: "none",
      ownsPointer: false,
    },
    innerLabel: {
      text: "下方还有内容",
      clientWidth: 84,
      scrollWidth: 84,
      rect: rect(730, 64, 84, 36),
      fontFamily: "synthetic",
    },
  };
}
test("Chinese inner label fits only with exact document locale and actual inner widths", () => {
  const s = sample();
  assert.doesNotThrow(() => assertChineseInformationCue(s, s));
});
for (const [name, mutate, pattern] of [
  [
    "wrong document locale",
    (s) => (s.language = "zh"),
    /actual document locale/,
  ],
  [
    "inner text clipped even when outer fits",
    (s) => s.innerLabel.scrollWidth++,
    /inner Chinese text fits/,
  ],
  [
    "zero inner width",
    (s) => (s.innerLabel.clientWidth = 0),
    /inner Chinese text fits/,
  ],
  [
    "incorrect inner label",
    (s) => (s.innerLabel.text = "下方…"),
    /inner Chinese text fits/,
  ],
  [
    "translated Close overlap",
    (s) => (s.dismiss.left = 800),
    /does not overlap/,
  ],
  [
    "missing real overflow",
    (s) => (s.scrollHeight = s.clientHeight),
    /real content remaining/,
  ],
  ["scope changed", (s) => (s.ownerKey = "thread:other"), /other/],
])
  test(`Chinese rejects ${name}`, () => {
    const before = sample(),
      s = sample();
    mutate(s);
    assert.throws(() => assertChineseInformationCue(s, before), pattern);
  });

function fitting() {
  const s = sample();
  s.questions = [{ id: "sibling" }];
  s.scrollHeight = s.clientHeight;
  s.remaining = 0;
  s.cue.hidden = true;
  s.cue.display = "none";
  s.cue.rect = rect(0, 0, 0, 0);
  return s;
}
test("genuine positive-height zero-scroll single sibling can prove no-overflow", () => {
  assert.equal(
    classifySingleSiblingCueFit(fitting(), "thread:synthetic", "sibling")
      .status,
    "passed",
  );
});
for (const [name, mutate] of [
  [
    "bottom of overflowing panel",
    (s) => {
      s.scrollHeight += 500;
      s.panelScroll = 500;
      s.remaining = 0;
    },
  ],
  ["nonzero scroll", (s) => (s.panelScroll = 0.5)],
  ["zero owner height", (s) => (s.clientHeight = 0)],
  ["hidden or unowned owner", (s) => (s.owned = false)],
  ["missing dimensions", (s) => (s.scrollHeight = undefined)],
  ["wrong sibling", (s) => (s.questions[0].id = "other")],
  ["two siblings", (s) => s.questions.push({ id: "extra" })],
])
  test(`fitting observation leaves ${name} explicitly unexercised`, () => {
    const s = fitting();
    mutate(s);
    assert.equal(
      classifySingleSiblingCueFit(s, "thread:synthetic", "sibling").status,
      "not-exercised",
    );
  });
test("actually fitting but visible cue is a real assertion failure", () => {
  const s = fitting();
  s.cue.hidden = false;
  assert.throws(
    () => classifySingleSiblingCueFit(s, "thread:synthetic", "sibling"),
    /genuinely fitting owner/,
  );
});

const source = fs.readFileSync(
  require.resolve("../scripts/capture-information-board.cjs"),
  "utf8",
);
const code = source.slice(
  source.indexOf("const readCueLabel ="),
  source.indexOf("async function selectValue("),
);
function harness(options = {}) {
  const original = options.original ?? null,
    map = new Map(original === null ? [] : [["zenx.language", original]]),
    writes = [],
    images = [],
    result = { cases: [] };
  const document = {
    documentElement: { lang: "en" },
    querySelector: () => ({
      textContent:
        document.documentElement.lang === "zh-CN"
          ? "下方还有内容"
          : "More below",
    }),
  };
  const storage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(["set", key, value]);
      map.set(key, value);
    },
    removeItem: (key) => {
      writes.push(["remove", key]);
      map.delete(key);
    },
  };
  class StorageEvent {
    constructor(type, init) {
      Object.assign(this, { type }, init);
    }
  }
  const browser = {
    localStorage: storage,
    document,
    StorageEvent,
    dispatchEvent: (event) => {
      if (options.restoreFails && event.newValue !== "zh-CN") return;
      document.documentElement.lang =
        event.newValue === "zh-CN"
          ? options.wrongLang
            ? "zh"
            : "zh-CN"
          : "en";
    },
  };
  const read = () => {
    const s = options.sole ? fitting() : sample();
    s.language = document.documentElement.lang;
    s.storedLanguage = storage.getItem("zenx.language");
    if (s.language !== "zh-CN") {
      s.cue.text = "More below";
      s.innerLabel.text = "More below";
    }
    if (options.clipped && s.language === "zh-CN") s.innerLabel.scrollWidth++;
    if (options.noFit) {
      s.scrollHeight += 500;
      s.panelScroll = 500;
      s.remaining = 0;
    }
    return s;
  };
  const context = {
    assert,
    result,
    assertChineseInformationCue,
    classifySingleSiblingCueFit,
    informationCueLabelMetrics: function () {},
    informationOverflowMetrics: function () {},
    informationReachabilityMetrics: function () {},
    pause: async () => {},
    screenshot: async (name) => images.push(name),
    evaluate: async (expression) =>
      expression.startsWith("(function")
        ? read()
        : vm.runInNewContext(expression, browser),
    until: async (fn, label) => assert.ok(await fn(), label),
  };
  vm.runInNewContext(
    code +
      ";globalThis.chinese=verifyChineseSplitCueLabel;globalThis.fit=observeSingleSiblingCueFit;",
    context,
  );
  return {
    writes,
    images,
    result,
    storage,
    document,
    chinese: () => context.chinese(),
    fit: () => context.fit("synthetic", "sibling"),
  };
}
for (const original of [null, "en", "system"])
  test(`Chinese probe restores exact original language value ${original}`, async () => {
    const f = harness({ original });
    await f.chinese();
    assert.equal(f.storage.getItem("zenx.language"), original);
    assert.equal(f.document.documentElement.lang, "en");
    assert.equal(f.result.cases[0].status, "passed");
    assert.deepEqual(f.images, ["03i-overflow-cue-Chinese-label.png"]);
    assert.ok(f.writes.every((w) => w[1] === "zenx.language"));
    if (original === null)
      assert.deepEqual(f.writes.at(-1), ["remove", "zenx.language"]);
  });
test("failed Chinese inner fit still restores original preference and records exact failing sample", async () => {
  const f = harness({ clipped: true });
  await assert.rejects(f.chinese(), /inner Chinese text fits/);
  assert.equal(f.result.cases[0].status, "failed");
  assert.equal(f.storage.getItem("zenx.language"), null);
  assert.equal(f.document.documentElement.lang, "en");
  assert.ok(f.result.cases[0].failureSample.innerLabel.scrollWidth > 84);
});
test("wrong production lang is not fixed with direct DOM assignment", async () => {
  const f = harness({ wrongLang: true });
  await assert.rejects(f.chinese(), /real Chinese/);
  assert.equal(f.document.documentElement.lang, "en");
});
test("failed restoration is explicit, not a successful verification", async () => {
  const f = harness({ restoreFails: true });
  await assert.rejects(f.chinese(), /restored/);
  assert.equal(f.result.cases[0].status, "failed");
  assert.ok(f.result.cases[0].restorationError);
});
for (const noFit of [false, true])
  test(`single-sibling passive probe noFit=${noFit} sends no input, preference write or new screenshot`, async () => {
    const f = harness({ sole: true, noFit });
    await f.fit();
    assert.equal(f.result.cases[0].status, noFit ? "not-exercised" : "passed");
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.images, []);
  });
test("source boundaries: readonly inner metrics, no forced lang/response/theme/sizing work, sole submission already verified", () => {
  assert.doesNotMatch(
    informationCueLabelMetrics.toString(),
    /\.lang\s*=|scrollTop\s*=|\.focus\(|\.click\(/,
  );
  assert.doesNotMatch(
    code,
    /documentElement\.lang\s*=(?!=)|questions\/respond|sendInputEvent|resizeWindow|nativeTheme|scrollIntoView|scrollTop\s*=/,
  );
  assert.match(code, /localStorage\.removeItem/);
  assert.match(code, /documentElement\.lang/);
  const call = source.indexOf("await observeSingleSiblingCueFit(threadId");
  assert.ok(
    source.indexOf("assert.equal(receipt.remaining.totalPending, 1)") < call,
  );
  assert.ok(
    source.indexOf('"no duplicate respond after native activation settles"') <
      call,
  );
});
