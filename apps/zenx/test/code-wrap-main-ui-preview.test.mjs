import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  captureCodeWrap,
  probeCodeKeyboard,
  probeTableKeyboard,
  verifyCodeWrap,
} from "../scripts/code-wrap-main-ui-preview.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const fixtureSource = await read("./fixtures/code-wrap-content.ts");
const fixture = await import(
  `data:text/javascript;base64,${Buffer.from(fixtureSource).toString("base64")}`
);
const state = (wrapped = false) => ({
  text: fixture.codeWrapText,
  expected: fixture.codeWrapText,
  clipboardKind: "synthetic-clipboard-only",
  clipboardWrites: [],
  wrapAvailable: true,
  wrapped,
  frameWrapped: String(wrapped),
  proseLineHeight: "27px",
  horizontalPageOverflow: false,
  pre: { x: 100, right: 900, y: 200, height: 200 },
  frame: { bottom: 450 },
  composer: { y: 774 },
  viewportWidth: 1280,
  scrollWidth: wrapped ? 800 : 2300,
  clientWidth: 800,
  wrapFocused: false,
  wrapFocusVisible: false,
});

test("fixture includes long English/Chinese, unbroken token and source whitespace", () => {
  const lines = fixture.codeWrapText.split("\n");
  assert.equal(lines.length, 3);
  assert(lines[0].length > 180);
  assert.match(lines[1], /中文说明/);
  assert.match(lines[2], /^\t/);
  assert.match(lines[2], /(?:SyntheticToken_){14}/);
  assert(fixture.codeWrapMarkdown.includes(fixture.codeWrapText));
});

test("browser assertions reject clipping, rewritten text, missing focus and changed clipboard", () => {
  verifyCodeWrap(state(), { wrapped: false });
  const s = state(true);
  s.wrapFocused = s.wrapFocusVisible = true;
  s.clipboardWrites = [s.expected];
  verifyCodeWrap(s, { wrapped: true, focus: true, copied: true });
  for (const mutation of [
    (s) => {
      s.text += "changed";
    },
    (s) => {
      s.scrollWidth = 1500;
    },
    (s) => {
      s.frame.bottom = 900;
    },
    (s) => {
      s.wrapFocusVisible = false;
    },
    (s) => {
      s.clipboardWrites = ["truncated"];
    },
    (s) => {
      s.proseLineHeight = "24.75px";
    },
  ]) {
    const bad = structuredClone(s);
    mutation(bad);
    assert.throws(() =>
      verifyCodeWrap(bad, { wrapped: true, focus: true, copied: true }),
    );
  }
});

test("baseline records a nonfatal keyboard probe then restores default and horizontal-wheel states", async () => {
  const calls = [],
    steps = [],
    evidence = {};
  const s = { ...state(), wrapAvailable: false, frameWrapped: null };
  await captureCodeWrap({
    send: async (...args) => {
      calls.push(args);
    },
    evaluate: async (source) =>
      /observe(?:Code|Table)Keyboard/.test(source)
        ? { activeId: 1, preFocused: false }
        : s,
    wait: async () => {},
    click: async () => {},
    scrollToTop: async () => {},
    capture: async (name) => steps.push(name),
    evidence,
    options: { theme: "light", name: "desktop-light" },
    url: "http://127.0.0.1/reading.html?scene=reading",
  });
  assert.deepEqual(steps, [
    "reading-desktop-light-table-keyboard-plain",
    "reading-desktop-light-table-keyboard-links",
    "reading-desktop-light-table-keyboard-fit",
    "reading-desktop-light-code-keyboard-scroll-probe",
    "reading-desktop-light-code-long-unwrapped",
    "reading-desktop-light-code-horizontal-scroll",
  ]);
  assert(
    calls.some(
      ([method, p]) =>
        method === "Input.dispatchMouseEvent" &&
        p.type === "mouseWheel" &&
        p.deltaX === 500,
    ),
  );
  assert(calls.some(([method]) => method === "Input.dispatchKeyEvent"));
  assert.equal(
    calls.filter(([method]) => method === "Page.navigate").length,
    5,
  );
  assert.equal(evidence.codeKeyboardCases[0].outcome, "tab-cycle-without-pre");
  assert.equal(evidence.codeWrapCases.length, 2);
});

test("capture uses native keyboard paths and receipt hashes the new helper", async () => {
  const capture = await read("../scripts/code-wrap-main-ui-preview.mjs");
  const build = await read("../scripts/build-main-ui-preview.mjs");
  assert.match(capture, /key\("Enter", "Enter", 13\)/);
  assert.match(capture, /key\(" ", "Space", 32\)/);
  assert.doesNotMatch(capture, /\.click\(\)|dispatchEvent|\.focus\(\)/);
  for (const file of ["code-wrap-main-ui-preview.mjs", "code-wrap-content.ts"])
    assert(build.includes(file));
  const host = await read("./fixtures/ui-polish-visual.tsx");
  assert.match(host, /readingScene && params.get\("codeWrap"\) === "1"/);
  assert.match(
    host,
    /codeWrapScene \? codeWrapMarkdown : tableKeyboardMarkdown/,
  );
  assert.match(host, /synthetic-clipboard-only/);
});

