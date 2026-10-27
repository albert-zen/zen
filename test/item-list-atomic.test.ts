import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FileItemListStore } from "../src/item-list-store.js";
import type { ContextItem } from "../src/item-list.js";
const item = (id: string): ContextItem => ({
  id,
  threadId: "t",
  createdAt: "2026-10-27",
  kind: "message",
  role: "user",
  content: {
    text: "中文 exact",
    parts: [{ type: "text", text: "中文 exact" }],
  },
  source: { kind: "user_message", sequence: 0 },
});
test("semantic append preserves exact prior bytes and rejects duplicate/tail corruption", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-items-"));
  const store = new FileItemListStore(dir);
  await store.create("t", []);
  const original = Buffer.from(" " + JSON.stringify(item("a")) + "\r\n");
  await writeFile(path.join(dir, "t.jsonl"), original);
  await store.append("t", [item("b")]);
  assert.deepEqual(
    (await readFile(path.join(dir, "t.jsonl"))).subarray(0, original.length),
    original,
  );
  await assert.rejects(store.append("t", [item("b")]), /duplicate/);
  await writeFile(path.join(dir, "t.jsonl"), original.subarray(0, -1));
  await assert.rejects(store.append("t", [item("c")]), /tail/);
});
for (const phase of ["temporary", "published", "synced"] as const)
  test(`atomic failure ${phase} exposes complete old or new semantic bytes`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "zen-items-"));
    await new FileItemListStore(dir).create("t", [item("a")]);
    const store = new FileItemListStore(dir, {
      onAppendPhase(p) {
        if (p === phase) throw new Error("injected");
      },
    });
    await assert.rejects(store.append("t", [item("b")]), {
      name: "ThreadJournalAppendOutcomeUnknownError",
    });
    assert.equal(
      (await new FileItemListStore(dir).read("t")).length,
      phase === "temporary" ? 1 : 2,
    );
  });
