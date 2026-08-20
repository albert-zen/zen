import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sidebarSource = await readFile(
  new URL("../src/renderer/src/Sidebar.tsx", import.meta.url),
  "utf8",
);
const brandSource = await readFile(
  new URL("../src/renderer/src/ZenXBrand.tsx", import.meta.url),
  "utf8",
).catch(() => "");

test("ZenX branding uses a replaceable asset component instead of layout geometry", () => {
  assert.match(sidebarSource, /import \{ ZenXBrand \}/u);
  assert.match(sidebarSource, /<ZenXBrand \/>/u);
  assert.doesNotMatch(sidebarSource, /<svg|<path|\sd=/u);

  assert.match(brandSource, /zenx-logo-placeholder\.svg/u);
  assert.match(brandSource, /<img/u);
  assert.match(brandSource, />ZENX</u);
  assert.doesNotMatch(brandSource, /<svg|<path|\sd=/u);
});
