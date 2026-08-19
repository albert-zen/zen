import assert from "node:assert/strict";
import test from "node:test";

import { projectWorkspaceAcceptanceConfigPath } from "../src/main/project-workspace-smoke.js";

test("packaged Project acceptance stays disabled for ordinary launches", () => {
  assert.equal(projectWorkspaceAcceptanceConfigPath(["ZenX.exe"]), null);
  assert.equal(
    projectWorkspaceAcceptanceConfigPath([
      "ZenX.exe",
      "--remote-debugging-port=9222",
    ]),
    null,
  );
});

test("packaged Project acceptance requires one explicit config argument", () => {
  assert.equal(
    projectWorkspaceAcceptanceConfigPath([
      "ZenX.exe",
      "--zenx-project-acceptance=C:\\smoke\\acceptance.json",
    ]),
    "C:\\smoke\\acceptance.json",
  );
  assert.equal(
    projectWorkspaceAcceptanceConfigPath([
      "ZenX.exe",
      "--zenx-project-acceptance=first.json",
      "--zenx-project-acceptance=second.json",
    ]),
    null,
  );
});
