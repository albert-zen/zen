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

test("five original inline references persist as compact semantic input at both real provider boundaries without network", async () => {
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
      ["fixture-metadata.json", "model-user-message.txt", "verification.json"],
      "only user-message text, fixture metadata and verification are persisted",
    );
    for (const file of ["fixture-metadata.json", "verification.json"]) {
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
    assert.equal(
      await readFile(path.join(output, "fixture-metadata.json"), "utf8"),
      await readFile(path.join(expected, "fixture-metadata.json"), "utf8"),
      "the original generated v3 fixture remains byte-identical",
    );
    assert.notEqual(actualUserMessage.trimEnd(), fixture.payload);
    assert.match(
      actualUserMessage,
      /^\[Message received at 2026-10-21T03:00:00.000Z\]\n/,
    );
    assert.doesNotMatch(
      actualUserMessage,
      /zenx-reference-message:v3|synthetic-v3-host-[0-9]|synthetic-v3-runtime-[0-9]|synthetic-inline-reference-v3-submission/,
    );
    assert.match(actualUserMessage, /Selected message "验收结论 A"; s1;/);
    assert.match(actualUserMessage, /Selected message "验收结论 B"; s2;/);
    assert.match(actualUserMessage, /Selected thread "项目状态讨论"; s3;/);
    assert.match(actualUserMessage, /Selected thread "执行子任务审查"; s4;/);
    assert.doesNotMatch(actualUserMessage, /; s5;/);
    for (const reference of fixture.references.filter(
      (value) => value.kind === "message",
    ))
      assert.ok(actualUserMessage.includes(reference.excerpt));
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
          report.providerUserMessageMatch === true &&
          report.canonicalJournalMatch === true &&
          report.originalFactLogMatch === true &&
          report.persistedSemanticInputMatch === true &&
          report.compilerInputMatch === true &&
          report.matchingUserMessageCaptures >= 1,
      ),
    );
    assert.equal(verification.contextFormat, "persisted-semantic-itemlist");
    assert.equal(verification.syntheticOnly, true);
    assert.equal(verification.capturesOnlyUserMessage, true);
    assert.equal(verification.fullProviderRequestsWritten, false);
    assert.equal(verification.systemAndToolPromptsWritten, false);
    assert.equal(verification.networkRequests, 0);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
