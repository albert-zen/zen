import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("foreground CI evidence requires installed CJK fonts and uses the production renderer fixture", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const capture = await readFile(
    new URL(
      "../scripts/capture-foreground-activity-preview.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(
    workflow.indexOf("Install CJK fonts for synthetic UI acceptance") <
      workflow.indexOf("Capture foreground activity renderer"),
  );
  assert.match(capture, /assert\.ok\(\s*evidence\.cjkFonts\.length > 0/);
  assert.match(workflow, /preview-foreground-activity\.mjs/);
  assert.match(capture, /not OS focus/);
  assert.doesNotMatch(capture, /--no-sandbox/);
});
