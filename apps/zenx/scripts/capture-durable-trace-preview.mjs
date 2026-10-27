import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".durable-trace-preview");
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const evidence = {
  scope:
    "Production components and synthetic read API. Not native Electron/Host acceptance.",
  scenes: [],
};
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    const wait = async (expression) => {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        if (await evaluate(expression)) return;
        await delay(30);
      }
      assert(await evaluate(expression), `Timed out: ${expression}`);
    };
    const activate = async (expression) => {
      assert(
        await evaluate(`Boolean(${expression})`),
        `Missing control: ${expression}`,
      );
      await evaluate(`(${expression}).focus()`);
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: "\r",
        unmodifiedText: "\r",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await delay(50);
    };
    const button = (text) =>
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes(${JSON.stringify(text)}))`;
    const open = async (width, lang, theme, scene = "requests") => {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", {
        url: `${url}/durable-trace.html?lang=${lang}&theme=${theme}&scene=${scene}`,
      });
      await wait(
        scene === "items"
          ? "Boolean(document.querySelector('.thread-debugger'))"
          : "Boolean(document.querySelector('.trace-inspector'))",
      );
      await evaluate("document.fonts.ready");
    };
    for (const width of [1280, 390])
      for (const lang of ["en", "zh-CN"])
        for (const theme of ["light", "dark"]) {
          const name = `${width}-${lang}-${theme}`;
          await open(width, lang, theme);
          await wait(
            "document.querySelectorAll('.trace-inspector-record').length === 4",
          );
          assert.equal(
            await evaluate("document.querySelector('[role=switch]')"),
            null,
          );
          await screenshot(`${name}-index.png`);
          await activate("document.querySelector('.trace-inspector-record')");
          await wait(
            "Boolean(document.querySelector('.trace-inspector-payload'))",
          );
          assert(
            await evaluate(
              "document.querySelector('.trace-inspector-payload').textContent.includes('not a developer instruction')",
            ),
          );
          assert.equal(
            await evaluate(
              "document.querySelector('.trace-inspector-payload developer')",
            ),
            null,
          );
          assert(
            await evaluate(
              "document.documentElement.scrollWidth <= innerWidth",
            ),
          );
          await screenshot(`${name}-request-raw.png`);
          await activate(
            button(lang === "en" ? "Frozen settings" : "冻结设置"),
          );
          await wait(
            "document.querySelector('.trace-inspector-payload').textContent.includes('read-only')",
          );
          await screenshot(`${name}-frozen-settings.png`);
          await activate(
            button(lang === "en" ? "Back to records" : "返回记录"),
          );
          assert(
            await evaluate(
              "document.activeElement.classList.contains('trace-inspector-record')",
            ),
          );
          await activate(button("Completed reply"));
          await wait(
            "document.querySelector('.trace-inspector-detail').textContent.includes('completed')",
          );
          assert(
            await evaluate(
              "document.querySelector('.trace-inspector-detail').textContent.includes('unknown')",
            ),
          );
          await screenshot(`${name}-completed-open-tail.png`);
          await activate(
            button(lang === "en" ? "Back to records" : "返回记录"),
          );
          await activate(button("Prepared but not sent"));
          await wait(
            "document.querySelector('.trace-inspector-detail').textContent.includes('blocked')",
          );
          await screenshot(`${name}-prepared-blocked.png`);
          await open(width, lang, theme, "items");
          await screenshot(`${name}-semantic-items.png`);
          evidence.scenes.push({
            width,
            lang,
            theme,
            rawEscaped: true,
            frozenSettings: true,
            dualOutcome: true,
            blockedNotSent: true,
            keyboardBackFocus: true,
            noViewportOverflow: true,
          });
        }
    for (const scene of ["empty", "error"]) {
      await open(1280, "en", "light", scene);
      await wait(
        scene === "empty"
          ? "document.body.textContent.includes('No recorded evidence')"
          : "Boolean(document.querySelector('[role=alert]'))",
      );
      await screenshot(`1280-en-light-${scene}.png`);
    }
    await open(1280, "en", "light");
    await evaluate(
      "(()=>{const s=document.querySelector('select[aria-label=Scope]');s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await wait("document.body.textContent.includes('Auxiliary title sample')");
    await activate(button("Auxiliary title sample"));
    await screenshot("1280-en-light-all-local-title.png");
    await evaluate(
      "(()=>{const s=document.querySelector('select[aria-label=Evidence]');s.value='events';s.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await wait(
      "document.querySelectorAll('.trace-inspector-record').length === 6",
    );
    await activate(button("tool_output"));
    await activate(button("Original artifact"));
    await wait(
      "document.querySelector('.trace-inspector-payload').textContent.includes('Exact synthetic stdout')",
    );
    await screenshot("1280-en-light-tool-original.png");
    for (const lang of ["en", "zh-CN"])
      for (const theme of ["light", "dark"]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 1200,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Page.navigate", {
          url: `${url}/protocol-settings.html?tab=models&language=${lang}&theme=${theme}`,
        });
        const edit = `document.querySelector('button[aria-label="${lang === "en" ? "Edit Alpha" : "编辑Alpha"}"]')`;
        await wait(`Boolean(${edit})`);
        await evaluate("document.fonts.ready");
        await activate(edit);
        await wait(
          "Boolean(document.querySelector('[data-provider-protocol]'))",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('[data-provider-protocol]').dataset.value",
          ),
          "chat-completions",
        );
        await screenshot(`1280-${lang}-${theme}-protocol-default-chat.png`);
        await activate("document.querySelector('[data-provider-protocol]')");
        await wait(
          "Boolean(document.querySelector('[role=option][data-value=responses]'))",
        );
        await activate(
          "document.querySelector('[role=option][data-value=responses]')",
        );
        await wait(
          "document.querySelector('[data-provider-protocol]').dataset.value === 'responses'",
        );
        await screenshot(
          `1280-${lang}-${theme}-protocol-explicit-responses.png`,
        );
      }
    assert.deepEqual(errors, []);
    await writeFile(
      path.join(directory, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
  },
);
