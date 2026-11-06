import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("cache pressure and GC preserve an active Turn and its queued input", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--expose-gc",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { ZenAppServer } from ${JSON.stringify(new URL("../src/app-server.js", import.meta.url).href)};
    import { InMemoryThreadJournal } from ${JSON.stringify(new URL("../src/journal.js", import.meta.url).href)};
    import { AgentRuntime } from ${JSON.stringify(new URL("../src/runtime.js", import.meta.url).href)};
    import { ToolEnvironment } from ${JSON.stringify(new URL("../src/tool.js", import.meta.url).href)};
    import { ProviderRegistry } from ${JSON.stringify(new URL("../src/provider-registry.js", import.meta.url).href)};
    import { StaticModelCatalog } from ${JSON.stringify(new URL("../src/model-catalog.js", import.meta.url).href)};
    import { InMemoryThreadMetadataStore } from ${JSON.stringify(new URL("../src/thread-metadata.js", import.meta.url).href)};
    const journal = new InMemoryThreadJournal();
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let samples = 0;
    const model = { provider: 'fake', async *stream() {
      samples++;
      if (samples === 1) { entered(); await gate; }
      yield { type: 'text_delta', delta: 'preserved output' };
    }};
    const server = new ZenAppServer({ journal,
      runtime: new AgentRuntime({ toolEnvironment: new ToolEnvironment({ runtimes: [] }) }),
      providerRegistry: new ProviderRegistry([{ providerProfileId: 'fake', adapter: model,
        modelCatalog: new StaticModelCatalog([{ id: 'fake', isDefault: true, contextWindow: 32768 }]) }]),
      threadMetadata: new InMemoryThreadMetadataStore(),
      defaults: { cwd: '/tmp', providerProfileId: 'fake', modelId: 'fake', reasoningEffort: "medium",
        sandbox: 'read-only', approvalPolicy: 'never' }
    });
    const first = await server.startThread();
    const handle = await server.startTurn(first.id, 'first');
    await ready;
    await server.queueMessage(first.id, [{type:'text', text:'queued next'}], 'queued-next', {waitForTurnAdmission:false});
    for (let i = 0; i < 32; i++) await server.startThread();
    for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 0)); global.gc(); }
    assert.equal((await server.readThread(first.id)).turns[0].status, 'inProgress');
    release();
    await handle.done;
    for (let i = 0; i < 200; i++) {
      const view = await server.readThread(first.id);
      if (view.turns.length === 2 && view.turns.every(turn => turn.status === 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const view = await server.readThread(first.id);
    assert.equal(view.turns.length, 2);
    assert.ok(view.turns.every(turn => turn.status === 'completed'));
    assert.equal(view.items.filter(item => item.type === 'agent_message' && item.text === 'preserved output').length, 2);
    assert.equal(view.items.filter(item => item.type === 'user_message' && item.clientId === 'queued-next').length, 1);
    const windowBefore = await server.readThreadHistory(first.id, {limit: 1});
    assert.equal(windowBefore.turns.length, 1);
    assert.equal(windowBefore.itemList, undefined);
    assert.ok(windowBefore.history.before);
    for (let i = 0; i < 32; i++) await server.startThread();
    for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 0)); global.gc(); }
    const windowAfter = await server.readThreadHistory(first.id, {limit: 1});
    assert.deepEqual(windowAfter.turns, windowBefore.turns);
    assert.deepEqual(windowAfter.history, windowBefore.history);
    const earlier = await server.readThreadHistory(first.id, {limit: 1, before: windowBefore.history.before});
    assert.equal(earlier.turns.length, 1);
    assert.equal(earlier.turns[0].id, handle.id);
    assert.equal((await server.readThread(first.id)).turns.length, 2);
    await server.closeRuntimeConfiguration();
  `,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
