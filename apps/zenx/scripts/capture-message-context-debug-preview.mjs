import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "CI-only actual component capture",
);
const directory = path.resolve(process.argv[2] ?? ".message-debug-preview");
const evidence = {
  scope:
    "Actual action/Dialog, synthetic message and capture API, no Host or real model. No native app acceptance.",
  cases: [],
};
try {
  await withPreviewBrowser(
    directory,
    async ({ send, evaluate, url, screenshot }) => {
      for (const [lang, theme, width, height] of [
        ["en", "light", 1100, 900],
        ["zh-CN", "dark", 390, 844],
      ]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Page.navigate", {
          url: `${url}/message-debug.html?lang=${lang}&theme=${theme}`,
        });
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await evaluate("!!document.querySelector('.message-copy')"))
            break;
          await delay(50);
        }
        await evaluate(
          "document.querySelector('.message-copy').focus(); document.querySelector('.message-copy').click()",
        );
        await delay(150);
        assert.equal(
          await evaluate("window.messageDebugFixture.commands.length"),
          0,
        );
        await screenshot(`canonical-content-${lang}-${theme}-${width}.png`);
        await evaluate(
          "document.querySelector('.message-context-debug > details').open = true",
        );
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            await evaluate(
              "!!document.querySelector('.message-context-debug-records button')",
            )
          )
            break;
          await delay(50);
        }
        await evaluate(
          "document.querySelector('.message-context-debug-records button').click()",
        );
        await delay(150);
        const measured = await evaluate(
          `(() => { const dialog = document.querySelector('.message-context-debug'); const rect = dialog.getBoundingClientRect(); const pre = [...dialog.querySelectorAll('pre')]; return { appearance: document.documentElement.dataset.appearance, colorScheme: getComputedStyle(document.documentElement).colorScheme, role: dialog.getAttribute('role'), preCount: pre.length, saved: dialog.querySelector(".canonical-message-content")?.textContent, captured: pre.at(-1)?.textContent, overflow: document.documentElement.scrollWidth > innerWidth, bounds: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, focused: dialog.contains(document.activeElement), commands: window.messageDebugFixture.commands }; })()`,
        );
        assert.equal(measured.role, "dialog");
        assert.equal(measured.appearance, theme);
        assert.equal(measured.colorScheme, theme);
        assert.equal(measured.preCount, 3);
        assert.equal(measured.overflow, false);
        assert.ok(
          measured.bounds.left >= 0 &&
            measured.bounds.right <= width &&
            measured.bounds.top >= 0 &&
            measured.bounds.bottom <= height,
        );
        assert.ok(measured.focused);
        assert.ok(measured.saved.includes("synthetic-research"));
        assert.ok(measured.captured.includes("received_at"));
        assert.ok(
          measured.commands.every((command) =>
            ["status", "list", "read"].includes(command.action),
          ),
        );
        await screenshot(`message-input-${lang}-${theme}-${width}.png`);
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await delay(200);
        assert.equal(
          await evaluate(
            "!!document.querySelector('.message-context-debug[data-state=open]')",
          ),
          false,
        );
        assert.equal(
          await evaluate(
            "document.activeElement === document.querySelector('.message-copy')",
          ),
          true,
        );
        await send("Page.navigate", {
          url: `${url}/message-debug.html?lang=${lang}&theme=${theme}&mode=history`,
        });
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            await evaluate(
              "!!document.querySelector('[data-item-id=synthetic-context]')",
            )
          )
            break;
          await delay(50);
        }
        assert.ok(
          await evaluate(
            "document.querySelector('.thread-debug-items').textContent.includes('received_at')",
          ),
        );
        assert.ok(
          await evaluate(
            "document.querySelector('[data-item-id=synthetic-operation]').textContent.includes('Synthetic probe model')",
          ),
        );
        await screenshot(`canonical-history-${lang}-${theme}-${width}.png`);
        await evaluate(
          "document.querySelectorAll('.thread-debug-tabs > button')[2].click()",
        );
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            await evaluate(
              "!!document.querySelector('.operation-history-panel .message-context-debug-records button')",
            )
          )
            break;
          await delay(50);
        }
        await evaluate(
          "document.querySelector('.operation-history-panel .message-context-debug-records button').click()",
        );
        await delay(200);
        assert.ok(
          await evaluate(
            "!!document.querySelector('.operation-history-panel [data-item-id=synthetic-context]')",
          ),
        );
        await screenshot(`operation-history-${lang}-${theme}-${width}.png`);
        evidence.cases.push({
          lang,
          theme,
          width,
          height,
          measured,
          escapeAndFocusRestoration: true,
        });
      }
    },
  );
} finally {
  await writeFile(
    path.join(directory, "measurements.json"),
    JSON.stringify(evidence, null, 2),
  );
}
