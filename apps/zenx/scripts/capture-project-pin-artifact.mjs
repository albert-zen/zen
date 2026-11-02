/** Visual-only rendering of one immutable CI artifact; no product build or Host. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";

const directory = path.resolve(process.argv[2]);
const expectedCommit = "143506de12ebd540da6c1cd481726b021b263af2";
const source = JSON.parse(await readFile(path.join(directory, "source.json"), "utf8"));
assert.equal(source.commit, expectedCommit);
const htmlPath = path.join(directory, "titlebar-safe-area.html");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const htmlHash = hash(await readFile(htmlPath));
const screenshotName = "project-recent-pinned-production-sidebar.png";
const evidence = {
  scope: "Visual-only production Sidebar, WindowTitleBar and CSS from the unchanged CI-built HTML; synthetic fixture rows, no Host, no native Electron or dynamic-order claim.",
  sourceArtifactId: 13130870327,
  sourceRunId: 41421950151,
  sourceArchiveSha256: "cd8e3f8b30c4d7de87e0592c0b6eb61408a534301e3f3b347fe8f4eb00f6f604",
  sourceCommit: expectedCommit,
  candidateHead: "2ca2adc438f911a499bdaee3ae0b3878885e588a",
  sourceTree: "879b436d11cd7cf5c2be42fd6d161a48b160ab5b",
  htmlSha256: htmlHash,
  viewport: { width: 1360, height: 920 },
};
await withPreviewBrowser(directory, async ({ send, evaluate, url, screenshot }) => {
  await send("Emulation.setDeviceMetricsOverride", {
    ...evidence.viewport,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const query = "navigation=1&platform=linux&sidebar=open&theme=light&count=short&lang=en";
  evidence.query = query;
  await send("Page.navigate", { url: url + "/titlebar-safe-area.html?" + query });
  let ready = false;
  for (let n = 0; n < 200; n++) {
    ready = await evaluate("document.body?.dataset.previewReady === 'true' && document.querySelectorAll('.recent-thread-group .thread-row-shell').length === 3");
    if (ready) break;
    await delay(50);
  }
  assert.equal(ready, true, "Existing navigation fixture must render");
  await evaluate("document.fonts.ready");
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  const snapshot = await evaluate(`(() => {
    const ids = selector => [...document.querySelectorAll(selector)].map(e => e.dataset.threadId);
    const headings = ['#sidebar-pinned-heading', '#sidebar-thread-list-heading', '#sidebar-recent-heading'].map(selector => {
      const e = document.querySelector(selector);
      if (!e) return { selector, present: false };
      const r = e.getBoundingClientRect();
      return { selector, present: true, text: e.textContent.trim(), visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
    });
    return {
      headings,
      pinned: ids('.pinned-thread-group .thread-row-shell'),
      project: ids('[data-project-key="/synthetic/project"] .thread-row-shell'),
      recent: ids('.recent-thread-group .thread-row-shell'),
      selected: document.querySelector('.recent-thread-group .thread-row[aria-current="page"]')?.closest('.thread-row-shell')?.dataset.threadId,
      bodyWidth: document.documentElement.scrollWidth,
    };
  })()`);
  assert(snapshot.headings.every(item => item.present && item.visible), "Pinned, Projects and Recent headings must be simultaneously visible");
  assert.deepEqual(snapshot.pinned, ["pinned"]);
  assert.deepEqual(snapshot.project, ["project"]);
  assert.deepEqual(snapshot.recent, ["pinned", "project", "recent"]);
  assert.equal(snapshot.selected, "recent");
  assert(snapshot.bodyWidth <= evidence.viewport.width);
  evidence.snapshot = snapshot;
  await screenshot(screenshotName);
});
assert.equal(hash(await readFile(htmlPath)), htmlHash, "Artifact HTML bytes must remain unchanged");
evidence.screenshot = { file: screenshotName, sha256: hash(await readFile(path.join(directory, screenshotName))) };
await writeFile(path.join(directory, "project-pin-artifact-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log("PROJECT_PIN_VISUAL_EVIDENCE " + JSON.stringify(evidence));
