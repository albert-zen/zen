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
test("literal v2 references and recorded receipts survive both legal provider content shapes without network", async () => {
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
      "chat-completions.canonical-user-message.json",
      "responses.canonical-user-message.json",
    ]) {
      assert.deepEqual(
        JSON.parse(await readFile(path.join(output, file), "utf8")),
        JSON.parse(await readFile(path.join(expected, file), "utf8")),
        file,
      );
    }
    const bundle = JSON.parse(
      await readFile(path.join(output, "fixture-bundle.json"), "utf8"),
    );
    for (const format of ["chat-completions", "responses"]) {
      const name = `${format}.request.pretty.json`;
      const prior = JSON.parse(
        await readFile(path.join(expected, name), "utf8"),
      );
      const current = JSON.parse(
        await readFile(path.join(output, name), "utf8"),
      );
      const key = format === "chat-completions" ? "messages" : "input";
      const text = (message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => ["text", "input_text"].includes(part.type))
              .map((part) => part.text)
              .join("\n");
      const previousUser = prior[key].find(
        (message) =>
          message.role === "user" &&
          text(message).includes(bundle.canonicalText),
      );
      assert.ok(
        previousUser,
        "unchanged historical wire fixture contains the exact original v2 envelope",
      );
      // Keep the old fixture intact: its adapter-added metadata wrapper is a
      // historical observation, not the new compiler's receipt spelling.
      const oldSource = previousUser.content.find(
        (part) => part.text === bundle.canonicalText,
      );
      assert.equal(oldSource.text, bundle.canonicalText);
      const submitted = current[key].filter(
        (message) =>
          message.role === "user" &&
          text(message).includes(bundle.canonicalText),
      );
      assert.equal(submitted.length, 1);
      assert.equal(
        text(submitted[0]),
        `[Message received at ${bundle.timestamp}]\n${oldSource.text}`,
      );
      const { [key]: _oldContext, ...priorSettings } = prior;
      const { [key]: _currentContext, ...currentSettings } = current;
      assert.deepEqual(
        currentSettings,
        priorSettings,
        "provider request settings remain unchanged",
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
          item.originalInputUnchanged === true &&
          item.recordedReceiptInCompilerAndWire === true &&
          item.networkRequests === 0 &&
          item.requestCount === 1,
      ),
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
