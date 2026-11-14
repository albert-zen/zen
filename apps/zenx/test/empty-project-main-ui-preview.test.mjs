import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  verifyEmptyProjects,
  projectElementVisible,
} from "../scripts/empty-project-main-ui-preview.mjs";
const keys = ["zen", "design-system", "field-notes", "research", "delivery"];
const base = () => ({
  groups: keys.map((key) => ({
    key: "/work/" + key,
    expanded: true,
    toggle: { width: 200, height: 30 },
    threads:
      key === "zen"
        ? ["thread-1"]
        : key === "delivery"
          ? ["thread-delivery"]
          : [],
    visibleThreads:
      key === "zen"
        ? ["thread-1"]
        : key === "delivery"
          ? ["thread-delivery"]
          : [],
    disclosure: { open: "true", ariaHidden: "false", inert: false },
    inlineVisible: false,
    legacyVisible: !["zen", "delivery"].includes(key),
  })),
  pageOverflow: 0,
  composer: { bottom: 880 },
  viewport: { height: 900 },
});
test("baseline and candidate both explain expanded empties without changing nonempty groups", () => {
  verifyEmptyProjects(base());
  const s = base();
  for (const g of s.groups)
    if (g.legacyVisible) {
      g.legacyVisible = false;
      g.inlineVisible = true;
      g.inlineAriaHidden = "true";
    }
  verifyEmptyProjects(s);
  s.groups[0].inlineVisible = true;
  assert.throws(() => verifyEmptyProjects(s));
});
test("collapsed group must remove hint and restore correct threads on expansion", () => {
  const s = base();
  s.groups[1].expanded = false;
  s.groups[1].disclosure = { open: "false", ariaHidden: "true", inert: true };
  s.groups[1].legacyVisible = false;
  verifyEmptyProjects(s, { emptyOpen: false });
  s.groups[1].inlineVisible = true;
  assert.throws(() => verifyEmptyProjects(s, { emptyOpen: false }));
  const f = base();
  f.groups[4].expanded = false;
  f.groups[4].disclosure = { open: "false", ariaHidden: "true", inert: true };
  f.groups[4].visibleThreads = [];
  assert.deepEqual(
    f.groups[4].threads,
    ["thread-delivery"],
    "Collapsed DOM remains mounted",
  );
  verifyEmptyProjects(f, { filledOpen: false });
});
test("fixture opt-in contains long bilingual names and independent nonempty project; receipt includes helper", async () => {
  const f = await readFile(
    new URL("./fixtures/ui-polish-visual.tsx", import.meta.url),
    "utf8",
  );
  assert.match(f, /params.get\("emptyProjects"\) === "1"/);
  assert.match(f, /资料整理与跨项目设计审查参考记录/);
  assert.match(f, /thread-delivery/);
  assert.match(f, /pinnedProjectKeys/);
  const receipt = await readFile(
    new URL("../scripts/build-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  assert(receipt.includes("empty-project-main-ui-preview.mjs"));
  assert(receipt.includes("empty-project-main-ui-preview.test.mjs"));
});

test("actual retained DOM descendants honor inert and clipped ancestors", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    '<section><div class="project-disclosure"><div style="overflow:hidden"><p class="project-empty">No threads yet</p><div data-thread-id="thread-delivery">Delivery</div></div></div></section>',
  );
  const old = globalThis.getComputedStyle;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  try {
    const disclosure = dom.window.document.querySelector(".project-disclosure"),
      inner = disclosure.firstElementChild,
      paragraph = inner.firstElementChild;
    for (const e of dom.window.document.querySelectorAll("*"))
      e.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 30,
        width: 200,
        height: 30,
      });
    assert(projectElementVisible(paragraph));
    disclosure.setAttribute("inert", "");
    disclosure.setAttribute("aria-hidden", "true");
    assert(!projectElementVisible(paragraph));
    assert(
      dom.window.document.querySelector('[data-thread-id="thread-delivery"]'),
    );
    disclosure.removeAttribute("inert");
    disclosure.removeAttribute("aria-hidden");
    inner.style.overflowY = "hidden";
    inner.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 0,
      width: 200,
      height: 0,
    });
    assert(!projectElementVisible(paragraph));
  } finally {
    globalThis.getComputedStyle = old;
    dom.window.close();
  }
});
