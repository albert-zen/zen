import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { collectRoomHistoryEvidence } from "../scripts/collect-room-history-evidence.mjs";
test("Room evidence allowlists synthetic outputs and fails closed without exact source provenance", async () => {
  const input = await mkdtemp(path.join(tmpdir(), "room-safe-evidence-"));
  const output = path.join(input, "safe");
  const commit = "a".repeat(40);
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const source = {
    commit,
    fixtureSha256: sha("fixture"),
    htmlSha256: sha("html"),
    count: 320,
    finalCount: 320,
    dispatches: 0,
    bodyBytes: 1344320,
    restartVerified: true,
    node: "v22.0.0",
    unsafe: "/private/host/path",
  };
  try {
    await writeFile(path.join(input, "fixture.json"), "fixture");
    await writeFile(path.join(input, "room-history.html"), "html");
    await writeFile(path.join(input, "source.json"), JSON.stringify(source));
    await writeFile(path.join(input, "chrome.log"), "private raw diagnostic");
    await writeFile(
      path.join(input, "browser-lifecycle.json"),
      JSON.stringify({
        captureStatus: "passed",
        cleanupComplete: true,
        artifactErrors: [],
        executable: "/private/host/path",
      }),
    );
    const names = ["initial", "cross-256", "oldest", "latest"];
    await writeFile(
      path.join(input, "measurements.json"),
      JSON.stringify({
        status: "passed",
        browserSandboxDisabled: false,
        rendererErrors: [],
        externalRequests: [],
        cases: names.map((name, i) => ({
          name,
          count: [4, 260, 320, 320][i],
          unique: [4, 260, 320, 320][i],
          idsMatch: true,
          textsMatch: true,
          scrollStable: true,
        })),
      }),
    );
    for (const name of names)
      await writeFile(
        path.join(input, `${name}.png`),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    assert.equal(
      (await collectRoomHistoryEvidence(input, output, commit))
        .acceptancePassed,
      true,
    );
    assert.deepEqual(
      (await readdir(output)).sort(),
      ["acceptance.json", ...names.map((name) => `${name}.png`)].sort(),
    );
    assert.equal(
      (await readFile(path.join(output, "acceptance.json"), "utf8")).includes(
        "private",
      ),
      false,
    );
    await unlink(path.join(input, "source.json"));
    assert.equal(
      (await collectRoomHistoryEvidence(input, output, commit))
        .acceptancePassed,
      false,
    );
    for (const invalid of [
      { ...source, commit: "b".repeat(40) },
      { ...source, fixtureSha256: null },
      { ...source, htmlSha256: "f".repeat(64) },
      { ...source, count: 319 },
      { ...source, dispatches: 1 },
    ]) {
      await writeFile(path.join(input, "source.json"), JSON.stringify(invalid));
      assert.equal(
        (await collectRoomHistoryEvidence(input, output, commit))
          .acceptancePassed,
        false,
      );
    }
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});
