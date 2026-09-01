import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("narrow desktop Thread rows reserve the overflow menu column", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const mediumStart = styles.indexOf("@media (max-width: 820px)");
  const mobileStart = styles.indexOf("@media (max-width: 640px)");
  assert.notEqual(mediumStart, -1);
  assert.ok(mobileStart > mediumStart);
  assert.match(
    styles.slice(mediumStart, mobileStart),
    /\.thread-row\s*\{\s*padding: 10px 46px 10px 10px;/u,
  );
  assert.match(
    styles.slice(mobileStart),
    /\.thread-row\s*\{\s*padding-right: 52px;/u,
  );
});

test("Thread overflow stays inert until hover, focus, or an open menu", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.thread-menu-trigger\s*\{[^}]*opacity: 0;[^}]*visibility: hidden;[^}]*pointer-events: none;/su,
  );
  assert.match(styles, /\.thread-row-shell:hover \.thread-menu-trigger/u);
  assert.match(
    styles,
    /\.thread-row-shell:focus-within \.thread-menu-trigger/u,
  );
  assert.match(
    styles,
    /\.thread-menu-trigger\[aria-expanded="true"\]\s*\{[^}]*opacity: 1;[^}]*visibility: visible;[^}]*pointer-events: auto;/su,
  );
  assert.doesNotMatch(
    styles,
    /\.thread-row\.selected[^}]*\.thread-menu-trigger/su,
  );
});

test("whole rows expose drag affordance without visible reorder handles", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(styles, /\.reorder-handle/u);
  assert.match(
    styles,
    /\.project-header\.reorderable > \.project-toggle,[\s\S]*\.thread-row-shell\.reorderable > \.thread-row\s*\{[^}]*cursor:\s*grab;/u,
  );
});

test("Settings footer hugs its single navigation row", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.sidebar-footer\s*\{[^}]*min-height:\s*50px;[^}]*padding:\s*5px 8px;/su,
  );
});

test("plugin page and panel collapse to one usable narrow desktop column", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const narrow = styles.slice(styles.indexOf("@media (max-width: 760px)"));
  assert.match(
    narrow,
    /\.plugin-page-scroll\s*\{\s*grid-template-columns: minmax\(0, 1fr\);\s*padding: 14px;/su,
  );
});

test("592px Settings reflows tabs and moves the sidebar off canvas", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const medium = styles.slice(
    styles.indexOf("@media (max-width: 820px)"),
    styles.indexOf("@media (max-width: 720px)"),
  );
  const narrow = styles.slice(
    styles.indexOf("@media (max-width: 720px)"),
    styles.indexOf("@media (max-width: 640px)"),
  );
  const mobile = styles.slice(
    styles.indexOf("@media (max-width: 640px)"),
    styles.indexOf("@media (max-width: 380px)"),
  );

  assert.match(
    medium,
    /\.settings-layout\s*\{[^}]*display:\s*block;[^}]*min-height:\s*0;/su,
  );
  assert.match(
    medium,
    /\.settings-nav\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/su,
  );
  assert.doesNotMatch(medium, /\.settings-nav\s*\{[^}]*overflow-x:/su);
  assert.match(
    narrow,
    /\.app-shell\s*\{[^}]*--sidebar-track:\s*0px;[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/su,
  );
  assert.match(
    narrow,
    /\.sidebar\s*\{[^}]*position:\s*absolute;[^}]*transform:\s*translateX\(-102%\);/su,
  );
  assert.match(
    narrow,
    /\.workspace\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2;/su,
  );
  assert.match(
    mobile,
    /\.settings-nav\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/su,
  );
});

test("200% text zoom keeps Settings copy and Appearance controls reflowable", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const medium = styles.slice(
    styles.indexOf("@media (max-width: 820px)"),
    styles.indexOf("@media (max-width: 720px)"),
  );
  const mobile = styles.slice(
    styles.indexOf("@media (max-width: 640px)"),
    styles.indexOf("@media (max-width: 380px)"),
  );
  const zoomed = styles.slice(
    styles.indexOf("@media (max-width: 380px)"),
    styles.indexOf(
      "@media (prefers-reduced-motion: reduce)",
      styles.indexOf("@media (max-width: 380px)"),
    ),
  );

  assert.match(
    medium,
    /\.settings-nav button\s*\{[^}]*min-height:\s*44px;[^}]*height:\s*auto;[^}]*line-height:\s*1\.35;/su,
  );
  assert.match(
    mobile,
    /\.agent-surface,\s*\.product-page\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/su,
  );
  assert.match(
    mobile,
    /\.page-title h1,\s*\.page-title p\s*\{[^}]*overflow:\s*visible;[^}]*white-space:\s*normal;/su,
  );
  assert.match(
    mobile,
    /\.appearance-editor-grid\s*\{[^}]*grid-template-columns:\s*1fr;/su,
  );
  assert.match(
    mobile,
    /\.appearance-control-row\s*\{[^}]*grid-template-columns:\s*1fr;/su,
  );
  assert.match(
    zoomed,
    /\.settings-nav,\s*\.appearance-options,\s*\.appearance-preset-options,\s*\.appearance-accent-options\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/su,
  );
});
