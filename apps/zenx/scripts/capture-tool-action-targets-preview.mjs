/** Synthetic in-memory UI only. Reuses the existing temporary-profile renderer fixture helper. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(
  process.argv[2] ?? ".tool-action-targets-preview",
);
const cases = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1120,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const lang of ["en", "zh-CN"]) {
      await send("Page.navigate", {
        url: `${url}/tool-action-targets.html?lang=${lang}`,
      });
      for (let i = 0; i < 60; i++) {
        if (
          await evaluate(
            "document.querySelectorAll('.tool-action-target button').length === 2",
          )
        )
          break;
        await delay(50);
      }
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.tool-action-target button').length",
        ),
        2,
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.trace-item-toggle[aria-expanded=true]').length",
        ),
        0,
      );
      await screenshot(`${lang}-tool-actions.png`);
      await evaluate(
        "document.querySelector('.tool-action-target button').click()",
      );
      for (let i = 0; i < 60; i++) {
        if (
          await evaluate(
            "document.activeElement?.dataset.sentMessageId === 'exact-message'",
          )
        )
          break;
        await delay(50);
      }
      assert.equal(
        await evaluate("document.activeElement?.dataset.sentMessageId"),
        "exact-message",
      );
      assert.equal(
        await evaluate(
          "document.querySelector('[data-sent-message-id=\"same-text-neighbor\"]').hasAttribute('data-message-target')",
        ),
        false,
      );
      await screenshot(`${lang}-exact-message.png`);
      await evaluate(
        "document.querySelector('.tool-target-preview>header button').click()",
      );
      await delay(100);
      await evaluate(
        "document.querySelectorAll('.tool-action-target button')[1].click()",
      );
      for (let i = 0; i < 60; i++) {
        if (
          await evaluate("!!document.querySelector('.trigger-editor textarea')")
        )
          break;
        await delay(50);
      }
      const prompt = await evaluate(
        "document.querySelector('.trigger-editor textarea').value",
      );
      assert.equal(
        prompt,
        lang === "en"
          ? "Review implementation progress and preserve sources."
          : "复查实施进展并保留来源。",
      );
      await screenshot(`${lang}-exact-trigger.png`);
      const commands = await evaluate("window.__toolTargetPreview.commands");
      assert.ok(
        commands.every((name) =>
          ["list", "threads", "workspaces"].includes(name),
        ),
      );
      cases.push({
        lang,
        exactMessage: "exact-message",
        exactTriggerPrompt: prompt,
        readOnlyCommands: commands,
      });
    }
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      "document.querySelector('.tool-target-preview>header button').click()",
    );
    await delay(100);
    assert.equal(
      await evaluate("document.documentElement.scrollWidth > innerWidth"),
      false,
    );
    await screenshot("zh-CN-narrow-actions.png");
    assert.deepEqual(errors, []);
  },
);
await writeFile(
  path.join(directory, "measurements.json"),
  JSON.stringify(
    {
      scope:
        "Production ThreadView, tool links, exact-message focus and TriggersPanel; synthetic data only, not full App or native Electron acceptance.",
      browserSandboxDisabled: true,
      cases,
    },
    null,
    2,
  ),
);
console.log("Synthetic tool-action navigation and screenshots verified.");
