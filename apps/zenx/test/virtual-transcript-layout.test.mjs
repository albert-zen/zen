import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const css = readFileSync(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const theme = readFileSync(
  new URL("../src/renderer/src/theme.css", import.meta.url),
  "utf8",
);
const virtual = css.slice(css.indexOf("/* WIP virtual viewport:"));
const [wide, narrow] = virtual.split("@media (max-width: 640px)");
test("virtual rows and pending footer retain the desktop 24px rhythm", () => {
  assert.match(wide, /\.virtual-transcript-row\s*\{\s*padding-bottom:\s*24px;/);
  assert.match(wide, /\.virtual-transcript-footer\s*\{[^}]*gap:\s*24px;/);
});
test("virtual rows and pending footer inherit the existing narrow 20px contract", () => {
  assert.ok(
    narrow,
    "the virtual viewport needs its own matching ≤640px override",
  );
  assert.match(
    narrow,
    /\.virtual-transcript-row\s*\{\s*padding-bottom:\s*20px;/,
  );
  assert.match(
    narrow,
    /\.virtual-transcript-header\s*\{\s*padding-top:\s*20px;/,
  );
  assert.match(
    narrow,
    /\.virtual-transcript-footer\s*\{\s*gap:\s*20px;\s*padding-bottom:\s*max\(28px,/,
  );
});
test("experimental warning color refers to the defined current theme alias", () => {
  assert.match(
    wide,
    /\.virtual-transcript-warning\s*\{\s*color:\s*var\(--text-secondary\);/,
  );
  assert.match(theme, /--text-secondary:\s*var\(--color-text-secondary\);/);
  assert.match(theme, /--color-text-secondary:\s*#[0-9a-f]{6};/i);
});
