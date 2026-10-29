import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("observation fixture keeps the production shell in flow below its visible controls", async () => {
  const fixture = await readFile(
    new URL(
      "./fixtures/browser-observation-failure-visual.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const shell = fixture.match(
    /<section\s+className="auxiliary-panel"\s+style=\{\{([\s\S]*?)\}\}/,
  )?.[1];
  assert.ok(shell, "Exercise the real auxiliary shell and BrowserThreadPanel");
  assert.match(shell, /position:\s*"relative"/);
  assert.match(shell, /inset:\s*"auto"/);
  const controls = fixture.indexOf('aria-label="Synthetic fixture controls"');
  const pane = fixture.indexOf('className="auxiliary-panel"');
  assert.ok(controls >= 0 && controls < pane);
  assert.match(fixture, /<BrowserThreadPanel\s/);
  for (const label of [
    "Fail before targets",
    "Fail known page stream",
    "Known empty catalog",
    "Missing fixed target",
    "Known snapshot mode",
    "Recover observation",
    "Light theme",
    "Dark theme",
    "English",
    "中文",
    "Narrow panel",
  ]) {
    assert.ok(fixture.slice(controls, pane).includes(label), label);
  }
  // This guards the scaffold's positioning contract; actual pointer hit-testing
  // and screenshots remain browser acceptance, not a claim from source checks.
});
