import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const expected = fileURLToPath(
  new URL("../docs/reference-context/v3/", import.meta.url),
);

test("five ordered inline references reach both provider user-message boundaries without network", async () => {
  const output = await mkdtemp(
    path.join(os.tmpdir(), "zen-inline-reference-v3-"),
  );
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "apps/zenx/scripts/capture-inline-reference-context.mjs",
        output,
      ],
      { cwd: root, stdio: "pipe", timeout: 30000 },
    );

    assert.deepEqual(
      (await readdir(output)).sort(),
      [
        "chat-completions.complete-user-message.json",
        "fixture-metadata.json",
        "model-user-message.txt",
        "responses.complete-user-message.json",
        "verification.json",
      ],
      "complete user-message evidence, original user text, and metadata only",
    );
    for (const file of [
      "fixture-metadata.json",
      "verification.json",
      "chat-completions.complete-user-message.json",
      "responses.complete-user-message.json",
    ]) {
      assert.deepEqual(
        JSON.parse(await readFile(path.join(output, file), "utf8")),
        JSON.parse(await readFile(path.join(expected, file), "utf8")),
        file,
      );
    }

    const fixture = JSON.parse(
      await readFile(path.join(output, "fixture-metadata.json"), "utf8"),
    );
    const actualUserMessage = await readFile(
      path.join(output, "model-user-message.txt"),
      "utf8",
    );
    const documentedUserMessage = await readFile(
      path.join(expected, "model-user-message.txt"),
      "utf8",
    );
    assert.equal(actualUserMessage, documentedUserMessage);
    assert.equal(actualUserMessage.trimEnd(), fixture.payload);
    assert.equal(fixture.references.length, 5);
    assert.deepEqual(
      fixture.references.map((reference) => reference.position),
      [4, 19, 31, 44, 59],
    );
    assert.equal(
      [...fixture.text].filter((character) => character === "\uFFFC").length,
      5,
    );
    assert.match(fixture.payload, /这一段 \[ZenX reference:/);
    assert.match(fixture.payload, /是否意味着…？线程 \[ZenX reference:/);
    assert.match(fixture.payload, /检查他们是否都完成、是否矛盾。$/);
    assert.match(fixture.payload, /"contentMode":"excerpt"/);
    assert.match(fixture.payload, /"contentMode":"pointer"/);

    const verification = JSON.parse(
      await readFile(path.join(output, "verification.json"), "utf8"),
    );
    assert.deepEqual(
      verification.reports.map((report) => report.format).sort(),
      ["chat-completions", "responses"],
    );
    assert(
      verification.reports.every(
        (report) =>
          report.networkRequests === 0 &&
          report.originalUserMatch === true &&
          report.completeCanonicalTextMatch === true &&
          report.canonicalJournalMatch === true &&
          report.matchingUserMessageCaptures >= 1,
      ),
    );
    assert.equal(verification.capturesOnlyUserMessage, true);
    assert.equal(
      verification.modelUserMessageTxtScope,
      "original-user-text-only",
    );
    assert.equal(verification.completeUserMessagesIncludeHostMetadata, true);
    for (const format of ["chat-completions", "responses"]) {
      const complete = JSON.parse(
        await readFile(
          path.join(output, `${format}.complete-user-message.json`),
          "utf8",
        ),
      );
      assert.match(complete.canonicalContent[0].text, /received_at=/);
      assert.deepEqual(
        complete.serializedUserMessage.content.map((part) => part.text),
        complete.canonicalContent.map((part) => part.text),
      );
    }
    assert.equal(verification.fullProviderRequestsWritten, false);
    assert.equal(verification.systemAndToolPromptsWritten, false);
    assert.equal(verification.networkRequests, 0);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
