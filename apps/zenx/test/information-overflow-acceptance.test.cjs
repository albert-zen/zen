const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  verifyInformationOverflowCue,
  informationOverflowMetrics,
} = require("../scripts/information-overflow-acceptance.cjs");

const rect = (left = 0, top = 0, width = 100, height = 40) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});
function fixture(options = {}) {
  let scroll = options.initialScroll ?? 0,
    reads = 0,
    wheelCount = 0,
    readsSinceWheel = 0;
  const maximum = options.maximum ?? 1084;
  const events = [],
    images = [],
    result = { cases: [] };
  const read = async () => {
    reads++;
    readsSinceWheel++;
    scroll =
      options.readScroll?.({
        scroll,
        maximum,
        reads,
        wheelCount,
        readsSinceWheel,
      }) ?? scroll;
    const hidden = maximum - scroll <= 1;
    const snapshot = {
      viewport: { width: 1600, height: 970, dpr: 1 },
      resource: { open: "true", expanded: "false", primaryActive: "false" },
      overlayCount: 1,
      dockCount: 0,
      ownerKey: "thread:synthetic",
      panel: rect(700, 100, 360, 676),
      popover: rect(700, 58, 360, 718),
      toolbar: rect(700, 58, 360, 42),
      composer: rect(300, 850, 700, 36),
      toggle: rect(1020, 4, 36, 36),
      dismiss: rect(910, 64, 135, 36),
      transcript: rect(300, 40, 700, 750),
      transcriptScroll: 1314,
      composerDraft: "Synthetic retained draft",
      active: { tag: "BUTTON", id: "close" },
      clientHeight: 676,
      scrollHeight: 676 + maximum,
      panelMax: maximum,
      panelScroll: scroll,
      remaining: maximum - scroll,
      owned: true,
      point: { x: 706, y: 269 + scroll / 100 },
      closeHit: true,
      questions: [
        {
          id: "first",
          prompts: ["sibling"],
          actions: [
            {
              text: "Send answers",
              type: "button",
              answerAction: true,
              disabled: false,
              focused: false,
            },
          ],
        },
        {
          id: "second",
          prompts: ["expected"],
          actions: [
            {
              text: "Send answers",
              type: "button",
              answerAction: true,
              disabled: false,
              focused: false,
            },
          ],
        },
      ],
      cue: {
        hidden,
        display: hidden ? "none" : "inline-flex",
        visibility: "visible",
        pointerEvents: "none",
        text: "More below",
        rect: hidden ? rect(0, 0, 0, 0) : rect(714, 64, 90, 36),
        ariaHidden: "true",
        tabIndex: -1,
        interactiveCount: 0,
        ownsPointer: false,
      },
      lastVisibleContent: {
        tag: "BUTTON",
        text: "Synthetic provider customization",
        rect: rect(800, 730, 180, 36),
      },
    };
    if (options.darkPartial)
      Object.assign(snapshot, {
        appearance: "dark",
        prefersDark: true,
        forcedColorsActive: false,
      });
    options.mutate?.(snapshot, {
      scroll,
      maximum,
      reads,
      wheelCount,
      readsSinceWheel,
    });
    return snapshot;
  };
  const sendInput = (event) => {
    events.push(event);
    if (event.type === "mouseWheel") {
      wheelCount++;
      readsSinceWheel = 0;
    }
    if (event.type === "mouseWheel" && !options.noProgress) {
      assert.ok(
        event.deltaY < 0 ? scroll < maximum : scroll > 0,
        "no extra wheel at edge",
      );
      scroll = Math.max(0, Math.min(maximum, scroll - event.deltaY));
    }
  };
  return {
    events,
    images,
    result,
    run: () =>
      verifyInformationOverflowCue({
        read,
        sendInput,
        pause: async () => {},
        screenshot: async (name) => images.push(name),
        result,
        expectedSecondPrompt: "expected",
        darkPartial: options.darkPartial,
      }),
  };
}

