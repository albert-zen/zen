import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  sidebarIdentityCases,
  sidebarIdentityCase,
} from "../scripts/sidebar-identity-cases.mjs";
import {
  captureCombinedAttention,
  observeCombinedAttention,
  combinedPaneOwned,
  verifyCombinedAttention,
  navigationDraft,
} from "../scripts/navigation-main-ui-preview.mjs";
const scopes = ["project-group", "recent-thread-group"];
// Structural DOM only: mirrors exact e3ad shell > row + status rail > trigger.
// Rectangles below are synthetic; never substitute this for hosted pixel proof.
function sidebarDOM() {
  const dom = new JSDOM(
    `<div class="app-shell"><aside class="sidebar">${scopes.map((scope) => `<section class="${scope}">${["design-child", "test-child"].map((id) => `<span class="thread-row-shell" data-thread-id="${id}"><button class="thread-row"><span class="thread-title"><span>${id}</span></span></button><span class="thread-status-rail"><button id="thread-menu-trigger-${scope}-${id}" class="thread-menu-trigger"></button></span></span>`).join("")}</section>`).join("")}</aside></div>`,
    { runScripts: "outside-only" },
  );
  return dom;
}
function state(name, focus = "", menu = false) {
  const c = sidebarIdentityCase(name);
  const zh = c.lang === "zh-CN";
  const box = (text) => ({
    text,
    visible: true,
    centerHit: true,
    disabled: false,
  });
  return {
    viewport: { width: 1280, height: 900 },
    theme: "light",
    fixture: {
      ...c,
      identityCase: name,
      scene: "approval-asking",
      approval: true,
      asking: true,
      openQuestionCount: 2,
      model: "model",
    },
    aliases: scopes.map((scope) => ({
      scope,
      row: {
        ...box(""),
        focused: focus === scope + ":first",
        focusVisible: true,
      },
      title: box(c.title),
      model: box("model"),
      child: box(zh ? "\u5B50\u4F1A\u8BDD" : "Child"),
      approval: box(
        zh ? "\u9700\u8981\u4F60\u7684\u5BA1\u6279" : "Needs your approval",
      ),
      asking: box(zh ? "\u5F85\u56DE\u7B54" : "Asking"),
      askingLabel: zh
        ? "2 \u7EC4\u95EE\u9898\u5F85\u56DE\u7B54"
        : "2 open question requests",
      menu: box(""),
      siblingTitle: box(c.siblingTitle),
      siblingRow: {
        ...box(""),
        focused: focus === scope + ":second",
        focusVisible: true,
      },
      siblingMenu: { ...box(""), focused: focus === scope + ":menu" },
      siblingMenuId: scope + ":menu",
    })),
    paneOwnership: {
      triggerId: focus.split(":")[0] + ":menu",
      expectedId: focus.split(":")[0] + ":pane",
      ownedId: focus.split(":")[0] + ":pane",
      labelledBy: focus.split(":")[0] + ":menu",
      controls: menu ? focus.split(":")[0] + ":pane" : null,
      kind: menu ? "menu" : "detail",
      visibleCount: 1,
    },
    composerCount: 1,
    composer: {
      rect: {
        x: 371,
        y: 774,
        width: 800,
        height: 108,
        right: 1171,
        bottom: 882,
      },
    },
    composerEditor: box(""),
    composerPrimary: box(""),
    draft: navigationDraft,
    selected: ["thread-1"],
    telemetry: { informationUpdates: 0, protocolCalls: [] },
    reveal: focus
      ? box(focus.endsWith(":first") ? c.title : c.siblingTitle)
      : null,
    pane: focus && !menu ? { visible: true, rect: { bottom: 766 } } : null,
    menuPanel: menu ? box("") : null,
    menuPanelCount: menu ? 1 : 0,
    menuPanelLabelledBy: menu ? focus : null,
    menuPanelFocusWithin: menu,
  };
}
test("fixed real Chinese and shared-tail cases are exact titles, not localized badge stand-ins", () => {
  assert.equal(Object.keys(sidebarIdentityCases).length, 4);
  for (const [key, c] of Object.entries(sidebarIdentityCases)) {
    assert.equal(c.lang, key.startsWith("zh-") ? "zh-CN" : "en");
    if (c.lang === "zh-CN")
      assert(
        /[\p{Script=Han}]/u.test(c.title) &&
          /[\p{Script=Han}]/u.test(c.siblingTitle),
      );
  }
  assert.throws(() => sidebarIdentityCase("arbitrary user input"));
});
test("both old display and current canonical/display aperture must retain exact scene identities", () => {
  for (const [identityCase, c] of Object.entries(sidebarIdentityCases)) {
    const options = { identityCase, lang: c.lang, theme: "light" };
    const good = state(identityCase);
    verifyCombinedAttention(good, options);
    for (const mutate of [
      (s) => (s.fixture.title = "invented"),
      (s) => (s.fixture.siblingTitle = "invented"),
      (s) => (s.aliases[1].siblingTitle.text = "invented"),
      (s) => (s.fixture.identityCase = "en-extension"),
      (s) => (s.draft = "changed"),
    ]) {
      const wrong = structuredClone(good);
      mutate(wrong);
      if (JSON.stringify(wrong) !== JSON.stringify(good))
        assert.throws(() => verifyCombinedAttention(wrong, options));
    }
    assert.throws(() =>
      verifyCombinedAttention(good, {
        ...options,
        lang: c.lang === "en" ? "zh-CN" : "en",
      }),
    );
  }
});
test("matrix journey reaches second sibling by Tab, opens only existing menu with Enter, dismisses to exact trigger", async () => {
  for (const [identityCase, c] of Object.entries(sidebarIdentityCases)) {
    let focus = "",
      menu = false;
    const captures = [];
    const events = [];
    const ownedSamples = new Map();
    const dom = sidebarDOM();
    await captureCombinedAttention({
      options: {
        identityCase,
        lang: c.lang,
        theme: "light",
        name: identityCase,
      },
      evidence: {},
      evaluate: async (source) => {
        if (source.includes("fonts.ready")) return;
        const value = state(identityCase, focus, menu);
        if (source.includes(')({"scope":')) {
          const count = (ownedSamples.get(focus) ?? 0) + 1;
          ownedSamples.set(focus, count);
          // The first two samples emulate a stale alias / overlapping pane.
          if (count === 1)
            value.paneOwnership.labelledBy = "recent-stale-trigger";
          if (count === 2) value.paneOwnership.visibleCount = 2;
        }
        return value;
      },
      wait: async () => {},
      click: async () => {},
      tabTo: async (selector) => {
        const target = dom.window.document.querySelector(
          selector.replace(":focus-visible", ""),
        );
        assert(
          target,
          `Native Tab target exists in actual nested row/rail contract: ${selector}`,
        );
        target.focus();
        assert(target.matches(":focus-visible"));
        const scope = scopes.find((s) => selector.includes(s));
        focus =
          scope +
          ":" +
          (selector.includes("test-child")
            ? selector.includes("menu-trigger")
              ? "menu"
              : "second"
            : "first");
        events.push("Tab " + focus);
        return true;
      },
      send: async (method, args) => {
        if (method !== "Input.dispatchKeyEvent") return;
        if (
          args.key === "Enter" &&
          (args.type === "keyDown" || args.type === "rawKeyDown")
        ) {
          assert(focus.endsWith(":menu"));
          menu = true;
          events.push("Enter menu");
        }
        if (args.key === "Escape" && args.type === "rawKeyDown") {
          events.push("Escape");
          if (menu) menu = false;
          else focus = "";
        }
      },
      capture: async (name) => {
        if (name.includes("second-sibling"))
          assert(
            (ownedSamples.get(focus) ?? 0) >= 6,
            "Transient owner never captured; four quiet samples required",
          );
        captures.push(name);
      },
    });
    assert.equal(captures.length, 7);
    assert.equal(events.filter((e) => e === "Enter menu").length, 2);
    assert.equal(
      events.filter((e) => e.startsWith("Tab") && e.endsWith(":second")).length,
      2,
    );
  }
});

