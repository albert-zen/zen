import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { FileAttachmentStore } from "../src/attachment.js";

import { png1x1 } from "./fixtures.js";

const run = promisify(execFile);
const script = path.resolve("scripts/history-upgrade-audit.mjs");
const createdAt = "2026-10-01T00:00:00.000Z";
const base = (type: string, id: string) => ({
  type,
  id,
  threadId: "legacy",
  createdAt,
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-upgrade-synthetic-"));
  const journals = path.join(root, "journals");
  const attachments = path.join(root, "attachments");
  await mkdir(journals);
  await mkdir(attachments);
  const ref = await new FileAttachmentStore(attachments).importBytes(
    png1x1(),
    "image/png",
  );
  const items = [
    {
      ...base("thread_metadata", "metadata"),
      cwd: "/synthetic",
      provider: "test",
      model: "test",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    { ...base("turn_started", "started"), turnId: "turn" },
    {
      ...base("user_message", "legacy-user"),
      turnId: "turn",
      text: "Synthetic legacy 中文 — no fabricated received_at",
    },
    {
      ...base("user_message", "media-user"),
      turnId: "turn",
      content: [
        { type: "text", text: "Synthetic image" },
        { type: "image", attachment: ref },
      ],
    },
    {
      ...base("agent_message", "agent"),
      turnId: "turn",
      text: "Synthetic response",
    },
    {
      ...base("turn_completed", "completed"),
      turnId: "turn",
      status: "completed",
    },
  ];
  // Preserve unusual whitespace/CRLF; audits and backup restore must not normalize it.
  const bytes =
    items.map((item) => JSON.stringify(item, null, 0)).join("\r\n") + "\r\n";
  await writeFile(path.join(journals, "legacy.jsonl"), bytes);
  return { root, journals, attachments, ref, bytes };
}

async function audit(journals: string, attachments: string) {
  const result = await run(process.execPath, [
    script,
    "--offline",
    journals,
    attachments,
  ]);
  return JSON.parse(result.stdout) as {
    ok: boolean;
    items: number;
    exactHistoricalModelInput: string;
    files: unknown[];
    legacyTextItems: number;
  };
}

test("offline legacy read and synthetic backup/restore preserve bytes and reachable media", async () => {
  const f = await fixture();
  try {
    const before = await audit(f.journals, f.attachments);
    assert.equal(before.ok, true);
    assert.equal(before.items, 6);
    assert.equal(before.exactHistoricalModelInput, "not-proven");
    assert.equal(before.files.length, 2);
    assert.equal(before.legacyTextItems, 2);
    const backup = path.join(f.root, "backup");
    const restore = path.join(f.root, "restore");
    // Only these freshly generated fixture directories are copied, never real user data.
    await mkdir(backup);
    await cp(f.journals, path.join(backup, "journals"), { recursive: true });
    await cp(f.attachments, path.join(backup, "attachments"), {
      recursive: true,
    });
    await cp(backup, restore, { recursive: true });
    assert.deepEqual(
      await audit(
        path.join(restore, "journals"),
        path.join(restore, "attachments"),
      ),
      before,
    );
    assert.equal(
      await readFile(path.join(f.journals, "legacy.jsonl"), "utf8"),
      f.bytes,
    );
    assert.equal(
      await readFile(path.join(restore, "journals", "legacy.jsonl"), "utf8"),
      f.bytes,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("audit fails closed on missing media, invalid history and symlinks without leaking message text", async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.attachments, "sha256", f.ref.sha256, "payload"));
    await assert.rejects(audit(f.journals, f.attachments), (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error);
      assert.match(
        String(error.stdout),
        /attachment_missing_invalid_or_unsafe/u,
      );
      assert.doesNotMatch(String(error.stdout), /Synthetic legacy/u);
      return true;
    });
    await writeFile(
      path.join(f.journals, "legacy.jsonl"),
      '{"secret":"PRIVATE_FIXTURE_TEXT"}\n',
    );
    await assert.rejects(audit(f.journals, f.attachments), (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error);
      assert.match(
        String(error.stdout),
        /journal_unreadable_invalid_or_changed/u,
      );
      assert.doesNotMatch(String(error.stdout), /PRIVATE_FIXTURE_TEXT/u);
      return true;
    });
    await rm(path.join(f.journals, "legacy.jsonl"));
    await writeFile(path.join(f.root, "source"), f.bytes);
    await symlink(
      path.join(f.root, "source"),
      path.join(f.journals, "legacy.jsonl"),
    );
    await assert.rejects(audit(f.journals, f.attachments));
    assert.equal(await readFile(path.join(f.root, "source"), "utf8"), f.bytes);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("audit rejects empty selection and requires explicit offline invocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-upgrade-empty-"));
  try {
    await assert.rejects(audit(root, root));
    await assert.rejects(run(process.execPath, [script, root, root]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit blocks unknown future Item types and corrupt reachable attachment bytes", async () => {
  const f = await fixture();
  try {
    const filename = path.join(f.journals, "legacy.jsonl");
    await writeFile(
      filename,
      f.bytes + JSON.stringify(base("future_unknown_item", "future")) + "\n",
    );
    await assert.rejects(audit(f.journals, f.attachments));
    assert.equal(
      await readFile(filename, "utf8"),
      f.bytes + JSON.stringify(base("future_unknown_item", "future")) + "\n",
    );
    await writeFile(filename, f.bytes);
    const payload = path.join(f.attachments, "sha256", f.ref.sha256, "payload");
    await rm(payload);
    await writeFile(payload, "corrupt synthetic payload");
    await assert.rejects(audit(f.journals, f.attachments));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