test("native pre probe distinguishes no entry, no scroll and successful scroll without asserting away failures", async () => {
  const run = async (states) => {
    let index = 0;
    const calls = [],
      evidence = {},
      reads = [];
    const result = await probeCodeKeyboard({
      send: async (...args) => calls.push(args),
      evaluate: async (source) => {
        reads.push(source);
        return source.includes("observeCodeKeyboard")
          ? states[Math.min(index++, states.length - 1)]
          : true;
      },
      capture: async () => {},
      evidence,
      options: { theme: "dark", name: "desktop-dark" },
    });
    assert.equal(reads.at(-1), "delete window.__zenCodeKeyboardProbe");
    assert.equal(evidence.codeKeyboardCases[0], result);
    return { result, calls };
  };
  const ordinary = (activeId) => ({
    activeId,
    activeClass: "same-button-class",
    preFocused: false,
  });
  const cycle = await run([ordinary(1), ordinary(2), ordinary(1)]);
  assert.equal(cycle.result.outcome, "tab-cycle-without-pre");
  assert.equal(cycle.result.observations.length, 3);
  const focused = {
    activeId: 3,
    preFocused: true,
    focusVisible: true,
    scrollLeft: 0,
  };
  assert.equal(
    (await run([ordinary(1), focused, { ...focused, scrollLeft: 40 }])).result
      .outcome,
    "reached-and-scrolled",
  );
  assert.equal(
    (await run([focused, focused])).result.outcome,
    "reached-no-scroll",
  );
  const limit = await run(Array.from({ length: 61 }, (_, i) => ordinary(i)));
  assert.equal(limit.result.outcome, "tab-limit");
  assert.equal(limit.result.observations.length, 61);
  assert.equal(
    limit.calls.filter(
      ([method, p]) =>
        method === "Input.dispatchKeyEvent" && p.type === "rawKeyDown",
    ).length,
    60,
  );
});

test("table keyboard probe distinguishes link scrolling, wrapper scrolling, failure and fitting control", async () => {
  const run = async (states) => {
    let i = 0;
    const calls = [],
      evidence = {},
      reads = [];
    const result = await probeTableKeyboard({
      send: async (...args) => calls.push(args),
      evaluate: async (source) => {
        reads.push(source);
        return source.includes("observeTableKeyboard")
          ? states[Math.min(i++, states.length - 1)]
          : true;
      },
      capture: async () => {},
      evidence,
      options: { theme: "dark", name: "desktop-dark" },
      mode: "links",
    });
    assert.equal(reads.at(-1), "delete window.__zenTableKeyboardProbe");
    assert(!calls.some(([, p]) => p.key === "Enter"));
    assert.equal(evidence.tableKeyboardCases[0], result);
    return result;
  };
  const base = {
    activeId: 1,
    scrollWidth: 1300,
    clientWidth: 800,
    scrollLeft: 0,
  };
  const wrapper = { ...base, wrapperFocused: true, focusVisible: true };
  const link = { ...base, linkFocused: true, focusVisible: true };
  assert.equal(
    (await run([wrapper, { ...wrapper, scrollLeft: 40 }])).outcome,
    "wrapper-reached-and-scrolled",
  );
  assert.equal(
    (await run([link, { ...link, scrollLeft: 40 }])).outcome,
    "link-reached-and-scrolled",
  );
  assert.equal((await run([link, link, link])).outcome, "reachable-no-scroll");
  assert.equal(
    (await run([base, base])).outcome,
    "tab-cycle-without-table-stop",
  );
  const fit = { ...base, scrollWidth: 300 };
  assert.equal((await run([fit, fit])).outcome, "fits-without-table-stop");
});

test("table fixtures remain independent and restore the original code scene through navigation", async () => {
  const host = await read("./fixtures/ui-polish-visual.tsx");
  const capture = await read("../scripts/code-wrap-main-ui-preview.mjs");
  assert.match(host, /readingScene && !codeWrapScene && !resultScene/);
  assert.match(
    host,
    /codeWrapScene \? codeWrapMarkdown : tableKeyboardMarkdown/,
  );
  assert.match(host, /tableKeyboardMode === "fit" \? 2 : 16/);
  assert.match(host, /https:\/\/example.com/);
  assert.match(capture, /target.searchParams.delete\("tableKeyboard"\)/);
  assert.doesNotMatch(
    capture,
    /\.focus\(|\.scrollLeft\s*=|setAttribute\("tabindex"/,
  );
});

test("table query generator preserves old scenes and distinguishes only the intended link content", async () => {
  const host = await read("./fixtures/ui-polish-visual.tsx");
  const source = host.slice(
    host.indexOf("const tableKeyboardMode"),
    host.indexOf("// This opt-in synthetic probe"),
  );
  const generate = new Function(
    "readingScene",
    "codeWrapScene",
    "resultScene",
    "params",
    source + "\nreturn tableKeyboardMarkdown;",
  );
  const mode = (value, code = false, results = false) =>
    generate(
      true,
      code,
      results,
      new URLSearchParams(value ? { tableKeyboard: value } : {}),
    );
  assert.equal(mode(null), undefined);
  assert.equal(mode("unknown"), undefined);
  assert.equal(mode("links", true), undefined);
  assert.equal(mode("links", false, true), undefined);
  const plain = mode("plain"),
    links = mode("links"),
    fit = mode("fit");
  assert.equal(
    links.replace(/\[([^\]]+)\]\(https:\/\/example.com\/\)/g, "$1"),
    plain,
  );
  assert.equal((links.match(/https:\/\/example.com/g) ?? []).length, 8);
  assert.equal(plain.split("\n")[2].split("|").length - 2, 16);
  assert.equal(fit.split("\n")[2].split("|").length - 2, 2);
});
