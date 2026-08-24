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
