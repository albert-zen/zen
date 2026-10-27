#!/usr/bin/env node
// Synthetic-only audit of the real old public ZenAppServer.startTurn path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DomainThreadJournal } from "../src/domain-journal.ts";
import { FileTraceStore } from "../src/trace.ts";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.ts";
const at = process.argv.indexOf("--old-checkout");
if (at < 0) throw new Error("Required --old-checkout clean-public-baseline");
const old = path.resolve(process.argv[at + 1]);
const git = (...args) =>
  spawnSync("git", ["-C", old, ...args], { encoding: "utf8" });
assert.equal(
  git("rev-parse", "HEAD").stdout.trim(),
  "81ff10d5fee65c76703d5c46a3f77641d29e2970",
);
assert.equal(git("status", "--porcelain").stdout.trim(), "");
const root = await mkdtemp(path.join(os.tmpdir(), "zen-old-host-fence-"));
const journal = new DomainThreadJournal({
  directory: path.join(root, "threads"),
  trace: new FileTraceStore(path.join(root, "trace")),
  metadata: new InMemoryThreadMetadataStore(),
});
await journal.append({
  id: "meta",
  threadId: "t",
  createdAt: "2026-10-27",
  type: "thread_metadata",
  cwd: root,
  provider: "fake",
  model: "fake",
  sandbox: "read-only",
  approvalPolicy: "always",
});
await journal.close();
async function hashes(directory, prefix = "") {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory())
      Object.assign(
        result,
        await hashes(path.join(directory, entry.name), name),
      );
    else
      result[name] = createHash("sha256")
        .update(await readFile(path.join(directory, entry.name)))
        .digest("hex");
  }
  return result;
}
const before = await hashes(root);
const loader = fileURLToPath(
  new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
);
const source = (relative) => pathToFileURL(path.join(old, relative)).href;
const childSource = `import {ZenAppServer} from ${JSON.stringify(source("src/app-server.ts"))};import {AgentRuntime} from ${JSON.stringify(source("src/runtime.ts"))};import {JsonlThreadJournal} from ${JSON.stringify(source("src/journal.ts"))};import {InMemoryThreadMetadataStore} from ${JSON.stringify(source("src/thread-metadata.ts"))};import {ToolEnvironment} from ${JSON.stringify(source("src/tool.ts"))};import {ProviderRegistry} from ${JSON.stringify(source("src/provider-registry.ts"))};import {StaticModelCatalog} from ${JSON.stringify(source("src/model-catalog.ts"))};let calls=0;const adapter={provider:'fake',async *stream(){calls++;throw new Error('must not reach model');}};const app=new ZenAppServer({journal:new JsonlThreadJournal(${JSON.stringify(path.join(root, "threads"))}),runtime:new AgentRuntime({toolEnvironment:new ToolEnvironment({runtimes:[]})}),providerRegistry:new ProviderRegistry([{providerProfileId:'fake',adapter,modelCatalog:new StaticModelCatalog([{id:'fake',contextWindow:32768,isDefault:true}])}]),threadMetadata:new InMemoryThreadMetadataStore(),defaults:{cwd:${JSON.stringify(root)},providerProfileId:'fake',modelId:'fake',reasoningEffort:'medium',sandbox:'read-only',approvalPolicy:'always'}});try{await app.startTurn('t','must reject before write');process.exitCode=4;}catch(error){if(!/canonical|type|Item|format/i.test(String(error)))throw error;console.log(JSON.stringify({rejected:true,modelCalls:calls}));if(calls)process.exitCode=5;}`;
const result = spawnSync(
  process.execPath,
  ["--import", loader, "--input-type=module", "-e", childSource],
  { encoding: "utf8" },
);
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(await hashes(root), before);
console.log(
  JSON.stringify({
    oldCommit: git("rev-parse", "HEAD").stdout.trim(),
    filesUnchanged: Object.keys(before).length,
    child: JSON.parse(result.stdout),
  }),
);
