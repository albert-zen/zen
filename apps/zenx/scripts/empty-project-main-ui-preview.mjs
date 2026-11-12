import assert from "node:assert/strict";
import { dispatchNavigationKey } from "./navigation-main-ui-preview.mjs";

export function projectElementVisible(element) {
  if (!element) return false;
  let r = element.getBoundingClientRect();
  let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      node.hidden ||
      node.hasAttribute("inert") ||
      (node !== element && node.getAttribute("aria-hidden") === "true") ||
      style.display === "none" ||
      style.visibility === "hidden"
    )
      return false;
    if (node !== element) {
      const clip = node.getBoundingClientRect();
      if (["hidden", "clip", "scroll", "auto"].includes(style.overflowX)) {
        box.left = Math.max(box.left, clip.left);
        box.right = Math.min(box.right, clip.right);
      }
      if (["hidden", "clip", "scroll", "auto"].includes(style.overflowY)) {
        box.top = Math.max(box.top, clip.top);
        box.bottom = Math.min(box.bottom, clip.bottom);
      }
    }
  }
  return box.right - box.left > 1 && box.bottom - box.top > 1;
}

export function observeEmptyProjects(visible = projectElementVisible) {
  const rect = (e) => {
    const r = e.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      right: r.right,
      bottom: r.bottom,
    };
  };
  const groups = [...document.querySelectorAll(".project-group")].map(
    (group) => {
      const toggle = group.querySelector(".project-toggle"),
        inline = group.querySelector(".project-empty-inline"),
        legacy = group.querySelector(".project-empty");
      return {
        key: group.getAttribute("data-project-key"),
        rect: rect(group),
        toggle: rect(toggle),
        name: toggle.querySelector("span")?.textContent,
        nameRect: toggle.querySelector("span")
          ? rect(toggle.querySelector("span"))
          : null,
        nameClientWidth: toggle.querySelector("span")?.clientWidth ?? null,
        nameScrollWidth: toggle.querySelector("span")?.scrollWidth ?? null,
        toggleText: toggle.textContent,
        expanded: toggle.getAttribute("aria-expanded") === "true",
        disclosure: (() => {
          const e = group.querySelector(".project-disclosure");
          return {
            open: e?.getAttribute("data-open"),
            ariaHidden: e?.getAttribute("aria-hidden"),
            inert: e?.hasAttribute("inert"),
            rect: e ? rect(e) : null,
          };
        })(),
        focused: document.activeElement === toggle,
        focusVisible: toggle.matches(":focus-visible"),
        inlineText: inline?.textContent ?? null,
        inlineRect: inline ? rect(inline) : null,
        visibleThreads: [...group.querySelectorAll("[data-thread-id]")]
          .filter(visible)
          .map((e) => e.getAttribute("data-thread-id")),
        inlineVisible: visible(inline),
        inlineAriaHidden: inline?.getAttribute("aria-hidden") ?? null,
        legacyText: legacy?.textContent ?? null,
        legacyVisible: visible(legacy),
        threads: [...group.querySelectorAll("[data-thread-id]")].map((e) =>
          e.getAttribute("data-thread-id"),
        ),
        actions: [...group.querySelectorAll(".project-actions button")].map(
          (e) => ({ label: e.getAttribute("aria-label"), rect: rect(e) }),
        ),
      };
    },
  );
  const composer = document.querySelector(".composer");
  const resizer = document.querySelector(".sidebar-resizer");
  return {
    groups,
    sidebarWidth: Number(resizer?.getAttribute("aria-valuenow")),
    sidebarMinWidth: Number(resizer?.getAttribute("aria-valuemin")),
    resizer: resizer ? rect(resizer) : null,
    composer: composer ? rect(composer) : null,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    selected: [
      ...document.querySelectorAll(".project-group .thread-row.selected"),
    ].map((e) => e.textContent),
    viewport: { width: innerWidth, height: innerHeight },
  };
}
export function verifyEmptyProjects(
  state,
  { emptyOpen = true, filledOpen = true } = {},
) {
  assert.equal(state.groups.length, 5);
  const group = (key) => state.groups.find((g) => g.key === key);
  assert.equal(group("/work/design-system").expanded, emptyOpen);
  assert.equal(group("/work/delivery").expanded, filledOpen);
  assert.equal(group("/work/zen").threads.includes("thread-1"), true);
  assert(
    group("/work/delivery").threads.includes("thread-delivery"),
    "Collapsed project retains thread identity in DOM",
  );
  assert.equal(
    group("/work/delivery").visibleThreads.includes("thread-delivery"),
    filledOpen,
  );
  for (const g of state.groups) {
    assert(g.toggle.width > 0 && g.toggle.height > 0);
    assert.equal(g.disclosure.open, String(g.expanded));
    assert.equal(g.disclosure.ariaHidden, String(!g.expanded));
    assert.equal(g.disclosure.inert, !g.expanded);
    if (["/work/zen", "/work/delivery"].includes(g.key))
      assert(
        !g.inlineVisible && !g.legacyVisible,
        "Non-empty groups never claim empty",
      );
    else if (g.expanded)
      assert(
        g.inlineVisible || g.legacyVisible,
        "Expanded empty group has a visible explanation in baseline or candidate",
      );
    else
      assert(
        !g.inlineVisible && !g.legacyVisible,
        "Collapsed empty group has no false open-state hint",
      );
    if (g.inlineVisible) assert.equal(g.inlineAriaHidden, "true");
  }
  assert.equal(state.pageOverflow, 0);
  assert(state.composer && state.composer.bottom <= state.viewport.height + 1);
}
export async function captureEmptyProjects({
  send,
  evaluate,
  wait,
  click,
  capture,
  evidence,
  options,
  url,
}) {
  const target = new URL(url);
  for (const key of ["rails", "codeWrap", "results", "tableKeyboard"])
    target.searchParams.delete(key);
  target.searchParams.set("emptyProjects", "1");
  target.searchParams.set("lang", options.theme === "dark" ? "zh" : "en");
  await send("Page.navigate", { url: target.href });
  await wait(
    `location.href===${JSON.stringify(target.href)} && document.querySelectorAll('.project-group').length===5`,
  );
  await click('.project-group [data-thread-id="thread-1"] .thread-row');
  await wait("!!document.querySelector('.composer')");
  const observe = () =>
    evaluate(
      `(${observeEmptyProjects.toString()})(${projectElementVisible.toString()})`,
    );
  const settle = () =>
    wait(
      "[...document.querySelectorAll('.project-group')].every(e=>e.getAnimations({subtree:true}).every(a=>a.playState!=='running'))",
    );
  const save = async (step, expected) => {
    await settle();
    const state = await observe();
    verifyEmptyProjects(state, expected);
    (evidence.emptyProjectCases ??= []).push({
      theme: options.theme,
      lang: target.searchParams.get("lang"),
      step,
      ...state,
    });
    await capture(
      `reading-${options.name}-empty-projects-${step}`,
      options,
      "reading",
    );
  };
  const selector = (key) =>
    `.project-group[data-project-key="${key}"] .project-toggle`;
  const tabSelector = async (targetSelector) => {
    for (let i = 0; i < 100; i++) {
      await dispatchNavigationKey(send, "Tab", "Tab", 9);
      if (
        await evaluate(
          `document.activeElement?.matches(${JSON.stringify(targetSelector)})`,
        )
      )
        return;
    }
    throw Error("Native Tab did not reach project toggle");
  };
  const tabTo = (key) => tabSelector(selector(key));
  const originalWidth = (await observe()).sidebarWidth;
  await tabTo("/work/design-system");
  await save("expanded", {});
  await dispatchNavigationKey(send, "Enter", "Enter", 13);
  await wait(
    `document.querySelector(${JSON.stringify(selector("/work/design-system"))}).getAttribute('aria-expanded')==='false'`,
  );
  await save("empty-collapsed", { emptyOpen: false });
  await dispatchNavigationKey(send, " ", "Space", 32);
  await wait(
    `document.querySelector(${JSON.stringify(selector("/work/design-system"))}).getAttribute('aria-expanded')==='true'`,
  );
  await tabTo("/work/delivery");
  await dispatchNavigationKey(send, "Enter", "Enter", 13);
  await wait(
    `document.querySelector(${JSON.stringify(selector("/work/delivery"))}).getAttribute('aria-expanded')==='false'`,
  );
  await save("filled-collapsed", { filledOpen: false });
  await dispatchNavigationKey(send, " ", "Space", 32);
  await wait(
    `document.querySelector(${JSON.stringify(selector("/work/delivery"))}).getAttribute('aria-expanded')==='true'`,
  );
  await settle();
  verifyEmptyProjects(await observe());
  await tabSelector(".sidebar-resizer");
  await dispatchNavigationKey(send, "Home", "Home", 36);
  await wait(
    "document.querySelector('.sidebar-resizer').getAttribute('aria-valuenow')===document.querySelector('.sidebar-resizer').getAttribute('aria-valuemin')",
  );
  await tabTo("/work/design-system");
  const min = await observe();
  assert.equal(min.sidebarWidth, min.sidebarMinWidth);
  const longGroup = min.groups.find((g) => g.key === "/work/design-system");
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: longGroup.toggle.x + 15,
    y: longGroup.toggle.y + longGroup.toggle.height / 2,
  });
  await save("minimum-width", {});
  const now = await observe(),
    handle = now.resizer;
  const x = handle.x + handle.width / 2,
    y = handle.y + Math.min(100, handle.height / 2);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: x + originalWidth - now.sidebarWidth,
    y,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: x + originalWidth - now.sidebarWidth,
    y,
    button: "left",
    clickCount: 1,
  });
  await wait(
    `Number(document.querySelector('.sidebar-resizer').getAttribute('aria-valuenow'))===${originalWidth}`,
  );
}
