import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".background-shell-preview");
const evidence = { synthetic: true, modelCalls: 0, scenes: [] };
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    const navigate = async (query = "") => {
      await send("Page.navigate", {
        url: `${url}/background-shell-preview.html${query}`,
      });
      await delay(800);
    };
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1200,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate();
    assert.match(
      await evaluate("document.body.textContent"),
      /2 条后台命令正在运行/,
    );
    await screenshot("background-shell-running-light.png");
    await evaluate(
      "document.querySelector('.background-shell-disclosure').click()",
    );
    await delay(100);
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.background-shell-list button').length",
      ),
      2,
    );
    await screenshot("background-shell-expanded-light.png");
    await evaluate(
      "document.querySelectorAll('.background-shell-list button')[1].click()",
    );
    await delay(600);
    assert.equal(
      await evaluate(
        "document.querySelector('.shell-heading-context strong')?.textContent",
      ),
      "npm run build:prepared --workspace @zen/zenx",
    );
    assert.equal(
      await evaluate("document.activeElement.className"),
      "shell-heading-context",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.shell-session-details').textContent.includes('synthetic-build')",
      ),
      true,
    );
    await screenshot("background-shell-exact-terminal-light.png");
    evidence.scenes.push({
      scene: "exact-terminal",
      taskId: "synthetic-build",
      threadId: "synthetic-source",
      focus: "shell-heading-context",
    });
    await evaluate("window.__backgroundShellPreview.setTheme('dark')");
    await screenshot("background-shell-exact-terminal-dark.png");
    await evaluate("window.__backgroundShellPreview.finish()");
    await delay(1200);
    assert.match(
      await evaluate(
        "document.querySelector('.background-shell-status').textContent",
      ),
      /没有正在运行的后台命令/,
    );
    await screenshot("background-shell-finished-dark.png");
    await evaluate("window.__backgroundShellPreview.failRead()");
    await delay(1200);
    assert.match(
      await evaluate(
        "document.querySelector('.background-shell-status').textContent",
      ),
      /后台命令状态读取失败/,
    );
    await evaluate(
      "document.querySelector('.background-shell-error').open = true",
    );
    await screenshot("background-shell-read-failed-dark.png");
    await evaluate(
      "window.__backgroundShellPreview.restoreRead(); document.querySelector('.background-shell-heading > button:last-child').click()",
    );
    await delay(150);
    assert.doesNotMatch(
      await evaluate(
        "document.querySelector('.background-shell-status').textContent",
      ),
      /后台命令状态读取失败/,
    );
    await evaluate("window.__backgroundShellPreview.selectFork()");
    await delay(200);
    assert.equal(
      await evaluate("document.querySelector('.background-shell-status')"),
      null,
    );
    evidence.scenes.push({ scene: "fork", inheritedProcesses: 0 });
    const requests = await evaluate("window.__backgroundShellPreview.requests");
    assert(
      requests.every((request) => ["list", "read"].includes(request.operation)),
    );
    evidence.requests = requests;
    await send("Emulation.setDeviceMetricsOverride", {
      width: 420,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate("?lang=en&theme=dark");
    await evaluate(
      "document.querySelector('.background-shell-disclosure').click()",
    );
    await delay(100);
    assert.equal(
      await evaluate("document.documentElement.scrollWidth > innerWidth"),
      false,
    );
    await screenshot("background-shell-expanded-narrow-dark.png");
    evidence.scenes.push({ scene: "narrow", width: 420, overflow: false });
  },
);
await writeFile(
  path.join(directory, "background-shell-evidence.json"),
  JSON.stringify(evidence, null, 2),
);
