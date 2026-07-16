import { describe, expect, it } from "vitest";
import {
  AppServer,
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

function sequence(prefix: string): () => string { let value = 0; return () => `${prefix}-${++value}`; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; }); return { promise, resolve }; }
async function waitFor(predicate: () => boolean): Promise<void> { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); } throw new Error("timed out"); }
