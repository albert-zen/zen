#!/usr/bin/env node
// Run using node --import tsx. Explicit offline CLI; no model/provider/tool calls.
import path from "node:path";
import { DomainThreadJournal } from "../src/domain-journal.ts";
import { FileTraceStore } from "../src/trace.ts";
import { FileAttachmentStore } from "../src/attachment.ts";
import { JsonlThreadMetadataStore } from "../src/thread-metadata.ts";
const args = process.argv.slice(2);
if (!args.includes("--offline"))
  throw new Error(
    "Stop all old/new writers first and pass --offline; this command never stops an app for you",
  );
const at = args.indexOf("--data-directory");
if (at < 0 || !args[at + 1] || args[at + 1].startsWith("--"))
  throw new Error("Required: --data-directory PATH --offline [--apply]");
const directory = path.resolve(args[at + 1]);
const options = {
  directory: path.join(directory, "threads"),
  trace: new FileTraceStore(path.join(directory, "trace")),
  metadata: new JsonlThreadMetadataStore(
    path.join(directory, "thread-metadata.jsonl"),
  ),
  attachments: new FileAttachmentStore(path.join(directory, "attachments")),
};
const reader = new DomainThreadJournal({ ...options, access: "read-only" });
const ids = await reader.listThreadIds();
// Full selected archive preflight precedes the first cutover mutation.
const reports = [];
for (const id of ids) reports.push(await reader.preflight(id));
await reader.close();
if (args.includes("--apply")) {
  const writer = new DomainThreadJournal(options);
  try {
    for (const report of reports)
      if (report.status === "legacy") await writer.migrate(report.threadId);
  } finally {
    await writer.close();
  }
}
console.log(
  JSON.stringify(
    {
      mode: args.includes("--apply") ? "applied" : "read-only-preflight",
      threads: reports,
    },
    null,
    2,
  ),
);
