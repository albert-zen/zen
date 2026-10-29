import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
const directory = path.resolve(process.argv[2] ?? "/tmp/zenx-sidechat-visual");
const manifest = JSON.parse(
  await readFile(path.join(directory, "source.json"), "utf8"),
);
const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), manifest.commit);
assert.equal(
  git("status", "--porcelain"),
  "",
  "Capture a clean frozen source tree",
);
assert.deepEqual(manifest.dirtyFiles, []);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(
  hash(await readFile(path.join(directory, manifest.artifact.html))),
  manifest.artifact.htmlSha256,
);
for (const [source, expected] of Object.entries(manifest.sources))
  assert.equal(hash(await readFile(path.join(appRoot, source))), expected);
const evidence = {
  commit: manifest.commit,
  scope:
    "Production App and ThreadView, synthetic native parent history and held create/send promises. CSP blocks network; no real Host, profile, user data or model requests.",
  scenes: [],
};
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    const waitFor = async (expression) => {
      for (let n = 0; n < 240; n++) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await delay(50);
      }
      throw new Error(`Timed out: ${expression}`);
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) throw new Error('Missing element');
      const r = e.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (!r.width || !r.height || !e.contains(document.elementFromPoint(x, y))) throw new Error('Obscured element');
      return {x, y};
    })()`);
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        });
    };
    for (const [theme, width] of [
      ["light", 1280],
      ["dark", 960],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const destination = `${url}/ui-polish-visual.html?scene=sidechat&conversationTabs=1&theme=${theme}&platform=darwin`;
      await send("Page.navigate", { url: destination });
      await waitFor(
        `location.href === ${JSON.stringify(destination)} && document.body.dataset.previewReady === 'true' && document.querySelector('.thread-row')`,
      );
      await click(".thread-row");
      await waitFor("document.querySelector('#thread-browser-toggle')");
      await click("#thread-browser-toggle");
      await waitFor(
        "document.querySelector('#thread-workspace-panel .workspace-plugin-choice button')",
      );
      await click("#thread-workspace-panel .workspace-plugin-choice button");
      await waitFor(
        "document.querySelector('#thread-workspace-panel [aria-label=\"New side chat\"]')",
      );
      await click('#thread-workspace-panel [aria-label="New side chat"]');
      await waitFor("document.querySelector('[id^=\"side-chat-draft-\"]')");
      await waitFor(
        "document.querySelector('#thread-workspace-panel')?.textContent.includes('Synthetic parent read for local side chat draft.')",
      );
      assert.equal(await evaluate("window.__sideChatFixture.creates"), 0);
      assert.equal(
        await evaluate(
          "!!document.querySelector('#thread-workspace-panel .thread-empty')",
        ),
        false,
      );
      await delay(300);
      await screenshot(`sidechat-context-${theme}-${width}.png`);
      await click('[id^="side-chat-draft-"]');
      await send("Input.insertText", {
        text: "Can you explain this inherited context?",
      });
      await click('#thread-workspace-panel [aria-label="Send"]');
      await waitFor(
        "document.querySelector('.side-chat-context-note')?.textContent.includes('Creating side chat')",
      );
      assert.equal(await evaluate("window.__sideChatFixture.creates"), 1);
      assert.equal(await evaluate("window.__sideChatFixture.sends"), 0);
      assert.equal(
        await evaluate(
          "!!document.querySelector('.side-chat-context-note .mini-spinner')",
        ),
        true,
      );
      await screenshot(`sidechat-creating-${theme}-${width}.png`);
      await click('[data-testid="sidechat-release-creation"]');
      await waitFor(
        "document.querySelector('.side-chat-context-note')?.textContent.includes('Sending your message')",
      );
      await screenshot(`sidechat-sending-${theme}-${width}.png`);
      await click('[data-testid="sidechat-fail-send"]');
      await waitFor(
        "document.querySelector('.composer-error')?.textContent.includes('Synthetic send failure')",
      );
      assert.equal(
        await evaluate(
          "document.querySelector('[id^=\"side-chat-draft-\"]')?.value",
        ),
        "Can you explain this inherited context?",
      );
      await screenshot(`sidechat-failed-${theme}-${width}.png`);
      await click('#thread-workspace-panel [aria-label="Send"]');
      await waitFor("window.__sideChatFixture.sends === 2");
      assert.equal(
        await evaluate("window.__sideChatFixture.creates"),
        1,
        "Retry reuses confirmed child",
      );
      await click('[data-testid="sidechat-resolve-send"]');
      await waitFor(
        "!document.querySelector('[id^=\"side-chat-draft-\"]') && document.querySelector('[role=tab][id*=\"thread:sidechat-created\"]')",
      );
      evidence.scenes.push({
        theme,
        width,
        creates: 1,
        sends: 2,
        failedInputPreserved: true,
        retryReusedChild: true,
        status: "passed",
      });
    }
  },
);
await writeFile(
  path.join(directory, "sidechat-capture.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence, null, 2));
