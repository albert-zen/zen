import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
import {
  summarize,
  verifyTranscriptUpdates,
  verifyManifest,
  SCHEMA_VERSION,
  CADENCE_MS,
} from "../evals/ux-performance/metrics.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
if (!process.argv[2]) throw Error("Pass the production build output directory");
const directory = path.resolve(process.argv[2]);
const large = process.argv.includes("--include-5000");
const report = {
  schemaVersion: SCHEMA_VERSION,
  status: "running",
  stage: "provenance",
  scope:
    "Synthetic production component boundary; not native admission/IPC/provider or proven pixel paint",
  cadence: {
    targetMs: CADENCE_MS,
    policy:
      "Sequential updates; if work exceeds cadence, wait for completion, no queued update backlog",
  },
  cases: [],
};
await mkdir(directory, { recursive: true });
const persist = () =>
  writeFile(
    path.join(directory, "measurements.json"),
    JSON.stringify(report, null, 2),
  );
try {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "build.json"), "utf8"),
  );
  const expected = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  verifyManifest(manifest, expected);
  assert.equal(
    execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--",
        ".",
        ":(exclude)node_modules",
        ":(exclude)apps/zenx/node_modules",
      ],
      { cwd: root, encoding: "utf8" },
    ).trim(),
    "",
    "Runner source must remain clean",
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(path.join(directory, "ux-performance.html")))
      .digest("hex"),
    manifest.htmlSha256,
  );
  report.build = manifest;
  report.stage = "browser-start";
  await persist();
  await withPreviewBrowser(
    directory,
    async ({ send, evaluate, url, errors }) => {
      report.browser = await send("Browser.getVersion");
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      report.stage = "fixture-ready";
      await persist();
      await send("Page.navigate", { url: url + "/ux-performance.html" });
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (await evaluate("!!window.__ux")) {
          ready = true;
          break;
        }
        await delay(50);
      }
      assert.equal(ready, true, "Fixture readiness timeout");
      await evaluate("document.fonts.ready");
      const measure = (action, n, key) =>
        evaluate(
          `window.__ux.measure(${JSON.stringify(action)},${JSON.stringify(n)},${JSON.stringify(key)})`,
        );
      const state = () => evaluate("window.__ux.state()");
      const record = async (name, action, repeats, n, key, cadence = false) => {
        report.stage = name;
        await persist();
        const samples = [];
        for (let i = 0; i < repeats; i++) {
          const t = performance.now();
          const sample = await measure(action, n, key);
          if (action === "delta")
            sample.transcript = await evaluate("window.__ux.transcript()");
          samples.push(sample);
          if (cadence)
            await delay(Math.max(0, CADENCE_MS - (performance.now() - t)));
        }
        const row = { name, ...summarize(samples) };
        report.cases.push(row);
        await persist();
        return row;
      };
      for (const n of large ? [100, 1000, 5000] : [100, 1000]) {
        await measure("clear");
        await record(`transcript-${n}-first-mount`, "open", 1, n, "thread-a");
        assert.equal((await state()).turns, n);
        assert.equal(
          await evaluate("document.querySelectorAll('.turn').length"),
          n,
          "All synthetic turns must exist in DOM",
        );
        const beforeDeltas = await evaluate("window.__ux.transcript()");
        const deltas = await record(
          `transcript-${n}-delta`,
          "delta",
          n === 5000 ? 3 : 30,
          undefined,
          undefined,
          true,
        );
        const afterDeltas = await evaluate("window.__ux.transcript()");
        verifyTranscriptUpdates(
          beforeDeltas,
          afterDeltas,
          deltas.samples,
          n === 5000 ? 3 : 30,
        );
        await evaluate("window.__ux.action('remember')");
        // Preserve the exact streamed snapshot; visit B, unmount, then restore A.
        report.stage = `transcript-${n}-warm-revisit`;
        await persist();
        const samples = [];
        for (let i = 0; i < (n === 5000 ? 1 : 5); i++) {
          await measure("open", n, "thread-b");
          await measure("clear");
          samples.push(await measure("restore", n, "thread-a"));
          assert.equal((await state()).threadId, "thread-a");
          assert.deepEqual(
            await evaluate("window.__ux.transcript()"),
            afterDeltas,
            "Revisit must preserve all streamed content in projection and DOM",
          );
        }
        report.cases.push({
          name: `transcript-${n}-warm-revisit`,
          ...summarize(samples),
        });
        await persist();
      }
      await record("markdown-51200-first-mount", "markdown", 1);
      assert.equal((await state()).markdownCharacters, 51200);
      const markdownDeltas = await record(
        "markdown-51200-growing-prefix",
        "markdownDelta",
        30,
        undefined,
        undefined,
        true,
      );
      assert.equal((await state()).markdownCharacters, 51380);
      assert.equal(
        markdownDeltas.samples.every(
          (sample) => sample.counts.markdown > 0 && sample.counts.commits > 0,
        ),
        true,
        "Each changed Markdown prefix must commit measured work",
      );
      report.stage = "synthetic-send";
      await persist();
      const sendSamples = [],
        admissionSamples = [];
      for (let i = 0; i < 10; i++) {
        await measure("sendScene");
        sendSamples.push(await measure("clickSend"));
        assert.equal(
          (await state()).submission,
          "pending",
          "Click must produce pending feedback",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('.composer-actions .action-orb')?.disabled",
          ),
          true,
          "Pending send control must be disabled",
        );
        admissionSamples.push(await measure("admit"));
        assert.equal((await state()).submission, null);
        assert.equal(
          (await state()).admitted,
          true,
          "Admitted message must exist in production DOM",
        );
        assert.match((await state()).bodyText, /Synthetic send feedback/);
      }
      report.cases.push(
        {
          name: "synthetic-click-to-pending-feedback",
          ...summarize(sendSamples),
        },
        { name: "synthetic-admit-to-message", ...summarize(admissionSamples) },
      );
      assert.deepEqual(errors, []);
      report.stage = "browser-cleanup";
      await persist();
    },
  );
  // Preview helper resolves only after confirmed browser cleanup.
  report.status = "passed";
  report.stage = "complete";
  await persist();
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  await persist();
  throw error;
}
