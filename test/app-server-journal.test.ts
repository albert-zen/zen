import { mkdtempSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AppServer,
  FileThreadJournal,
  createProviderBackedAppServer,
  type AppServerNotification,
  type ThreadJournal,
  type ThreadJournalReplay
} from "../src/index.js";
import type { Item } from "../src/item-list.js";

describe("AppServer journal commits", () => {
  it("publishes terminal lifecycle only after that thread flushes", async () => {
    const terminalFlush = deferred<void>();
    const journal = new TerminalBarrierJournal(terminalFlush.promise);
    const notifications: AppServerNotification[] = [];
    const server = new AppServer({
      threadJournal: journal,
      threadManagerOptions: {
        generateThreadId: sequence("thread"),
        generateRunId: sequence("run"),
        generateTurnId: sequence("turn"),
        generateItemId: sequence("item"),
        clock: () => 1000,
        runtimeFactory: () => ({ model: { async *generate() { yield { type: "message.completed", content: "done" }; } } })
      }
    });
    server.subscribe((notification) => notifications.push(notification));
    const start = await server.request({ method: "thread/start" });
    if (!start.ok || start.method !== "thread/start") throw new Error("thread start failed");
    await server.request({ method: "turn/start", params: { threadId: start.result.thread.id, input: "go" } });
    await waitFor(() => journal.terminalFlushStarted);
    expect(notifications.some((notification) => notification.type === "turn/completed")).toBe(false);
    terminalFlush.resolve();
    await waitFor(() => notifications.some((notification) => notification.type === "turn/completed"));
  });

  it("returns typed errors for create, append, and terminal flush failures", async () => {
    const createServer = serverWithJournal(new FaultJournal("create"));
    await expect(createServer.request({ method: "thread/start" })).resolves.toMatchObject({ ok: false, error: { code: "PERSISTENCE_FAILURE" } });

    const appendServer = serverWithJournal(new FaultJournal("append"));
    const appendStart = await appendServer.request({ method: "thread/start" });
    if (!appendStart.ok || appendStart.method !== "thread/start") throw new Error("thread start failed");
    await expect(appendServer.request({ method: "turn/start", params: { threadId: appendStart.result.thread.id, input: "go" } })).resolves.toMatchObject({ ok: false, error: { code: "PERSISTENCE_FAILURE" } });
    await expect(appendServer.request({ method: "thread/read", params: { threadId: appendStart.result.thread.id } })).resolves.toMatchObject({ ok: false, error: { code: "PERSISTENCE_FAILURE" } });

    const terminalJournal = new FaultJournal("terminalFlush");
    const terminalServer = serverWithJournal(terminalJournal);
    const terminalStart = await terminalServer.request({ method: "thread/start" });
    if (!terminalStart.ok || terminalStart.method !== "thread/start") throw new Error("thread start failed");
    const notifications: AppServerNotification[] = [];
    terminalServer.subscribe((notification) => notifications.push(notification));
    await terminalServer.request({ method: "turn/start", params: { threadId: terminalStart.result.thread.id, input: "go" } });
    await waitFor(() => terminalJournal.terminalFlushAttempted);
    expect(notifications.some((notification) => notification.type === "turn/completed")).toBe(false);
    await expect(terminalServer.request({ method: "thread/read", params: { threadId: terminalStart.result.thread.id } })).resolves.toMatchObject({ ok: false, error: { code: "PERSISTENCE_FAILURE" } });
  });

  it("lists valid replayed threads and reports a corrupt journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zen-replay-failure-"));
    const journal = new FileThreadJournal({ dir });
    await journal.create("valid", createdItem("valid"));
    await journal.close();
    await appendFile(pathFor(dir, "corrupt"), `${JSON.stringify({ version: 1, item: createdItem("corrupt") })}\nnot-json\n`, "utf8");
    const server = await createProviderBackedAppServer({ threadJournal: new FileThreadJournal({ dir }) });
    await expect(server.request({ method: "thread/list" })).resolves.toMatchObject({
      ok: true,
      result: { threads: [expect.objectContaining({ id: "valid" })], persistenceFailures: [expect.objectContaining({ code: "THREAD_JOURNAL_CORRUPTION", threadId: "corrupt", recordNumber: 2 })] }
    });
    await expect(server.request({ method: "thread/read", params: { threadId: "corrupt" } })).resolves.toMatchObject({ ok: false, error: { code: "THREAD_JOURNAL_CORRUPTION" } });
  });
});

class TerminalBarrierJournal implements ThreadJournal {
  terminalFlushStarted = false;
  private terminalSeen = false;
  constructor(private readonly terminalFlush: Promise<void>) {}
  async create(_threadId: string, _item: Item): Promise<void> {}
  async append(_threadId: string, item: Item): Promise<void> { if (item.type === "turn.completed") this.terminalSeen = true; }
  async flush(_threadId: string): Promise<void> { if (this.terminalSeen) { this.terminalFlushStarted = true; await this.terminalFlush; } }
  async replay(): Promise<readonly ThreadJournalReplay[]> { return []; }
  async close(): Promise<void> {}
}

class FaultJournal implements ThreadJournal {
  terminalFlushAttempted = false;
  private terminalSeen = false;
  constructor(private readonly fault: "create" | "append" | "terminalFlush") {}
  async create(_threadId: string, _item: Item): Promise<void> { if (this.fault === "create") throw new Error("create fault"); }
  async append(_threadId: string, item: Item): Promise<void> { if (this.fault === "append") throw new Error("append fault"); if (item.type === "turn.completed") this.terminalSeen = true; }
  async flush(_threadId: string): Promise<void> { if (this.fault === "terminalFlush" && this.terminalSeen) { this.terminalFlushAttempted = true; throw new Error("terminal flush fault"); } }
  async replay(): Promise<readonly ThreadJournalReplay[]> { return []; }
  async close(): Promise<void> {}
}

function serverWithJournal(journal: ThreadJournal): AppServer {
  return new AppServer({ threadJournal: journal, threadManagerOptions: { generateThreadId: sequence("thread"), generateRunId: sequence("run"), generateTurnId: sequence("turn"), generateItemId: sequence("item"), clock: () => 1000, runtimeFactory: () => ({ model: { async *generate() { yield { type: "message.completed", content: "done" }; } } }) } });
}
function createdItem(threadId: string): Item { return { id: `created-${threadId}`, type: "thread.created", createdAtMs: 1, seq: 1, runId: threadId, turnId: threadId, payload: { threadId } }; }
function pathFor(dir: string, threadId: string): string { return join(dir, `thread-${Buffer.from(threadId).toString("base64url")}.jsonl`); }

function sequence(prefix: string): () => string { let value = 0; return () => `${prefix}-${++value}`; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; }); return { promise, resolve }; }
async function waitFor(predicate: () => boolean): Promise<void> { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); } throw new Error("timed out"); }
