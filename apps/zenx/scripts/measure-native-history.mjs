/** Explicit synthetic Host and Chromium boundaries. Requires npm run build + existing Chromium. */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { build } from "vite";
import { createHostedAppServer } from "../../../dist/apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../../../dist/src/journal.js";
import { NativeRecoveryProjection } from "../../../dist/src/protocol/native/recovery.js";
import { historyWindowFixture } from "../../../dist/test/thread-history-window-fixture.js";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const root = path.resolve(import.meta.dirname, "../../..");
const output = path.resolve(
  process.argv[2] ?? "/tmp/native-history-712-evidence",
);
await mkdir(output, { recursive: true });
const report = {
  sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  scope:
    "Synthetic production Host resume/JSON and browser ThreadView with real page JSON over localhost. Excludes Electron/App startup, real user data, Provider execution and native RSS.",
  host: [],
  renderer: [],
  checks: {},
};
const manifest = {};
const stats = (samples) => {
  const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  return {
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms:
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    samples,
  };
};
const persist = () =>
  writeFile(
    path.join(output, "measurements.json"),
    JSON.stringify(report, null, 2),
  );
for (const count of [256, 1200]) {
  const cold = [],
    reopen = [],
    switched = [];
  for (let iteration = 0; iteration < 5; iteration++) {
    const journal = new InMemoryThreadJournal();
    const mainId = `thread-${count}`;
    const otherId = `other-${count}`;
    for (const name of [mainId, otherId])
      await journal.create(
        historyWindowFixture(count).map((item) => ({
          ...item,
          threadId: name,
        })),
      );
    const host = createHostedAppServer({
      cwd: root,
      dataDirectory: "/tmp/unused-native-history-benchmark",
      model: "fake",
      models: ["fake"],
      provider: { type: "fake" },
      journal,
      approvalPolicy: "never",
    });
    const recovery = new NativeRecoveryProjection(host);
    const measure = async (id) => {
      global.gc?.();
      const baseline = process.memoryUsage().heapUsed;
      const start = performance.now();
      const snapshot = await recovery.resume(id, true);
      const json = JSON.stringify(snapshot);
      const ms = performance.now() - start;
      const sampledPeak = process.memoryUsage().heapUsed;
      const bytes = Buffer.byteLength(json);
      return {
        ms,
        bytes,
        baselineHeapBytes: baseline,
        sampledPeakHeapBytes: sampledPeak,
      };
    };
    try {
      const first = await measure(mainId);
      global.gc?.();
      first.idleHeapBytes = process.memoryUsage().heapUsed;
      cold.push(first);
      const second = await measure(mainId);
      global.gc?.();
      second.idleHeapBytes = process.memoryUsage().heapUsed;
      reopen.push(second);
      const other = await measure(otherId);
      global.gc?.();
      other.idleHeapBytes = process.memoryUsage().heapUsed;
      switched.push(other);
      if (iteration === 0) {
        const initial = await recovery.resume(mainId, true);
        await writeFile(
          path.join(output, `history-${count}-initial.html`),
          JSON.stringify(initial),
        );
        const pages = {};
        let before = initial.thread.history.before;
        let page = 0;
        while (before) {
          const snapshot = await recovery.history(mainId, { before });
          const file = `history-${count}-${page++}.html`;
          pages[before] = "/" + file;
          await writeFile(path.join(output, file), JSON.stringify(snapshot));
          before = snapshot.history.before;
        }
        manifest[String(count)] = {
          initial: `/history-${count}-initial.html`,
          pages,
        };
      }
    } finally {
      recovery.close();
      await host.closeProviderTransport();
    }
  }
  report.host.push({
    turns: count,
    first: stats(cold),
    reopen: stats(reopen),
    switch: stats(switched),
  });
  await persist();
}
// Only one data set is selected at a time; each response still owns the real Thread ID.
await writeFile(
  path.join(output, "history-index.html"),
  JSON.stringify(manifest),
);
if (process.argv.includes("--host-only")) {
  report.status = "host-only";
  report.rendererStatus = "not-run";
  await persist();
  console.log(output);
  process.exit(0);
}
const bundle = await build({
  configFile: false,
  root,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(root, "apps/zenx/evals/native-history/fixture.tsx"),
      name: "NativeHistoryQA",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const assets = (Array.isArray(bundle) ? bundle[0] : bundle).output;
const js = assets
  .filter((x) => x.type === "chunk")
  .map((x) => x.code)
  .join("\n");
const css = assets
  .filter((x) => x.type === "asset" && x.fileName.endsWith(".css"))
  .map((x) => String(x.source))
  .join("\n");
await writeFile(
  path.join(output, "native-history.html"),
  `<!doctype html><html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
try {
  await withPreviewBrowser(
    output,
    async ({ send, evaluate, url, screenshot }) => {
      report.browser = await send("Browser.getVersion");
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", { url: url + "/native-history.html" });
      for (let i = 0; i < 100 && !(await evaluate("!!window.__historyQA")); i++)
        await delay(50);
      assert(await evaluate("!!window.__historyQA"));
      const measure = async (id) => {
        await send("HeapProfiler.collectGarbage");
        const baseline = await send("Runtime.getHeapUsage");
        const sample = await evaluate(
          `window.__historyQA.open(${JSON.stringify(id)})`,
        );
        const peak = await send("Runtime.getHeapUsage");
        await send("HeapProfiler.collectGarbage");
        const idle = await send("Runtime.getHeapUsage");
        return {
          ...sample,
          baselineHeapBytes: baseline.usedSize,
          sampledPeakHeapBytes: peak.usedSize,
          idleHeapBytes: idle.usedSize,
        };
      };
      for (const id of ["256", "1200"]) {
        const first = [],
          reopen = [],
          switched = [];
        for (let i = 0; i < 5; i++) {
          await evaluate("window.__historyQA.close()");
          first.push(await measure(id));
          await evaluate("window.__historyQA.close()");
          reopen.push(await measure(id));
          await measure(id === "256" ? "1200" : "256");
          switched.push(await measure(id));
        }
        report.renderer.push({
          turns: Number(id),
          first: stats(first),
          reopen: stats(reopen),
          switch: stats(switched),
        });
        await persist();
      }
      await evaluate('window.__historyQA.open("256")');
      await evaluate(
        `(()=>{const node=document.querySelector('.messages'); node.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));node.scrollTop=300;node.dispatchEvent(new Event('scroll'));})()`,
      );
      await delay(100);
      const before = await evaluate("window.__historyQA.anchor()");
      await evaluate("window.__historyQA.load()");
      await delay(300);
      const after = await evaluate("window.__historyQA.anchor()");
      report.checks.anchor = { before, after };
      assert.equal(after?.key, before?.key);
      assert(
        Math.abs(after.offset - before.offset) < 3,
        JSON.stringify({ before, after }),
      );
      assert.equal(
        (await evaluate("window.__historyQA.state()")).draft,
        "Keep this draft",
      );
      await evaluate(
        `document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}))`,
      );
      for (
        let i = 0;
        i < 100 &&
        (await evaluate("window.__historyQA.state().historyRemaining"));
        i++
      )
        await delay(100);
      assert.equal(
        (await evaluate("window.__historyQA.state()")).historyRemaining,
        false,
      );
      report.checks.allPages = await evaluate("window.__historyQA.state()");
      assert(report.checks.allPages.mountedTurns < 60);
      assert.equal(report.checks.allPages.requests, 12);
      assert.equal(report.checks.allPages.draft, "Keep this draft");
      await evaluate(`(() => {
        const input = document.querySelector('.virtual-transcript-find input');
        if (!input) throw new Error('Find did not open');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Answer 0:');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      for (
        let i = 0;
        i < 100 &&
        !(await evaluate(
          `!!document.querySelector('[data-thread-find-item-id="agent-0"]') &&
        Array.from(window.CSS?.highlights?.get('zenx-thread-find-active') ?? []).some(range => range.toString() === 'Answer 0:')`,
        ));
        i++
      )
        await delay(50);
      report.checks.oldestFind = await evaluate(`({
        mounted: !!document.querySelector('[data-thread-find-item-id="agent-0"]'),
        count: document.querySelector('.virtual-transcript-find [role="status"]')?.textContent,
        highlighted: Array.from(window.CSS?.highlights?.get('zenx-thread-find-active') ?? []).some(range => range.toString() === 'Answer 0:'),
      })`);
      assert.equal(report.checks.oldestFind.mounted, true);
      assert.equal(report.checks.oldestFind.highlighted, true);
      assert.match(report.checks.oldestFind.count, /1.*1/);
      await screenshot("native-history-find.png");
    },
  );
  report.status = "passed";
  await persist();
  console.log(output);
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  await persist();
  throw error;
}
