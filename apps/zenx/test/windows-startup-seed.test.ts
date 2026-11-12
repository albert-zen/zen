import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedStartupThread } from "../scripts/seed-windows-startup-thread.js";
import { createHostedAppServer } from "../../cli/src/host.js";

test("startup seed is real durable synthetic history and refuses existing data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-startup-seed-"));
  const directory = path.join(root, "data");
  const receiptPath = path.join(root, "seed.json");
  try {
    const seed = await seedStartupThread(directory, receiptPath);
    assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), seed);
    const host = createHostedAppServer({
      cwd: directory,
      dataDirectory: directory,
      provider: { type: "fake" },
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      toolPresentation: "direct",
    });
    try {
      const summaries = await host.listThreadSummaries({ archived: false });
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0]?.threadId, seed.threadId);
      assert.equal(summaries[0]?.name, seed.title);
      const thread = await host.readThread(seed.threadId);
      assert.equal(thread.turns.at(-1)?.status, "completed");
      assert(
        thread.items.some(
          (item) => item.id === seed.userItemId && item.type === "user_message",
        ),
      );
      assert(
        thread.items.some(
          (item) =>
            item.id === seed.agentItemId &&
            item.type === "agent_message" &&
            item.text === seed.agentText,
        ),
      );
      await assert.rejects(
        seedStartupThread(directory, path.join(root, "other.json")),
        /EEXIST/u,
      );
    } finally {
      await host.closeHostResources();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
