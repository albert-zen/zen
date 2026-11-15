import assert from "node:assert/strict";
import test from "node:test";
import {
  sidebarIdentityCases,
  sidebarIdentityCase,
} from "../scripts/sidebar-identity-cases.mjs";
import {
  captureCombinedAttention,
  verifyCombinedAttention,
  navigationDraft,
} from "../scripts/navigation-main-ui-preview.mjs";
const scopes = ["project-group", "recent-thread-group"];
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
    await captureCombinedAttention({
      options: {
        identityCase,
        lang: c.lang,
        theme: "light",
        name: identityCase,
      },
      evidence: {},
      evaluate: async (source) =>
        source.includes("fonts.ready")
          ? void 0
          : state(identityCase, focus, menu),
      wait: async () => {},
      click: async () => {},
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
  for (const fault of ["owner", "return"]) {
    let focus = "",
      menu = false,
      opened = false;
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
        capture: async () => {},
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
