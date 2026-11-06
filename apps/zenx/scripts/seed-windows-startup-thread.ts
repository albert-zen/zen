import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHostedAppServer } from "../../cli/src/host.js";

/** Fresh synthetic data only; never reads a user's profile or calls a remote model. */
export async function seedStartupThread(
  directory: string,
  receiptPath: string,
) {
  await mkdir(directory, { recursive: false });
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
    const title = "Startup acceptance thread";
    const text = "Synthetic startup history is readable";
    const thread = await host.startThread();
    await host.setThreadName(thread.id, title);
    await (
      await host.startTurn(thread.id, text)
    ).done;
    const snapshot = await host.readThread(thread.id);
    assert.equal(snapshot.turns.at(-1)?.status, "completed");
    const user = snapshot.items.find((item) => item.type === "user_message");
    const agent = snapshot.items.find((item) => item.type === "agent_message");
    assert(user && agent?.type === "agent_message");
    assert(agent.text.startsWith("Echo: ") && agent.text.endsWith(text));
    assert(await host.flushThreadSummaryProjection());
    const receipt = {
      synthetic: true,
      threadId: thread.id,
      title,
      userItemId: user.id,
      agentItemId: agent.id,
      userText: text,
      agentText: agent.text,
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2), {
      flag: "wx",
    });
    return receipt;
  } finally {
    await host.closeHostResources();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [directory, receipt] = process.argv.slice(2);
  if (!directory || !receipt)
    throw new Error("Expected fresh synthetic data directory and receipt path");
  await seedStartupThread(directory, receipt);
}
