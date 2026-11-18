import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../../", import.meta.url);
const workflow = parse(
  readFileSync(new URL(".github/workflows/app-shot.yml", root), "utf8"),
);
const command = workflow.jobs.formatting.steps.find(
  (step) => step.name === "Check formatting without modifying the repository",
).run;

for (const needsFormatting of [false, true]) {
  test(`App Shot formatting honors ignores and ${needsFormatting ? "rejects" : "accepts"} ordinary source without rewriting files`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "app-shot-format-"));
    try {
      const git = (...args) =>
        execFileSync("git", args, { cwd, stdio: "pipe" });
      git("init", "--initial-branch=main");
      git("config", "user.email", "synthetic@example.invalid");
      git("config", "user.name", "Synthetic formatter test");
      writeFileSync(join(cwd, ".prettierignore"), "frozen.json\n");
      git("add", ".prettierignore");
      git("commit", "-m", "Synthetic base");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      // Invalid JSON proves ignored evidence is never parsed or reformatted.
      const frozen = "{ frozen evidence bytes\r\n";
      const source = needsFormatting
        ? "const value=1;\n"
        : "const value = 1;\n";
      writeFileSync(join(cwd, "frozen.json"), frozen);
      writeFileSync(join(cwd, "source.js"), source);
      git("add", "frozen.json", "source.js");
      git("commit", "-m", "Synthetic changed files");
      symlinkSync(
        fileURLToPath(new URL("node_modules", root)),
        join(cwd, "node_modules"),
        "dir",
      );
      const result = spawnSync("bash", ["-e", "-c", command], {
        cwd,
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(result.status, needsFormatting ? 1 : 0, result.stderr);
      assert.match(
        result.stdout,
        new RegExp(`APP_SHOT_FORMAT_END:${needsFormatting ? 1 : 0}`),
      );
      const chunks = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("APP_SHOT_FORMAT_CHUNK:"))
        .map((line) => JSON.parse(line.slice("APP_SHOT_FORMAT_CHUNK:".length)));
      const repairs = JSON.parse(chunks.map((chunk) => chunk.data).join(""));
      assert.deepEqual(
        repairs,
        needsFormatting ? { "source.js": "const value = 1;\n" } : {},
      );
      assert.equal(readFileSync(join(cwd, "frozen.json"), "utf8"), frozen);
      assert.equal(readFileSync(join(cwd, "source.js"), "utf8"), source);
      assert.equal(git("diff", "HEAD").toString(), "");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
