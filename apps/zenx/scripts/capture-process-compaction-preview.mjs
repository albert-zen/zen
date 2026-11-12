import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(
  process.argv[2] ?? ".process-compaction-preview",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(directory, "source.json"), "utf8"),
);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  manifest.commit,
);
assert.equal(manifest.trackedDirty, "");
assert.equal(
  createHash("sha256")
    .update(await readFile(path.join(directory, "process-compaction.html")))
    .digest("hex"),
  manifest.artifactSha256,
);
for (const [source, hash] of Object.entries(manifest.sources))
  assert.equal(
    createHash("sha256")
      .update(await readFile(path.join(root, source)))
      .digest("hex"),
    hash,
    source,
  );
const evidence = {
  commit: manifest.commit,
  artifactSha256: manifest.artifactSha256,
  scope: manifest.scope,
  scenes: [],
};
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    const activate = async (selector) => {
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).focus()`,
      );
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        text: "\r",
        unmodifiedText: "\r",
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await delay(100);
    };
    for (const width of [1100, 390])
      for (const lang of ["en", "zh-CN"])
        for (const theme of ["light", "dark"]) {
          await send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 1100,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await send("Page.navigate", {
            url: `${url}/process-compaction.html?lang=${lang}&theme=${theme}`,
          });
          for (let i = 0; i < 100; i++) {
            if (
              await evaluate(
                "document.querySelectorAll('.trace-activity-title').length === 3",
              )
            )
              break;
            await delay(50);
          }
          await evaluate("document.fonts.ready");
          const summaries = await evaluate(
            "Array.from(document.querySelectorAll('.trace-activity-title')).map(e=>e.textContent)",
          );
          assert.deepEqual(
            summaries,
            lang === "en"
              ? [
                  "Ran 3 commands",
                  "Compacted context and viewed images",
                  "Sent 2 messages",
                ]
              : [
                  "运行了3次命令",
                  "压缩了上下文，并查看了图片",
                  "发送了2条消息",
                ],
          );
          assert.equal(
            await evaluate(
              "document.querySelector('.context-compaction-event').querySelectorAll('button').length",
            ),
            1,
          );
          assert.equal(
            await evaluate("document.body.dataset.historyReads ?? '0'"),
            "0",
          );
          const name = `${width}-${lang}-${theme}`;
          await screenshot(`${name}-collapsed.png`);
          await activate(".context-compaction-toggle");
          assert.equal(
            await evaluate(
              "document.querySelectorAll('.context-compaction-event details').length",
            ),
            0,
          );
          await screenshot(`${name}-retained.png`);
          await activate('.compaction-views [role="tab"]:nth-child(2)');
          assert.equal(
            await evaluate("document.body.dataset.historyReads"),
            "1",
          );
          assert.equal(
            await evaluate(
              "document.querySelectorAll('.original-history-items > li').length",
            ),
            1,
          );
          await screenshot(`${name}-original.png`);
          await activate('.compaction-views [role="tab"]:nth-child(3)');
          assert.equal(
            await evaluate(
              "document.querySelector('.original-history-reader')",
            ),
            null,
          );
          assert.equal(
            await evaluate(
              "document.querySelectorAll('.context-compaction-event details').length",
            ),
            0,
          );
          assert.ok(
            await evaluate(
              "document.querySelector('.compaction-record').textContent.includes('synthetic-preview')",
            ),
          );
          const overflow = await evaluate(
            "({document: document.documentElement.scrollWidth > innerWidth, panel: (()=>{const e=document.querySelector('.compaction-view');return e.scrollWidth > e.clientWidth + 1})()})",
          );
          assert.deepEqual(overflow, { document: false, panel: false });
          await screenshot(`${name}-diagnostics.png`);
          await activate(".context-compaction-toggle");
          assert.equal(
            await evaluate(
              "document.querySelector('.context-compaction-event').querySelectorAll('button').length",
            ),
            1,
          );
          evidence.scenes.push({
            width,
            lang,
            theme,
            summaries,
            overflow,
            keyboardTabsAndCollapse: true,
          });
        }
    assert.deepEqual(errors, []);
  },
);
await writeFile(
  path.join(directory, "evidence.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
