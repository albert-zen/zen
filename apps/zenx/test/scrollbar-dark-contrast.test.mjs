import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("dark active thumb is legible without changing light or idle behavior", async () => {
  const theme = await readFile(
    new URL("../src/renderer/src/theme.css", import.meta.url),
    "utf8",
  );
  const css = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    theme,
    /--color-scrollbar-thumb-hover: rgb\(255 255 255 \/ 32%\);/,
  );
  assert.match(theme, /--color-scrollbar-thumb: rgb\(255 255 255 \/ 8%\);/);
  assert.match(theme, /--color-scrollbar-thumb: #d9d9d9;/);
  assert.match(theme, /--color-scrollbar-thumb-hover: #bfbfbf;/);
  assert.match(
    css,
    /:root\[data-scrollbar-autohide\] \* \{\s*scrollbar-color: transparent transparent;/,
  );
  assert.match(
    css,
    /:root\[data-scrollbar-autohide\] \[data-scrollbar-active\] \{\s*scrollbar-color: var\(--color-scrollbar-thumb-hover\) transparent;/,
  );
});