test("native journey rejects another menu owner and lost Escape focus", async () => {
  for (const fault of [
    "owner",
    "return",
    "pane-owner",
    "pane-overlap",
    "after-screenshot",
  ]) {
    let focus = "",
      menu = false,
      opened = false,
      capturedDetail = false;
    await assert.rejects(
      captureCombinedAttention({
        options: {
          identityCase: "zh-extension",
          lang: "zh-CN",
          theme: "light",
          name: "negative",
        },
        evidence: {},
        evaluate: async (source) => {
          if (source.includes("fonts.ready")) return;
          const value = state("zh-extension", focus, menu);
          if (capturedDetail && fault === "after-screenshot")
            value.paneOwnership.labelledBy = "changed-after-capture";
          if (focus.endsWith(":second") && fault === "pane-owner")
            value.paneOwnership.labelledBy = "wrong-alias";
          if (focus.endsWith(":second") && fault === "pane-overlap")
            value.paneOwnership.visibleCount = 2;
          if (menu && fault === "owner")
            value.menuPanelLabelledBy = "unrelated-trigger";
          if (opened && !menu && fault === "return")
            value.aliases.forEach((alias) => {
              alias.siblingMenu.focused = false;
            });
          return value;
        },
        wait: async () => {},
        click: async () => {},
        capture: async (name) => {
          if (name.includes("second-sibling-detail")) capturedDetail = true;
        },
        tabTo: async (selector) => {
          const scope = scopes.find((s) => selector.includes(s));
          focus =
            scope +
            ":" +
            (selector.includes("test-child")
              ? selector.includes("menu-trigger")
                ? "menu"
                : "second"
              : "first");
          return true;
        },
        send: async (method, args) => {
          if (method !== "Input.dispatchKeyEvent") return;
          if (args.key === "Enter" && args.type === "keyDown") {
            menu = true;
            opened = true;
          }
          if (args.key === "Escape" && args.type === "rawKeyDown") {
            if (menu) menu = false;
            else focus = "";
          }
        },
      }),
    );
  }
});

