const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(
  require.resolve("../scripts/capture-information-board.cjs"),
  "utf8",
);
const code = source.slice(
  source.indexOf("async function verifyInformationDarkSplitCue("),
  source.indexOf("async function settledLayout()"),
);

function run(options = {}) {
  const changes = [],
    images = [],
    result = { cases: [] };
  let theme = "light",
    helperCalls = 0,
    restoredReads = 0;
  const nativeTheme = {
    get themeSource() {
      return theme;
    },
    set themeSource(value) {
      changes.push(value);
      theme = value;
    },
    get shouldUseDarkColors() {
      return options.wrongNativeDark ? false : theme === "dark";
    },
  };
  const snapshot = () => {
    if (changes.length === 2) restoredReads++;
    const scroll = options.fractionalRestoration
      ? changes.length === 2
        ? (options.restoredScroll ?? 0)
        : 0.5
      : 0;
    return {
      viewport: { width: 1600, height: 970, dpr: 1 },
      layoutSettled: !(
        options.lateRestoredLayout &&
        changes.length === 2 &&
        restoredReads === 1
      ),
      appearance: theme,
      prefersDark: theme === "dark",
      forcedColorsActive: false,
      ownerKey: "thread:synthetic",
      panelScroll: scroll,
      remaining: 1084 - scroll,
      composerHeight:
        options.restoreNonScrollDrift && changes.length === 2 ? 37 : 36,
      lastVisibleContent: {
        text: "Send answers",
        rect: {
          top: 737 - scroll,
          bottom: 781 - scroll,
          width: 100,
          height: 44,
        },
      },
      active: {
        id:
          options.restoreFocusChange && changes.length === 2
            ? "different"
            : "original",
      },
      questions: [
        {
          id: "first",
          prompts: ["sibling"],
          actions: [
            {
              rect: {
                top: 418 - scroll,
                bottom: 462 - scroll,
                width: 100,
                height: 44,
              },
            },
          ],
        },
        {
          id: "second",
          prompts: ["expected"],
          actions: [
            {
              rect: {
                top: 737 - scroll,
                bottom: 781 - scroll,
                width: 100,
                height: 44,
              },
            },
          ],
        },
      ],
    };
  };
  const context = {
    assert,
    structuredClone,
    result,
    nativeTheme,
    informationOverflowMetrics: function () {},
    informationReachabilityMetrics: function () {},
    evaluate: async (expression) =>
      expression.startsWith("(()=>")
        ? snapshot()
        : expression.includes("==='dark'")
          ? theme === "dark"
          : theme === "light",
    until: async (read, label) => {
      assert.ok(await read(), label);
    },
    pause: async () => {},
    screenshot: async (name) => images.push(name),
    window: {
      webContents: {
        sendInputEvent: () =>
          assert.fail(
            "wrapper cannot issue native input outside the existing probe",
          ),
      },
    },
    verifyInformationOverflowCue: async (input) => {
      helperCalls++;
      assert.equal(input.darkPartial, true);
      assert.equal(input.expectedSecondPrompt, "expected");
      if (options.helperFailure) throw Error("synthetic native probe failure");
      const before = await input.read();
      if (options.darkFocusChange) before.active = { id: "native-dark-focus" };
      if (options.darkTextMetrics) before.questions[0].measuredTextWidth = 125;
      const receipt = {
        name: "desktop-split-information-overflow-cue-dark-partial",
        before,
        restored: structuredClone(before),
      };
      result.cases.push(receipt);
      await input.screenshot("03c-overflow-cue-initial.png");
      await input.screenshot("03d-overflow-cue-partial.png");
    },
  };
  vm.runInNewContext(
    code + ";globalThis.verify=verifyInformationDarkSplitCue;",
    context,
  );
  return {
    result,
    changes,
    images,
    count: () => helperCalls,
    verify: () => context.verify("expected"),
  };
}

