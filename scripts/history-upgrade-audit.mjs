#!/usr/bin/env node
// Offline, read-only check. This is not a migration or a second history store.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodeCanonicalItem } from "../dist/src/item.js";
import { Thread } from "../dist/src/thread.js";
import { FileAttachmentStore } from "../dist/src/attachment.js";

const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function regularFile(filename, limit) {
  const info = await lstat(filename);
  if (!info.isFile() || info.size > limit) throw new Error("unsafe_file");
  return readFile(filename);
}

async function directory(filename) {
  if (!(await lstat(filename)).isDirectory())
    throw new Error("unsafe_directory");
}

// Only declared message/media fields are followed, never arbitrary tool JSON.
function attachmentRefs(item) {
  const refs = [];
  for (const parts of [item.content, item.modelContent, item.input]) {
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if ((part.type === "image" || part.type === "audio") && part.attachment) {
        refs.push(part.attachment);
      }
    }
  }
  return refs;
}

export async function auditHistory(journals, attachments) {
  await directory(journals);
  await directory(attachments);
  const store = new FileAttachmentStore(attachments);
  const entries = (await readdir(journals, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name, "en"),
  );
  const report = {
    format: "zen-history-upgrade-audit-v1",
    scope: "offline-selected-journals-and-reachable-attachments",
    exactHistoricalModelInput: "not-proven",
    files: [],
    issues: [],
    legacyTextItems: 0,
    items: 0,
  };
  const refs = new Map();
  let ordinal = 0;
  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl")) continue;
    // No filenames, IDs, raw content or decoder errors in diagnostics.
    ordinal++;
    try {
      if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.jsonl$/u.test(entry.name)) {
        throw new Error("unsafe_file");
      }
      const filename = path.join(journals, entry.name);
      const bytes = await regularFile(filename, MAX_JOURNAL_BYTES);
      const threadId = entry.name.slice(0, -6);
      const items = [];
      for (const line of new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .split("\n")) {
        if (!line) continue;
        const raw = JSON.parse(line);
        const item = decodeCanonicalItem(raw);
        if (item.threadId !== threadId) throw new Error("thread_mismatch");
        if (typeof raw.text === "string" && raw.content === undefined)
          report.legacyTextItems++;
        items.push(item);
        for (const ref of attachmentRefs(item)) {
          // Keep each distinct declaration: equal hashes with inconsistent metadata must fail.
          refs.set(JSON.stringify(ref), ref);
        }
      }
      new Thread(threadId, items);
      if (!(await regularFile(filename, MAX_JOURNAL_BYTES)).equals(bytes))
        throw new Error("changed");
      report.items += items.length;
      report.files.push({
        kind: "journal",
        ordinal,
        byteLength: bytes.length,
        sha256: sha256(bytes),
      });
    } catch {
      report.issues.push({
        kind: "journal_unreadable_invalid_or_changed",
        ordinal,
      });
    }
  }
  if (ordinal === 0) report.issues.push({ kind: "no_journals_selected" });
  for (const ref of refs.values()) {
    try {
      await directory(path.join(attachments, "sha256"));
      await directory(path.join(attachments, "sha256", ref.sha256));
      await regularFile(
        path.join(attachments, "sha256", ref.sha256, "payload"),
        20 * 1024 * 1024,
      );
      const bytes = await store.read(ref);
      report.files.push({
        kind: "attachment",
        byteLength: bytes.length,
        sha256: sha256(bytes),
      });
    } catch {
      report.issues.push({ kind: "attachment_missing_invalid_or_unsafe" });
    }
  }
  report.ok = report.issues.length === 0;
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "--offline") {
    console.error(
      "Usage: node scripts/history-upgrade-audit.mjs --offline JOURNAL_DIRECTORY ATTACHMENT_DIRECTORY\nStop all writers first. Read-only audit; no migration, backup, install or provider call.",
    );
    process.exitCode = 2;
  } else {
    try {
      const report = await auditHistory(
        path.resolve(args[1]),
        path.resolve(args[2]),
      );
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } catch {
      console.error(
        "Audit failed: inaccessible or unsafe input directories. No files modified.",
      );
      process.exitCode = 1;
    }
  }
}
