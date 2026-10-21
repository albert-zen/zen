import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const expected = fileURLToPath(
  new URL("../docs/reference-context/v2/", import.meta.url),
);
test("five references reach both production provider HTTP boundaries exactly as documented, with no network", async () => {
  const output = await mkdtemp(
    path.join(os.tmpdir(), "zen-reference-capture-"),
  );
  try {
    // Separate process: the capture's global network tripwire cannot leak to tests.
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "apps/zenx/scripts/capture-reference-context.mjs",
        output,
      ],
      { cwd: root, stdio: "pipe", timeout: 30000 },
    );
    for (const file of [
      "fixture-bundle.json",
      "chat-completions.request.pretty.json",
      "responses.request.pretty.json",
      "chat-completions.canonical-user-message.json",
      "responses.canonical-user-message.json",
    ]) {
      assert.deepEqual(
        JSON.parse(await readFile(path.join(output, file), "utf8")),
        JSON.parse(await readFile(path.join(expected, file), "utf8")),
        file,
      );
    }
    const report = JSON.parse(
      await readFile(path.join(output, "verification.json"), "utf8"),
    );
    assert.equal(report.reports.length, 4);
    assert(
      report.reports.every(
        (item) =>
          item.assertions === "passed" &&
          item.networkRequests === 0 &&
          item.requestCount === 1,
      ),
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