test("dark wrapper uses two uniquely named frames, restores original light scene, and writes no preference", async () => {
  const f = run();
  await f.verify();
  assert.deepEqual(f.changes, ["dark", "light"]);
  assert.deepEqual(f.images, [
    "03g-overflow-cue-dark-initial.png",
    "03h-overflow-cue-dark-partial.png",
  ]);
  assert.equal(f.count(), 1);
  assert.equal(f.result.informationDarkCueTransition.status, "passed");
  assert.match(
    f.result.informationDarkCueTransition.scene,
    /after existing Stage1; not a fresh open/,
  );
});
test("native dark focus difference is recorded, not corrected or called a fresh open", async () => {
  const f = run({ darkFocusChange: true });
  await f.verify();
  assert.equal(
    f.result.informationDarkCueTransition.darkStartFocus.id,
    "native-dark-focus",
  );
  assert.equal(
    f.result.informationDarkCueTransition.restored.active.id,
    "original",
  );
});
test("theme-specific text measurements are not forced equal across light and dark", async () => {
  const f = run({ darkTextMetrics: true });
  await f.verify();
  assert.equal(f.result.informationDarkCueTransition.status, "passed");
});
test("wrong native dark state fails with diagnostic, without corrective fallback", async () => {
  const f = run({ wrongNativeDark: true });
  await assert.rejects(f.verify());
  assert.equal(f.result.informationDarkCueTransition.status, "failed");
  assert.equal(f.count(), 0);
  assert.deepEqual(f.changes, ["dark"]);
});
test("failed native dark probe does not rerun or pretend restoration passed", async () => {
  const f = run({ helperFailure: true });
  await assert.rejects(f.verify(), /native probe failure/);
  assert.equal(f.result.informationDarkCueTransition.status, "failed");
  assert.equal(f.count(), 1);
  assert.deepEqual(f.changes, ["dark"]);
});
test("restored focus drift fails without focusing another control", async () => {
  const f = run({ restoreFocusChange: true });
  await assert.rejects(f.verify(), /focus descriptor/);
  assert.equal(f.result.informationDarkCueTransition.status, "failed");
  assert.equal(
    f.result.informationDarkCueTransition.restored.active.id,
    "different",
  );
});
test("source guards keep the new call after unchanged Stage1 and add no settings or response calls", () => {
  const stage1 = source.indexOf(
    "await measureInformationOverlayReachability(revealPrompt)",
  );
  const dark = source.indexOf(
    "await verifyInformationDarkSplitCue(revealPrompt)",
  );
  assert.ok(
    stage1 < dark && dark < source.indexOf('keyCode: "Escape"', stage1),
  );
  assert.doesNotMatch(
    code,
    /localStorage|zenx\.preferences|questions\/respond|\.focus\(|scrollIntoView|scrollTop\s*=|resizeWindow|Emulation\./,
  );
  assert.match(code, /matchMedia\('\(forced-colors: active\)'\)\.matches/);
  assert.match(code, /computedCueColors/);
  assert.match(code, /popoverBackground/);
});

test("restored light comparison waits for bounded stable observations, not one fixed delay", async () => {
  const f = run({ lateRestoredLayout: true });
  await f.verify();
  assert.equal(f.result.informationDarkCueTransition.status, "passed");
  assert.equal(
    f.result.informationDarkCueTransition.restored.layoutSettled,
    true,
  );
});

test("only legal fractional inner-scroll-derived coordinates are normalized; raw evidence is retained", async () => {
  const f = run({ fractionalRestoration: true });
  await f.verify();
  const r = f.result.informationDarkCueTransition;
  assert.equal(r.before.panelScroll, 0.5);
  assert.equal(r.restored.panelScroll, 0);
  assert.equal(r.scrollNormalization.delta, -0.5);
  assert.equal(r.restored.questions[1].actions[0].rect.top, 737);
  const excessive = run({ fractionalRestoration: true, restoredScroll: 2 });
  await assert.rejects(excessive.verify(), /cleanup tolerance/);
  const unrelated = run({
    fractionalRestoration: true,
    restoreNonScrollDrift: true,
  });
  await assert.rejects(unrelated.verify(), /only <=1px/);
});
