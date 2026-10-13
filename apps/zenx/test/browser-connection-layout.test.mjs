import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("external browser checkbox keeps a horizontal labeled row on narrow settings pages", async () => {
  const component = await readFile(
    new URL(
      "../src/renderer/src/ChromeConnectionSettings.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(component, /className="settings-row browser-connection-toggle"/);
  const row = styles.match(
    /\.settings-view \.settings-row\.browser-connection-toggle\s*\{([^}]+)\}/,
  )?.[1];
  assert.ok(
    row,
    "component-specific specificity must beat the narrow generic row rule",
  );
  assert.match(row, /flex-direction:\s*row/);
  assert.match(row, /align-items:\s*center/);
  assert.match(
    styles,
    /\.browser-connection-toggle > input\[type="checkbox"\]\s*\{[^}]*flex:\s*none/s,
  );
});