test("owned-pane gate rejects matching title from another alias, overlap and wrong menu controls", () => {
  const good = state("zh-extension", "project-group:second");
  assert(combinedPaneOwned(good, false));
  for (const mutate of [
    (s) => (s.paneOwnership.ownedId = "recent-pane"),
    (s) => (s.paneOwnership.labelledBy = "recent-trigger"),
    (s) => (s.paneOwnership.visibleCount = 2),
    (s) => (s.paneOwnership.visibleCount = 0),
  ]) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.equal(combinedPaneOwned(bad, false), false);
  }
  const menu = state("zh-extension", "project-group:menu", true);
  assert(combinedPaneOwned(menu, true));
  menu.paneOwnership.controls = "other-pane";
  assert.equal(combinedPaneOwned(menu, true), false);
});

test("observer selects nested exact trigger and its owned Project/Recent detail/menu portal", () => {
  for (const scope of scopes)
    for (const menuOpen of [false, true]) {
      const dom = sidebarDOM(),
        w = dom.window,
        doc = w.document;
      const shell = `.sidebar .${scope} [data-thread-id="test-child"]`;
      assert.equal(
        doc.querySelector(`${shell} > .thread-menu-trigger`),
        null,
        "Old direct-child selector fails real DOM",
      );
      const trigger = doc.querySelector(
        `${shell} > .thread-status-rail > .thread-menu-trigger`,
      );
      assert(trigger);
      assert(
        doc.querySelector(`${shell} > .thread-row`),
        "Row itself is direct child",
      );
      const id = trigger.id.replace("thread-menu-trigger-", "thread-menu-");
      if (menuOpen) trigger.setAttribute("aria-controls", id);
      // Hidden stale portal contains unrelated facts and precedes the right one.
      doc.body.insertAdjacentHTML(
        "beforeend",
        `<div class="thread-information" style="visibility:hidden"><div class="thread-information-title"><span>stale title</span></div><dl data-thread-fact="wrong-alias"></dl></div><div id="${id}" aria-labelledby="${trigger.id}" class="${menuOpen ? "thread-item-menu" : "thread-information"}"><div class="thread-information-title"><span>owned title</span></div><dl data-thread-fact="owned"><dt>label</dt><dd>value</dd></dl><button>item</button></div>`,
      );
      for (const el of doc.querySelectorAll("*")) {
        el.style.opacity = "1";
        if (!el.style.visibility) el.style.visibility = "visible";
      }
      w.HTMLElement.prototype.getBoundingClientRect = () => ({
        x: 10,
        y: 10,
        right: 110,
        bottom: 30,
        width: 100,
        height: 20,
      });
      w.Range.prototype.getClientRects = () => [];
      doc.elementFromPoint = () => doc.body;
      w.__uiPolishTelemetry = {};
      w.__busyChildFixture = {};
      if (menuOpen) doc.getElementById(id).querySelector("button").focus();
      const actual = w.eval(
        `(${observeCombinedAttention.toString()})(${JSON.stringify({ scope, menuOpen })})`,
      );
      assert(combinedPaneOwned(actual, menuOpen));
      assert.equal(
        actual.aliases.find((a) => a.scope === scope).siblingMenuId,
        trigger.id,
      );
      assert(actual.aliases.find((a) => a.scope === scope).siblingMenu);
      assert.equal(actual.reveal.text, "owned title");
      assert.equal(actual.detailFacts.length, 1);
      assert.equal(actual.detailFacts[0].kind, "owned");
      if (menuOpen) {
        assert(actual.menuPanelFocusWithin);
        assert.equal(actual.menuPanelLabelledBy, trigger.id);
      }
      // A visible wrong alias must block readiness, even with identical title.
      const stale = doc.querySelector(".thread-information");
      if (stale.id !== id) stale.style.visibility = "visible";
      const overlap = w.eval(
        `(${observeCombinedAttention.toString()})(${JSON.stringify({ scope, menuOpen })})`,
      );
      assert.equal(combinedPaneOwned(overlap, menuOpen), false);
      dom.window.close();
    }
});
