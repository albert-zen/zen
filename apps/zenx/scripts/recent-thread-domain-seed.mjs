import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainThreadJournal } from "../../../dist/src/domain-journal.js";
import { FileTraceStore } from "../../../dist/src/trace.js";
import { JsonlThreadMetadataStore } from "../../../dist/src/thread-metadata.js";

export async function seedRecentThreads({ isolationRoot, dataDirectory, workspace, providerProfileId, modelId }) {
  const root = await realpath(isolationRoot);
  for (const candidate of [dataDirectory, workspace]) {
    const relative = path.relative(root, await realpath(candidate));
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }
  const trace = new FileTraceStore(path.join(dataDirectory, "trace"));
  const metadata = new JsonlThreadMetadataStore(path.join(dataDirectory, "thread-metadata.jsonl"));
  const journal = new DomainThreadJournal({ directory: path.join(dataDirectory, "threads"), trace, metadata });
  const selection = { providerProfileId, modelId, reasoningEffort: "medium" };
  const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
  const threadIds = ["recent-a", "recent-b", "recent-c"];
  try {
    for (const [index, threadId] of threadIds.entries()) {
      const turnId = threadId + "-old-turn", common = { threadId, turnId };
      const facts = [
        { id: threadId + "-metadata", threadId, createdAt: at(0), type: "thread_metadata", cwd: workspace, ...selection, sandbox: "danger-full-access", approvalPolicy: "never" },
        { ...common, id: turnId + "-started", createdAt: at(index * 10 + 1), type: "turn_started", selection },
        { ...common, id: turnId + "-user", createdAt: at(index * 10 + 2), type: "user_message", clientId: threadId + "-old-client", content: [{ type: "text", text: "Synthetic earlier request " + threadId }] },
        { ...common, id: turnId + "-agent", createdAt: at(index * 10 + 3), type: "agent_message", text: "Synthetic accepted final " + threadId },
        { ...common, id: turnId + "-completed", createdAt: at(index * 10 + 4), type: "turn_completed", status: "completed" },
      ];
      // A recent metadata observation is deliberately not a human/final message.
      if (threadId === "recent-a") facts.push({
        threadId, id: "recent-a-instruction", createdAt: at(1000),
        type: "thread_instruction", text: "Synthetic non-message Host instruction for Recent ordering fixture.",
      });
      await journal.create(facts);
      await metadata.setName(threadId, "Synthetic Recent " + threadId.slice(-1).toUpperCase());
    }
  } finally { await journal.close(); await trace.flush(); }
  const manifest = { synthetic: true, threadIds, initialRecentOrder: [...threadIds].reverse(), storage: "production DomainThreadJournal", threadId: threadIds[0], completedTurnCount: 3, visibleMessageCount: 6 };
  await writeFile(path.join(isolationRoot, "seed-manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function verifyRecentThreads({ dataDirectory, threadIds, receipts, events }) {
  const trace = new FileTraceStore(path.join(dataDirectory, "trace"));
  const journal = new DomainThreadJournal({
    directory: path.join(dataDirectory, "threads"), trace,
    metadata: new JsonlThreadMetadataStore(path.join(dataDirectory, "thread-metadata.jsonl")),
    access: "read-only",
  });
  const results = [];
  try {
    for (const threadId of threadIds) {
      const facts = await journal.read(threadId);
      const user = facts.filter(item => item.type === "user_message");
      assert.equal(user.length, threadId === "recent-c" ? 1 : 2);
      assert.equal(facts.filter(item => item.type === "turn_completed" && item.status === "completed").length, user.length);
      assert.equal(facts.filter(item => item.type.includes("compact")).length, 0);
      const observed = await trace.read(threadId, { verifyArtifacts: false });
      assert.equal(observed.completeness, "complete");
      assert.equal(observed.records.filter(record => ["context_compaction_started", "context_compaction_sample", "context_compaction_finished"].includes(record.type)).length, 0);
      const sends = receipts.filter(receipt => receipt.threadId === threadId);
      assert.equal(sends.length, threadId === "recent-c" ? 0 : 1);
      for (const send of sends) {
        const delivered = user.filter(item => item.clientId === send.clientUserMessageId);
        assert.equal(delivered.length, 1, "Exactly one canonical user message per actual IPC client identity");
        assert.equal(delivered[0].turnId, send.receipt.turnId);
        const observations = events.filter(event => event.threadId === threadId && event.type === "user_message" && event.clientId === send.clientUserMessageId);
        assert(observations.length > 0 && observations.every(event => event.id === delivered[0].id));
        const terminal = facts.filter(item => item.type === "turn_completed" && item.turnId === send.receipt.turnId && item.status === "completed");
        assert.equal(terminal.length, 1, "Exact admitted Turn, not an idle-before-start false positive");
        const semantic = await journal.readItemList(threadId);
        assert.equal(semantic.filter(item => item.id === delivered[0].id).length, 1);
      }
      if (threadId === "recent-a") assert(facts.some(item => item.type === "tool_call" && item.turnId === sends[0].receipt.turnId) && facts.some(item => item.type === "tool_result" && item.turnId === sends[0].receipt.turnId));
      results.push({ threadId, users: user.length, acceptedFinals: user.length, actualToolTurn: threadId === "recent-a" });
    }
    return { independentReopen: true, traceCompleteness: "complete", compactionAttempts: 0, matchedNewMessages: receipts.length, results };
  } finally { await journal.close(); await trace.flush(); }
}
