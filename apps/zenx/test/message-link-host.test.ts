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
