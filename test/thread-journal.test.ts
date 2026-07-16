import { mkdtempSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileThreadJournal, ThreadJournalCorruptionError, ThreadJournalError, type ThreadJournalFileSystem } from "../src/index.js";
import type { Item } from "../src/item-list.js";

describe("FileThreadJournal", () => {
  it("durably creates and replays a versioned Item journal", async () => {
    const dir = tempDir();
    const journal = new FileThreadJournal({ dir });
    await journal.create("thread/a", created("thread/a"));
    await journal.append("thread/a", item("user.message.completed", "thread/a", 2));
    await journal.flush("thread/a");
    await journal.close();

    const [replay] = await new FileThreadJournal({ dir }).replay();
    expect(replay).toEqual(expect.objectContaining({ type: "success", threadId: "thread/a", items: [expect.objectContaining({ type: "thread.created" }), expect.objectContaining({ type: "user.message.completed" })] }));
    const text = await readFile(journalPath(dir, "thread/a"), "utf8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(JSON.parse(text.split("\n")[0] ?? "")).toMatchObject({ version: 1, item: { type: "thread.created" } });
  });

  it("uses collision-free reversible filenames", async () => {
    const dir = tempDir();
    const journal = new FileThreadJournal({ dir });
    await journal.create("a/b", created("a/b"));
    await journal.create("a?b", created("a?b"));
    await journal.close();
    expect(journalPath(dir, "a/b")).not.toBe(journalPath(dir, "a?b"));
    const replay = await new FileThreadJournal({ dir }).replay();
    expect(replay.filter((result) => result.type === "success").map((result) => result.threadId).sort()).toEqual(["a/b", "a?b"]);
  });

  it("keeps separate thread queues independent", async () => {
    const dir = tempDir();
    const barrier = deferred<void>();
    let delayed = false;
    const fs = slowFileSystem("slow", barrier, () => { delayed = true; });
    const journal = new FileThreadJournal({ dir, fileSystem: fs });
    const slowCreate = journal.create("slow", created("slow"));
    await waitFor(() => delayed);
    await expect(journal.create("fast", created("fast"))).resolves.toBeUndefined();
    barrier.resolve();
    await slowCreate;
    await journal.close();
  });

  it("makes write failures sticky without stopping other threads and aggregates close", async () => {
    const dir = tempDir();
    const fs = failingFileSystem("broken");
    const journal = new FileThreadJournal({ dir, fileSystem: fs });
    await expect(journal.create("broken", created("broken"))).rejects.toBeInstanceOf(ThreadJournalError);
    await expect(journal.append("broken", item("user.message.completed", "broken", 2))).rejects.toBeInstanceOf(ThreadJournalError);
    await expect(journal.create("healthy", created("healthy"))).resolves.toBeUndefined();
    await expect(journal.close()).rejects.toBeInstanceOf(AggregateError);
    const replay = await new FileThreadJournal({ dir }).replay();
    expect(replay).toEqual([expect.objectContaining({ type: "success", threadId: "healthy" })]);
  });

  it("recovers a truncated final record and surfaces interior corruption while retaining valid threads", async () => {
    const dir = tempDir();
    const journal = new FileThreadJournal({ dir });
    await journal.create("recover", created("recover"));
    await journal.close();
    await appendFile(journalPath(dir, "recover"), '{"version":1,"item":', "utf8");
    await writeFile(journalPath(dir, "corrupt"), `${JSON.stringify({ version: 1, item: created("corrupt") })}\nnot-json\n`, "utf8");
    await writeFile(journalPath(dir, "valid"), `${JSON.stringify({ version: 1, item: created("valid") })}\n`, "utf8");
    const outcomes = await new FileThreadJournal({ dir }).replay();
    expect(outcomes.filter((outcome) => outcome.type === "success").map((outcome) => outcome.threadId).sort()).toEqual(["recover", "valid"]);
    const failure = outcomes.find((outcome) => outcome.type === "failure");
    expect(failure?.error).toBeInstanceOf(ThreadJournalCorruptionError);
    expect(failure?.error.recordNumber).toBe(2);
    expect((await readFile(journalPath(dir, "recover"), "utf8")).endsWith("\n")).toBe(true);
  });

  it("writes 500 deltas as 501 linear records and bytes", async () => {
    const dir = tempDir();
    const journal = new FileThreadJournal({ dir });
    await journal.create("bulk", created("bulk"));
    for (let index = 0; index < 500; index += 1) await journal.append("bulk", item("assistant.message.delta", "bulk", index + 2, { content: "x".repeat(32) }));
    await journal.close();
    const text = await readFile(journalPath(dir, "bulk"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(501);
    expect(Buffer.byteLength(text)).toBeLessThan(500 * 300);
  });

  it("replays exact multibyte content after injected short writes", async () => {
    const dir = tempDir();
    const journal = new FileThreadJournal({ dir, fileSystem: shortWriteFileSystem() });
    await journal.create("unicode", created("unicode"));
    await journal.append("unicode", item("assistant.message.completed", "unicode", 2, { content: "你好, durable journal" }));
    await journal.close();
    const [result] = await new FileThreadJournal({ dir }).replay();
    expect(result).toMatchObject({ type: "success", threadId: "unicode", items: [expect.anything(), expect.objectContaining({ payload: { content: "你好, durable journal" } })] });
  });
});

function created(threadId: string): Item { return item("thread.created", threadId, 1, { threadId }); }
function item(type: string, threadId: string, seq: number, payload: unknown = {}): Item { return { id: `${threadId}-${seq}`, type, createdAtMs: seq, seq, runId: threadId, turnId: threadId, payload }; }
function tempDir(): string { return mkdtempSync(join(tmpdir(), "zen-journal-")); }
function journalPath(dir: string, id: string): string { return join(dir, `thread-${Buffer.from(id).toString("base64url")}.jsonl`); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; }); return { promise, resolve }; }
async function waitFor(predicate: () => boolean): Promise<void> { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); } throw new Error("timed out"); }
function slowFileSystem(threadId: string, barrier: ReturnType<typeof deferred<void>>, started: () => void): ThreadJournalFileSystem {
  const fs = actualFileSystem();
  return { ...fs, async open(path, flags) { const handle = await fs.open(path, flags); if (path.endsWith(`thread-${Buffer.from(threadId).toString("base64url")}.jsonl`) && flags === "wx") return { write: async (buffer: Buffer, position?: number | null) => { started(); await barrier.promise; return await handle.write(buffer, position); }, sync: () => handle.sync(), close: () => handle.close(), truncate: (length) => handle.truncate(length) }; return handle; } };
}
function failingFileSystem(threadId: string): ThreadJournalFileSystem {
  const fs = actualFileSystem();
  return { ...fs, async open(path, flags) { if (path.endsWith(`thread-${Buffer.from(threadId).toString("base64url")}.jsonl`)) throw new Error("injected write failure"); return await fs.open(path, flags); } };
}
function shortWriteFileSystem(): ThreadJournalFileSystem {
  const fs = actualFileSystem();
  return { ...fs, async open(path, flags) { const handle = await fs.open(path, flags); if (flags === "wx" || flags === "a") return { write: async (buffer: Buffer, position?: number | null) => await handle.write(buffer.subarray(0, Math.min(2, buffer.byteLength)), position), sync: () => handle.sync(), close: () => handle.close(), truncate: (length) => handle.truncate(length) }; return handle; } };
}
function actualFileSystem(): ThreadJournalFileSystem {
  return {
    mkdir: async (path, options) => await (await import("node:fs/promises")).mkdir(path, options),
    readdir: async (path, options) => await (await import("node:fs/promises")).readdir(path, options),
    readFile: async (path, encoding) => await (await import("node:fs/promises")).readFile(path, encoding),
    open: async (path, flags) => await (await import("node:fs/promises")).open(path, flags)
  };
}
