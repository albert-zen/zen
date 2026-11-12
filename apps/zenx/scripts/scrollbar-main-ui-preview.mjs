import assert from "node:assert/strict";
import { dispatchNavigationKey } from "./navigation-main-ui-preview.mjs";

/** Read-only observation of the production scroller, never a painted mock. */
export function observeScrollbar() {
  const e = document.querySelector(".messages");
  const r = e.getBoundingClientRect();
  const focused = document.activeElement;
  return {
    active: e.hasAttribute("data-scrollbar-active"),
    autohide: document.documentElement.hasAttribute("data-scrollbar-autohide"),
    scrollTop: e.scrollTop,
    scrollHeight: e.scrollHeight,
    clientHeight: e.clientHeight,
    rect: {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    },
    thumbColor: getComputedStyle(e, "::-webkit-scrollbar-thumb")
      .backgroundColor,
    focusInside: e.contains(focused),
    focusTag: focused?.tagName,
    focusLabel: focused?.getAttribute("aria-label"),
    focusVisible: focused?.matches(":focus-visible") ?? false,
  };
}

/** Real CDP pointer/wheel/Tab inputs against the existing synthetic App fixture.
 * No dispatchEvent, focus(), scrollTop assignment, new controls or CSS overrides.
 */
export async function captureScrollbarStates({
  send,
  evaluate,
  capture,
  evidence,
  options,
}) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const observe = () => evaluate(`(${observeScrollbar.toString()})()`);
  const move = (x, y, extra = {}) =>
    send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, ...extra });
  const results = {
    theme: options.theme,
    scope:
      "Production App with synthetic conversation; Chrome CDP inputs, not native Electron acceptance",
    states: [],
  };
  (evidence.scrollbarTrips ??= []).push(results);
  const save = async (name) => {
    const state = await observe();
    results.states.push({ name, ...state });
    await capture(`scrollbar-${options.name}-${name}`, options, "reading");
    return state;
  };
  await move(10, 10);
  await pause(1200);
  const idle = await save("idle");
  assert(
    idle.autohide && idle.scrollHeight > idle.clientHeight,
    "Production visibility lifecycle and actual overflow required",
  );
  assert(
    !idle.active && !idle.focusInside,
    "Idle scrollbar is faded without focus",
  );
  const x = idle.rect.right - 3,
    y = idle.rect.y + 20;
  await move(x, y);
  await pause(1100);
  const hover = await save("edge-hover-held");
  assert(hover.active, "Edge hover remains revealed beyond idle timeout");
  await move(idle.rect.x + idle.rect.width / 2, idle.rect.y + 60);
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: idle.rect.x + idle.rect.width / 2,
    y: idle.rect.y + 60,
    deltaX: 0,
    deltaY: 180,
  });
  await pause(100);
  const wheel = await save("wheel");
  assert(
    wheel.active && wheel.scrollTop > idle.scrollTop,
    "Native wheel scroll moves content and reveals scrollbar",
  );
  await move(10, 10);
  await pause(1200);
  assert(
    !(await save("wheel-settled")).active,
    "Wheel activity fades after idle",
  );

  // Acquire an existing production descendant with genuine keyboard navigation.
  for (let n = 0; n < 120 && !(await observe()).focusInside; n++) {
    await dispatchNavigationKey(send, "Tab", "Tab", 9);
  }
  assert(
    (await observe()).focusInside,
    "Native Tab reaches an existing transcript control",
  );
  await pause(1200);
  const focus = await save("keyboard-focus-held");
  assert(
    focus.active && focus.focusInside && focus.focusVisible,
    "Keyboard focus retains scrollbar after idle timeout",
  );
  for (let n = 0; n < 120 && (await observe()).focusInside; n++) {
    await dispatchNavigationKey(send, "Tab", "Tab", 9);
  }
  assert(!(await observe()).focusInside, "Native Tab exits transcript");
  await pause(1200);
  assert(
    !(await save("keyboard-focus-exit")).active,
    "Focus exit resumes fading",
  );

  // Return to top with a native wheel before grabbing the real scrollbar thumb.
  let before = await observe();
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: before.rect.x + before.rect.width / 2,
    y: before.rect.y + 60,
    deltaX: 0,
    deltaY: -before.scrollHeight,
  });
  await pause(150);
  before = await observe();
  const thumbHeight =
    (before.clientHeight * before.clientHeight) / before.scrollHeight;
  const dragY = before.rect.y + Math.min(thumbHeight / 2, 12);
  await move(x, dragY);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y: dragY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await move(x, dragY + 70, { button: "left", buttons: 1 });
  await pause(1100);
  const drag = await save("native-thumb-drag");
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y: dragY + 70,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  results.drag = {
    moved: drag.scrollTop > before.scrollTop,
    activeWhileHeld: drag.active,
    before: before.scrollTop,
    after: drag.scrollTop,
  };
  assert(
    results.drag.moved && results.drag.activeWhileHeld,
    "Native thumb drag moves content and stays revealed",
  );
  await move(10, 10);
  await pause(1200);
  assert(
    !(await save("drag-released")).active,
    "Drag release outside edge resumes fading",
  );
}
