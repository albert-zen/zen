import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkspaceTabIconVisible,
  measureWorkspaceTabIcon,
} from "../scripts/workspace-tab-icon-visibility.mjs";

const visible = () => ({
  icon: {
    left: 139,
    right: 153,
    top: 14.5,
    bottom: 28.5,
    width: 14,
    height: 14,
  },
  rail: { left: 128, right: 331, top: 5, bottom: 39, width: 203, height: 34 },
  styles: [
    {
      display: "block",
      visibility: "visible",
      opacity: "1",
      maskImage: "none",
    },
  ],
  hitInTab: true,
});

test("visible selected tab icon clears the full native titlebar", () => {
  assert.doesNotThrow(() => assertWorkspaceTabIconVisible(visible(), 128));
  assert.doesNotThrow(() => assertWorkspaceTabIconVisible(visible()));
});

test("capture rejects a titlebar overlay even when native controls fit", () => {
  assert.throws(
    () => assertWorkspaceTabIconVisible(visible(), 180),
    /full titlebar/,
  );
  assert.throws(
    () => assertWorkspaceTabIconVisible({ ...visible(), hitInTab: false }),
    /covered by another layer/,
  );
});

test("capture rejects a missing, clipped, hidden, transparent, or masked icon", () => {
  assert.throws(() => assertWorkspaceTabIconVisible(null), /renders an SVG/);
  const clipped = visible();
  clipped.icon.left = 120;
  assert.throws(() => assertWorkspaceTabIconVisible(clipped), /clipped/);
  for (const style of [
    { display: "none" },
    { visibility: "hidden" },
    { opacity: "0" },
    { maskImage: "linear-gradient(transparent, black)" },
  ]) {
    const hidden = visible();
    Object.assign(hidden.styles[0], style);
    assert.throws(() => assertWorkspaceTabIconVisible(hidden), /masking layer/);
  }
});

test("browser measurement can be serialized without capture-module dependencies", () => {
  const measure = new Function(
    `return (${measureWorkspaceTabIcon.toString()})`,
  )();
  const previous = globalThis.document;
  try {
    globalThis.document = { querySelector: () => null };
    assert.equal(measure(), null);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
