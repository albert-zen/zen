import assert from "node:assert/strict";
import test from "node:test";
import { verifySidebarName } from "../scripts/reading-main-ui-preview.mjs";
test("full-name evidence rejects truncated, clipped, invisible or non-keyboard states", () => {
  const state = {
    text: "A complete long title",
    visible: true,
    clipped: false,
    focusVisible: true,
  };
  verifySidebarName(state, state.text, { keyboard: true });
  for (const change of [
    { text: "A complete…" },
    { visible: false },
    { clipped: true },
    { focusVisible: false },
  ]) {
    assert.throws(() =>
      verifySidebarName({ ...state, ...change }, state.text, {
        keyboard: true,
      }),
    );
  }
  verifySidebarName({ ...state, focusVisible: false }, state.text);
});
