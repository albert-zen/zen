import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const styles = await readFile(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
test("native window controls have a separate row above all workspace actions", () => {
  assert.match(
    styles,
    /:root:is\(\[data-platform="linux"\], \[data-platform="win32"\]\) \.app-shell\s*\{[^}]*grid-template-rows:\s*var\(--native-titlebar-height\) var\(\s*--native-titlebar-height\s*\)\s*minmax\(0, 1fr\);/su,
  );
  assert.match(styles, /\.workspace \{\s*grid-row: 2 \/ -1;/su);
});
test("selected workspace tabs use depth without an accent underline", () => {
  assert.doesNotMatch(
    styles,
    /\.workspace-content-tab\[data-active="true"\]\s*\{[^}]*inset 0 -2px/su,
  );
});

test("the fixed panel toggle remains visible when the conversation title is hidden", () => {
  assert.match(
    styles,
    /:root:is\(\[data-platform="linux"\], \[data-platform="win32"\]\)\s*\.thread-panel-toggle\s*\{[^}]*visibility: visible;/su,
  );
  assert.doesNotMatch(
    styles,
    /:root:is\(\[data-platform="linux"\], \[data-platform="win32"\]\)\s*\.thread-heading\s*\{[^}]*visibility: visible;/su,
  );
});

test("the global opener is absent while the panel owns its Close button", async () => {
  const app = await readFile(
    new URL("../src/renderer/src/App.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    app,
    /<\/WindowTitleBar>\s*\{page === "agent" &&\s*newThreadDraft === null &&\s*selectedSummary !== null &&\s*browserPanels\[selectedSummary.threadId\] !== true \? \(/su,
  );
  assert.doesNotMatch(
    styles,
    /\.auxiliary-close-button\s*\{[^}]*display: none;/su,
  );
});
