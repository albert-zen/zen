import { open } from "node:fs/promises";
import path from "node:path";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileTraceStore } from "../src/trace.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
const root = process.argv[2]!;
let armed = false;
const journal = new DomainThreadJournal({
  directory: path.join(root, "threads"),
  trace: new FileTraceStore(path.join(root, "trace")),
  metadata: new InMemoryThreadMetadataStore(),
  onItemListAppendPhase(phase) {
    if (armed && phase === "temporary") process.exit(91);
  },
});
await journal.append({
  id: "m",
  threadId: "t",
  createdAt: "2026-10-27",
  type: "thread_metadata",
  cwd: root,
  provider: "p",
  model: "m",
  sandbox: "read-only",
  approvalPolicy: "always",
});
await journal.append({
  id: "call",
  threadId: "t",
  turnId: "turn",
  createdAt: "2026-10-27",
  type: "tool_call",
  callId: "c",
  name: "synthetic_effect",
  arguments: {},
});
const effect = await open(path.join(root, "effect-count"), "wx");
await effect.writeFile("1");
await effect.sync();
await effect.close();
armed = true;
await journal.append({
  id: "result",
  threadId: "t",
  turnId: "turn",
  createdAt: "2026-10-27",
  type: "tool_result",
  callId: "c",
  output: "accepted exact effect result 中文",
  exitCode: 0,
});
throw new Error("Crash hook not reached");