test("real-wheel-only journey keeps cue through partial scroll, hides at bottom, returns upward and restores", async () => {
  for (const maximum of [1084, 1099]) {
    const f = fixture({ maximum });
    await f.run();
    const receipt = f.result.cases[0];
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.before.panelScroll, 0);
    assert.equal(
      receipt.samples.find((s) => s.label === "partial").sample.panelScroll,
      360,
    );
    assert.equal(
      receipt.samples.find((s) => s.label === "partial").sample.cue.hidden,
      false,
    );
    assert.equal(receipt.bottom.panelScroll, maximum);
    assert.equal(receipt.bottom.cue.hidden, true);
    assert.equal(receipt.restored.panelScroll, 0);
    assert.equal(receipt.restored.cue.hidden, false);
    assert.deepEqual(f.images, [
      "03c-overflow-cue-initial.png",
      "03d-overflow-cue-partial.png",
      "03e-overflow-cue-bottom.png",
      "03f-overflow-cue-up.png",
    ]);
    assert.ok(
      f.events.every((e) => e.type === "mouseMove" || e.type === "mouseWheel"),
    );
    assert.ok(receipt.wheels.every((e) => Math.abs(e.deltaY) <= 360));
    assert.ok(
      new Set(receipt.wheels.map((e) => e.point.y)).size > 1,
      "fresh safe point is used after scroll, not old screenshot coordinates",
    );
  }
});

for (const [name, mutate, pattern] of [
  [
    "missing product cue",
    (s) => {
      s.cue = null;
    },
    /noninteractive/,
  ],
  [
    "cue hidden despite remaining content",
    (s) => {
      s.cue.hidden = true;
    },
    /follows actual/,
  ],
  [
    "cue with Tab stop",
    (s) => {
      s.cue.tabIndex = 0;
    },
    /noninteractive/,
  ],
  [
    "cue captures pointer",
    (s) => {
      s.cue.ownsPointer = true;
    },
    /noninteractive/,
  ],
  [
    "cue overlaps Close",
    (s) => {
      s.cue.rect = rect(950, 64, 90, 36);
    },
    /overlap Close/,
  ],
  [
    "cue exceeds toolbar",
    (s) => {
      s.cue.rect = rect(714, 40, 90, 36);
    },
    /inside existing toolbar/,
  ],
  [
    "not desktop split",
    (s) => {
      s.resource.expanded = "true";
    },
    /non-expanded/,
  ],
  [
    "narrow scene",
    (s) => {
      s.viewport.width = 900;
    },
    /not a narrow/,
  ],
  [
    "missing actual Composer",
    (s) => {
      s.composer = null;
    },
    /real geometry/,
  ],
  [
    "unowned wheel point",
    (s) => {
      s.owned = false;
    },
    /fresh owned/,
  ],
  [
    "Close hit fails",
    (s) => {
      s.closeHit = false;
    },
    /hit-testable/,
  ],
])
  test(`fail closed: ${name}`, async () => {
    const f = fixture({ mutate });
    await assert.rejects(f.run(), pattern);
    assert.equal(f.result.cases[0].status, "failed");
    assert.equal(f.events.length, 0);
  });

for (const [name, mutate, pattern] of [
  [
    "transcript drift",
    (s, c) => {
      if (c.scroll) s.transcriptScroll++;
    },
    /transcriptScroll unchanged/,
  ],
  [
    "Close squeezed",
    (s, c) => {
      if (c.scroll) s.dismiss.width--;
    },
    /dismiss unchanged/,
  ],
  [
    "Composer draft changed",
    (s, c) => {
      if (c.scroll) s.composerDraft += "changed";
    },
    /composerDraft unchanged/,
  ],
  [
    "scroll owner replaced",
    (s, c) => {
      if (c.scroll) s.ownerKey = "other";
    },
    /ownerKey unchanged/,
  ],
  [
    "pending question replaced",
    (s, c) => {
      if (c.scroll) s.questions[1].id = "other";
    },
    /pending questions and action state unchanged/,
  ],
  [
    "pending answer disabled state changes",
    (s, c) => {
      if (c.scroll) s.questions[1].actions[0].disabled = true;
    },
    /action state unchanged/,
  ],
  [
    "focus changed by wheel",
    (s, c) => {
      if (c.scroll) s.active.id = "other";
    },
    /active unchanged/,
  ],
  [
    "cue falsely visible at actual bottom",
    (s, c) => {
      if (c.scroll === c.maximum) s.cue.hidden = false;
    },
    /follows actual/,
  ],
  [
    "hidden cue still occupies box",
    (s, c) => {
      if (c.scroll === c.maximum) s.cue.rect.width = 1;
    },
    /no layout box/,
  ],
  [
    "bottom has no observed provider content",
    (s, c) => {
      if (c.scroll === c.maximum) s.lastVisibleContent = null;
    },
    /visible provider content/,
  ],
])
  test(`fail closed after native input: ${name}`, async () => {
    const f = fixture({ mutate });
    await assert.rejects(f.run(), pattern);
    assert.equal(f.result.cases[0].status, "failed");
    assert.ok(f.events.length > 0);
    assert.ok(
      f.result.cases[0].samples.length > 0,
      "failure retains real sampled state",
    );
  });

