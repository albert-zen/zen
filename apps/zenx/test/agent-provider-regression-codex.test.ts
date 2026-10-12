import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAgentAdapter } from "../src/main/agent-providers/codex-adapter.js";
test("completed Codex webSearch preserves query and terminal truth", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "astra-codex-projection-"));
  const peer = path.join(dir, "peer.cjs");
  const text = await readFile(
    new URL("./fixtures/codex-app-server-peer.cjs", import.meta.url),
    "utf8",
  );
  const injected = text.replace(
    "let turns = [];",
    `let turns = [{ id: 'turn-search', status: 'completed', itemsView:'full', items: [{type:'webSearch',id:'search-1',query:'review fixture search',action:{type:'search',query:'review fixture search',queries:null},results:[]}] }];`,
  );
  assert.notEqual(injected, text);
  await writeFile(peer, injected);
  const a = new CodexAgentAdapter({
    binaryPath: process.execPath,
    args: [peer],
    env: { PEER_SCENARIO: "" },
  });
  t.after(async () => {
    await a.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const result = await a.read("native-thread");
  const item = result.thread.turns[0]!.items[0]!;
  assert.notEqual(
    (item as any).status,
    "inProgress",
    "terminal native search must not become running",
  );
  assert.match(
    JSON.stringify(item),
    /review fixture search/,
    "show available native query",
  );
});
