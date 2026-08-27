import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  projectWorkspaceAcceptanceConfigPath,
  readProjectWorkspaceAcceptanceConfig,
  runProjectWorkspaceAcceptance,
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

test("packaged Project acceptance opens each Project menu before its actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zenx-project-acceptance-"));
  const configPath = join(directory, "acceptance.json");
  const resultPath = join(directory, "result.json");
  const expressions: string[] = [];
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        fixture: "fixture",
        mode: "mutate",
        projectA: "project-a",
        projectB: "project-b",
        resultPath,
      }),
      "utf8",
    );
    await runProjectWorkspaceAcceptance({
      applicationMenuAbsent: true,
      configPath,
      window: {
        isDestroyed: () => false,
        webContents: {
          executeJavaScript: (expression: string) => {
            expressions.push(expression);
            return Promise.resolve(true);
          },
          isLoading: () => false,
        },
      } as never,
    });

    const controls = expressions.flatMap((expression) =>
      Array.from(
        expression.matchAll(
          /candidate\.getAttribute\("aria-label"\) === ("(?:[^"\\]|\\.)*")/gu,
        ),
        (match) => JSON.parse(match[1]!) as string,
      ),
    );
    assert.deepEqual(controls, [
      "Add project",
      "fixture",
      "project-a",
      "Add folder",
      "More actions for project-a",
      "Remove from ZenX",
      "More actions for project-a",
      "Add project",
      "fixture",
      "project-b",
      "Add folder",
      "More actions for project-b",
      "Remove from ZenX",
      "Set as default",
      "More actions for project-a",
      "Remove from ZenX",
      "More actions for project-b",
      "More actions for project-a",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