test("no progress fails without retrying wheel; excessive content exceeds fixed journey bound", async () => {
  const stuck = fixture({ noProgress: true });
  await assert.rejects(stuck.run(), /made progress/);
  assert.equal(stuck.events.filter((e) => e.type === "mouseWheel").length, 1);
  const long = fixture({ maximum: 5000 });
  await assert.rejects(long.run(), /actually reaches bottom/);
  assert.equal(long.events.filter((e) => e.type === "mouseWheel").length, 9);
});

test("losing every safe point at bottom retains bottom evidence and never falls back outside the panel", async () => {
  const f = fixture({
    mutate: (s, c) => {
      if (c.scroll === c.maximum) {
        s.owned = false;
        s.point = null;
      }
    },
  });
  await assert.rejects(f.run(), /up-from-bottom: fresh owned/);
  assert.equal(f.result.cases[0].status, "failed");
  assert.equal(f.result.cases[0].bottom.remaining, 0);
  assert.ok(f.images.includes("03e-overflow-cue-bottom.png"));
  assert.ok(!f.images.includes("03f-overflow-cue-up.png"));
  assert.ok(
    f.events.filter((e) => e.type === "mouseWheel").every((e) => e.deltaY < 0),
  );
});

test("no false no-overflow coverage; observer stays read-only; insertion precedes unchanged Stage1", async () => {
  const fits = fixture({ maximum: 0 });
  await assert.rejects(fits.run(), /overflowing viewport/);
  assert.equal(fits.events.length, 0);
  const observer = informationOverflowMetrics.toString();
  assert.doesNotMatch(
    observer,
    /(?:scrollTop|value|textContent)\s*=|\.focus\(|scrollIntoView|dispatchEvent|\.click\(/,
  );
  const source = fs.readFileSync(
    require.resolve("../scripts/capture-information-board.cjs"),
    "utf8",
  );
  const start = source.indexOf(
    'await capture("03-workspace-reopen-overlay", "overlay")',
  );
  const cue = source.indexOf("await verifyInformationOverflowCue({", start);
  const stage1 = source.indexOf(
    "await measureInformationOverlayReachability(revealPrompt)",
    start,
  );
  assert.ok(start < cue && cue < stage1);
  assert.match(source, /assert\.equal\(process\.env\.GITHUB_ACTIONS, "true"\)/);
  assert.match(source, /a === "--no-sandbox"/);
});

test("dark same-overlay variant adds only partial native wheel and restoration, with separate scope", async () => {
  const f = fixture({ darkPartial: true });
  await f.run();
  const r = f.result.cases[0];
  assert.equal(r.name, "desktop-split-information-overflow-cue-dark-partial");
  assert.match(r.darkScope, /not fresh open/);
  assert.match(r.forcedColorsScope, /not changed or tested/);
  assert.equal(r.before.appearance, "dark");
  assert.equal(r.restored.panelScroll, 0);
  assert.equal(r.bottom, undefined);
  assert.deepEqual(
    f.events.filter((e) => e.type === "mouseWheel").map((e) => e.deltaY),
    [-360, 360],
  );
  assert.deepEqual(f.images, [
    "03c-overflow-cue-initial.png",
    "03d-overflow-cue-partial.png",
  ]);
});
for (const [name, mutate, pattern] of [
  [
    "wrong actual appearance",
    (s) => (s.appearance = "light"),
    /actual production dark/,
  ],
  ["wrong native media", (s) => (s.prefersDark = false), /actual native dark/],
  [
    "missing forced-colors observation",
    (s) => delete s.forcedColorsActive,
    /observation is explicit/,
  ],
  [
    "cue hides after partial dark scroll",
    (s, c) => {
      if (c.scroll) s.cue.hidden = true;
    },
    /follows actual/,
  ],
])
  test(`dark variant fails closed: ${name}`, async () => {
    const f = fixture({ darkPartial: true, mutate });
    await assert.rejects(f.run(), pattern);
    assert.equal(f.result.cases[0].status, "failed");
  });
test("observed forced-colors active is labeled, not toggled or claimed as a tested setting", async () => {
  const f = fixture({
    darkPartial: true,
    mutate: (s) => (s.forcedColorsActive = true),
  });
  await f.run();
  const r = f.result.cases[0];
  assert.equal(r.before.forcedColorsActive, true);
  assert.match(r.forcedColorsScope, /not changed or tested/);
});

test("dark starts at the exact fractional Stage1-restored position; original light still requires zero", async () => {
  const dark = fixture({ darkPartial: true, initialScroll: 0.5 });
  await dark.run();
  assert.equal(dark.result.cases[0].before.panelScroll, 0.5);
  assert.equal(dark.result.cases[0].restored.panelScroll, 0.5);
  const light = fixture({ initialScroll: 0.5 });
  await assert.rejects(light.run(), /from the top/);
  const outside = fixture({ darkPartial: true, initialScroll: 1.01 });
  await assert.rejects(outside.run(), /from the top/);
});

test("dark restoration tolerates observed360 to312 then fresh0 without another input", async () => {
  const f = fixture({
    darkPartial: true,
    readScroll: ({ scroll, wheelCount, readsSinceWheel }) =>
      wheelCount === 2 ? (readsSinceWheel <= 3 ? 312 : 0) : scroll,
  });
  await f.run();
  const r = f.result.cases[0];
  assert.equal(
    r.samples.find((s) => s.label === "restore-1").sample.panelScroll,
    312,
  );
  assert.equal(
    r.samples.find((s) => s.label === "restore-2-before").sample.panelScroll,
    0,
  );
  assert.deepEqual(
    r.noInput.map((x) => ({ label: x.label, reason: x.reason, from: x.from })),
    [{ label: "restore-2", reason: "already-at-target", from: 0 }],
  );
  assert.deepEqual(
    f.events.map((e) => e.type),
    ["mouseMove", "mouseWheel", "mouseMove", "mouseWheel"],
  );
  assert.deepEqual(
    r.wheels.map((x) => x.deltaY),
    [-360, 360],
  );
  assert.equal(r.restored.panelScroll, 0);
});

for (const fresh of [1084, 1080])
  test(`forward bottom goal rechecks stale360 against fresh${fresh}`, async () => {
    const f = fixture({
      readScroll: ({ scroll, wheelCount, readsSinceWheel }) =>
        wheelCount === 1 && readsSinceWheel >= 4 ? fresh : scroll,
    });
    await f.run();
    const r = f.result.cases[0];
    assert.equal(
      r.samples.find((s) => s.label === "partial").sample.panelScroll,
      360,
    );
    assert.equal(
      r.samples.find((s) => s.label === "bottom-1-before").sample.panelScroll,
      fresh,
    );
    if (fresh === 1084) {
      assert.ok(
        r.noInput.some(
          (x) => x.label === "bottom-1" && x.reason === "already-at-target",
        ),
      );
      assert.ok(!r.wheels.some((x) => x.label === "bottom-1"));
    } else
      assert.equal(r.wheels.find((x) => x.label === "bottom-1").deltaY, -4);
    assert.equal(r.bottom.panelScroll, 1084);
    assert.equal(r.restored.panelScroll, 0);
  });

for (const fresh of [1, 1.01])
  test(`fresh restoration uses original1px bound at${fresh}`, async () => {
    const f = fixture({
      darkPartial: true,
      readScroll: ({ scroll, wheelCount, readsSinceWheel }) =>
        wheelCount === 2 ? (readsSinceWheel <= 3 ? 312 : fresh) : scroll,
    });
    await f.run();
    const r = f.result.cases[0];
    if (fresh === 1) {
      assert.ok(r.noInput.some((x) => x.label === "restore-2"));
      assert.equal(r.wheels.length, 2);
    } else {
      assert.equal(r.wheels.find((x) => x.label === "restore-2").deltaY, 1.01);
      assert.equal(r.restored.panelScroll, 0);
    }
  });

test("fresh reached goal cannot bypass changed owner invariant", async () => {
  const f = fixture({
    darkPartial: true,
    readScroll: ({ scroll, wheelCount, readsSinceWheel }) =>
      wheelCount === 2 ? (readsSinceWheel <= 3 ? 312 : 0) : scroll,
    mutate: (s, c) => {
      if (c.wheelCount === 2 && c.readsSinceWheel >= 4) s.ownerKey = "replaced";
    },
  });
  await assert.rejects(f.run(), /ownerKey unchanged/);
  assert.equal(f.events.filter((e) => e.type === "mouseWheel").length, 2);
  assert.equal(f.result.cases[0].noInput.length, 0);
});
