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
test("v2 references normalize before dispatch while original input and recorded receipts survive both provider shapes", async () => {
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
        (message) => message.role === "user",
      );
      assert.equal(submitted.length, 1);
      const semantic = JSON.parse(
        await readFile(
          path.join(output, `${format}.semantic-user-message.json`),
          "utf8",
        ),
      );
      assert.equal(semantic.kind, "message");
      assert.equal(
        text(submitted[0]),
        semantic.content.text,
        "actual provider request matches the persisted semantic user message",
      );
      assert.ok(
        semantic.content.text.startsWith(
          `[Message received at ${bundle.timestamp}]\n`,
        ),
      );
      assert.ok(semantic.content.text.includes(bundle.sourceFullMessage));
      assert.ok(semantic.content.text.includes(bundle.sourceSelection));
      assert.ok(!semantic.content.text.includes(bundle.canonicalText));
      for (const reference of bundle.references) {
        if (reference.kind === "file") continue;
        assert.ok(!semantic.content.text.includes(reference.id));
        if (reference.kind === "message")
          assert.ok(!semantic.content.text.includes(reference.threadId));
      }
      const bindings = semantic.source.metadata.referenceBindings;
      assert.deepEqual(
        bindings.map((binding) => binding.ref),
        ["s1", "s2", "s3"],
      );
      for (const binding of bindings)
        assert.ok(semantic.content.text.includes(`; ${binding.ref};`));
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
          item.persistedSemanticInputMatchesWire === true &&
          item.compactSourceReferences === true &&
          item.networkRequests === 0 &&
          item.requestCount === 1,
      ),
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
