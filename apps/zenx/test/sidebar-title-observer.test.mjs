import assert from "node:assert/strict";
import test from "node:test";
import { verifySidebarTitlePresentation } from "../scripts/navigation-main-ui-preview.mjs";
const expected =
  "Design review · shared component accessibility and release readiness · alternate review";
const slot = { rect: { x: 10, right: 110 } };
const good = {
  canonical: { text: expected },
  canonicalAttribute: expected,
  canonicalCount: 1,
  canonicalExposed: true,
  displayHiddenFromAT: true,
  probesHiddenFromAT: true,
  additionalTabStops: 0,
  mode: "marked",
  display: {
    text: "… alternate review",
    visible: true,
    ellipsized: false,
    rect: { x: 10, right: 110, width: 100 },
  },
};
test("exact canonical plus fitting semantic suffix passes, legacy absent presentation unchanged", () => {
  verifySidebarTitlePresentation(good, expected, slot);
  verifySidebarTitlePresentation(null, expected, slot);
  verifySidebarTitlePresentation(
    {
      ...good,
      mode: "bare",
      display: { ...good.display, text: "alternate review" },
    },
    expected,
    slot,
  );
  verifySidebarTitlePresentation(
    {
      ...good,
      mode: "canonical",
      display: { ...good.display, text: expected, ellipsized: true },
    },
    expected,
    slot,
  );
});
test("reject wrong original, mismatched marker, duplicate/hidden AT or new tabstop", () => {
  for (const mutate of [
    (s) => (s.canonical.text = "wrong"),
    (s) => (s.canonicalAttribute = "wrong"),
    (s) => (s.canonicalCount = 2),
    (s) => (s.canonicalExposed = false),
    (s) => (s.displayHiddenFromAT = false),
    (s) => (s.probesHiddenFromAT = false),
    (s) => (s.additionalTabStops = 1),
  ]) {
    const state = structuredClone(good);
    mutate(state);
    assert.throws(() => verifySidebarTitlePresentation(state, expected, slot));
  }
});
test("reject invented, ellipsized, hidden or out-of-slot display", () => {
  for (const mutate of [
    (s) => (s.display.text = "… other"),
    (s) => (s.display.text = "review"),
    (s) => (s.display.ellipsized = true),
    (s) => (s.display.visible = false),
    (s) => (s.display.rect.right = 111.1),
    (s) => (s.display.rect.width = 0),
  ]) {
    const state = structuredClone(good);
    mutate(state);
    assert.throws(() => verifySidebarTitlePresentation(state, expected, slot));
  }
});
