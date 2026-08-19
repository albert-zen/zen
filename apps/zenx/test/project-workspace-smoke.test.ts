import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  projectWorkspaceAcceptanceConfigPath,
  readProjectWorkspaceAcceptanceConfig,
} from "../src/main/project-workspace-smoke.js";

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
    projectWorkspaceAcceptanceConfigPath(
      ["ZenX.exe"],
      "C:\\smoke\\acceptance.json",
    ),
    "C:\\smoke\\acceptance.json",
  );
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
  assert.equal(
    projectWorkspaceAcceptanceConfigPath(
      ["ZenX.exe", "--zenx-project-acceptance=argument.json"],
      "environment.json",
    ),
    null,
  );
});

test("packaged Project acceptance reads Windows PowerShell UTF-8 BOM configs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zenx-project-acceptance-"));
  const configPath = join(directory, "acceptance.json");
  try {
    await writeFile(
      configPath,
      `\uFEFF${JSON.stringify({
        fixture: "fixture",
        mode: "mutate",
        projectA: "project-a",
        projectB: "project-b",
        resultPath: join(directory, "result.json"),
      })}`,
      "utf8",
    );
    const config = await readProjectWorkspaceAcceptanceConfig(configPath);
    assert.equal(config.mode, "mutate");
    assert.equal(config.projectB, "project-b");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
