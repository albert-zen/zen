import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceFile } from "../src/main/workspace-files.js";
import { workspaceBrowserUrl } from "../src/main/workspace-browser.js";
import { classifyMessageLink } from "../src/external-link-policy.js";
import { messageFilePath } from "../src/renderer/src/message-file-path.js";

test("message files use Host workspace reader for actual cwd, absolute, file URL and failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zenx-link-"));
  try {
    await writeFile(join(cwd, "中文 file.md"), "visible\n");
    await symlink("/etc/passwd", join(cwd, "escape.md"));
    for (const href of [
      "中文%20file.md",
      join(cwd, "中文 file.md"),
      `file://${cwd}/%E4%B8%AD%E6%96%87%20file.md`,
    ]) {
      const target = classifyMessageLink(href);
      assert.equal(target.kind, "file");
      if (target.kind === "file") {
        const file = await readWorkspaceFile(
          cwd,
          messageFilePath(target.value, cwd),
        );
        assert.equal(file.text, "visible\n");
      }
    }
    await assert.rejects(
      readWorkspaceFile(cwd, messageFilePath("missing.md", cwd)),
      /ENOENT/u,
    );
    await assert.rejects(
      readWorkspaceFile(cwd, messageFilePath("escape.md", cwd)),
      /outside this workspace/u,
    );
    assert.throws(
      () => messageFilePath("/etc/passwd", cwd),
      /outside this Thread workspace/u,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Browser Host accepts web message URLs and rejects unsafe navigation", () => {
  for (const href of ["https://example.com/a", "http://localhost:8080/"]) {
    const target = classifyMessageLink(href);
    assert.equal(target.kind, "browser");
    if (target.kind === "browser")
      assert.equal(workspaceBrowserUrl(target.value), href);
  }
  assert.throws(
    () => workspaceBrowserUrl("javascript:alert(1)"),
    /HTTP or HTTPS/u,
  );
  assert.throws(
    () => workspaceBrowserUrl("https://user:pass@example.com"),
    /credentials/u,
  );
});

test("bare message URLs shed markdown residue and CJK prose punctuation", () => {
  // Observed failure: a model wrote `**url**（prose…）`; the emphasis fails to
  // pair before full-width punctuation and the autolinker keeps the residue in
  // the href, navigating to a 404.
  const observed = classifyMessageLink(
    "http://127.0.0.1:56277/sales–architecture.html**（刚重启，已验证",
  );
  assert.deepEqual(observed, {
    kind: "browser",
    value: new URL("http://127.0.0.1:56277/sales–architecture.html").toString(),
  });
  const wrapped = classifyMessageLink("https://example.com/a）");
  assert.deepEqual(wrapped, {
    kind: "browser",
    value: "https://example.com/a",
  });
  const emphasized = classifyMessageLink("https://example.com/a**");
  assert.deepEqual(emphasized, {
    kind: "browser",
    value: "https://example.com/a",
  });
  const sentence = classifyMessageLink("https://example.com/a。");
  assert.deepEqual(sentence, {
    kind: "browser",
    value: "https://example.com/a",
  });
  const query = classifyMessageLink("https://example.com/?a=1，下一页");
  assert.deepEqual(query, {
    kind: "browser",
    value: "https://example.com/?a=1",
  });
  // Legitimate targets survive: CJK characters in a path are not punctuation,
  // and CJK punctuation inside a workspace file name stays a file link.
  const cjkPath = classifyMessageLink("http://127.0.0.1:56277/报告.html");
  assert.deepEqual(cjkPath, {
    kind: "browser",
    value: new URL("http://127.0.0.1:56277/报告.html").toString(),
  });
  const file = classifyMessageLink("报告（v2）.md");
  assert.deepEqual(file, { kind: "file", value: "报告（v2）.md" });
});
