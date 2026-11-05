/** Production component, synthetic pixels and API; never reads an application. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Capture is CI-only.");
assert.equal(process.platform, "linux", "Capture targets Ubuntu CI.");
const directory = path.resolve(process.argv[2] ?? ".app-shot-preview");
const evidence = {
  scope:
    "Real AppShotButton, Dialog, AttachmentImage and CSS in Chromium. All window identities, images and API results are synthetic. This does not test Electron desktopCapturer, native shortcuts, Screen Recording, AX or model delivery.",
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  browserSandboxDisabled: true, // Existing shared preview-browser launcher.
  cjkFonts: [],
  cases: [],
  status: "running",
};
const measure = `(() => {
  const dialog = document.querySelector('.app-shot-dialog');
  const r = dialog?.getBoundingClientRect();
  const img = document.querySelector('.app-shot-preview img');
  return {
    dialog: r ? {x:r.x,y:r.y,right:r.right,bottom:r.bottom} : null,
    sources: document.querySelectorAll('.app-shot-sources button').length,
    imageReady: Boolean(img?.complete && img.naturalWidth > 0),
    expanded: Boolean(document.querySelector('.app-shot-preview.is-expanded')),
    context: document.querySelector('.app-shot-context')?.textContent,
    count: document.querySelector('main > p:last-child')?.textContent,
    overflow: document.documentElement.scrollWidth > innerWidth,
    alert: document.querySelector('[role=alert]')?.textContent ?? null
  };
})()`;

try {
  evidence.cjkFonts = execFileSync("fc-list", [":lang=zh", "family"], {
    encoding: "utf8",
    timeout: 10_000,
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.ok(
    evidence.cjkFonts.length,
    "CJK fonts are required for screenshots.",
  );
  await withPreviewBrowser(
    directory,
    async ({ send, evaluate, url, screenshot }) => {
      evidence.browser = await send("Browser.getVersion");
      const wait = async (expression) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (await evaluate(expression)) return;
          await delay(50);
        }
        throw new Error(`App Shot condition timed out: ${expression}`);
      };
      const stable = async () => {
        await evaluate(
          "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))",
        );
      };
      const click = async (selector) => {
        const position = await evaluate(`(() => {
          const e=document.querySelector(${JSON.stringify(selector)});
          if (!e || e.disabled) throw Error('Missing or disabled fixture button');
          e.scrollIntoView({block:'center'});
          const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
          if (!r.width || !r.height || !e.contains(document.elementFromPoint(x,y))) throw Error('Fixture button is obscured');
          return {x,y};
        })()`);
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", {
            type,
            ...position,
            button: "left",
            clickCount: 1,
          });
      };
      const check = async (width, height) => {
        const state = await evaluate(measure);
        assert.equal(state.overflow, false, "No horizontal page overflow.");
        assert.equal(state.alert, null, "No image or component error.");
        if (state.dialog) {
          assert.ok(
            state.dialog.x >= 0 &&
              state.dialog.y >= 0 &&
              state.dialog.right <= width + 1 &&
              state.dialog.bottom <= height + 1,
            "Dialog stays inside the viewport.",
          );
        }
        return state;
      };
      const cases = [
        ...["light", "dark"].flatMap((theme) =>
          [1280, 390].map((width) => ({ theme, width, platform: "darwin" })),
        ),
        { theme: "light", width: 390, platform: "niri" },
        { theme: "dark", width: 1280, platform: "niri" },
        { theme: "dark", width: 390, platform: "portal" },
        { theme: "light", width: 1280, platform: "portal" },
        { theme: "light", width: 390, platform: "gnome" },
        { theme: "dark", width: 1280, platform: "gnome" },
      ];
      for (const { theme, width, platform } of cases) {
        const height = 900;
        const name = `${platform}-${theme}-${width}`;
        const receipt = { name, theme, width, height, platform, states: [] };
        evidence.cases.push(receipt);
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const destination = `${url}/app-shot.html?theme=${theme}&platform=${platform}`;
        await send("Page.navigate", { url: destination });
        await wait(
          `location.href===${JSON.stringify(destination)} && document.querySelectorAll('.app-shot-sources button').length===2`,
        );
        await stable();
        receipt.states.push({
          phase: "picker",
          ...(await check(width, height)),
        });
        await screenshot(`${name}-picker.png`);
        if (platform === "niri") {
          await click(".app-shot-shortcut details summary");
          await wait(
            "document.querySelector('.app-shot-shortcut details')?.open",
          );
          await stable();
          assert.match(
            await evaluate(
              "document.querySelector('.app-shot-shortcut details').textContent",
            ),
            /io\.github\.albert_zen\.ZenX\.AppShot/,
          );
          receipt.states.push({
            phase: "manual-binding",
            ...(await check(width, height)),
          });
          await screenshot(`${name}-manual-binding.png`);
        }

        if (platform === "gnome") {
          await click(".app-shot-shortcut details summary");
          await wait(
            "document.querySelector('.app-shot-shortcut details')?.open",
          );
          await stable();
          assert.match(
            await evaluate(
              "document.querySelector('.app-shot-shortcut details').textContent",
            ),
            /不验证可执行程序身份/,
          );
          receipt.states.push({
            phase: "gnome-manual-setup",
            ...(await check(width, height)),
          });
          await screenshot(`${name}-manual-setup.png`);
          await click(".app-shot-shortcut details summary");
          await stable();
        }
        if (platform === "portal" || platform === "gnome") {
          await click('.app-shot-shortcut input[type="checkbox"]');
          await wait(
            "document.querySelector('.app-shot-shortcut').textContent.includes('应用快照未启用')",
          );
          assert.equal(
            (await check(width, height)).count,
            "已添加 0 张，未发送。",
          );
          receipt.states.push({
            phase: "portal-unassigned",
            ...(await check(width, height)),
          });
          await screenshot(`${name}-portal-unassigned.png`);
          await click(
            ".app-shot-shortcut .app-shot-actions button:first-child",
          );
          await wait(
            "document.querySelector('.app-shot-shortcut').textContent.includes('Super+F8')",
          );
          receipt.states.push({
            phase: "portal-assigned",
            ...(await check(width, height)),
          });
          await screenshot(`${name}-portal-assigned.png`);
          await click('.app-shot-shortcut input[type="checkbox"]');
          await wait(
            "!document.querySelector('.app-shot-shortcut input[type=checkbox]').checked",
          );
        }

        await click(".app-shot-sources button");
        await wait(`(${measure}).imageReady`);
        await stable();
        const review = await check(width, height);
        assert.match(review.context, /Example Notes/);
        assert.match(review.context, /screenshot only/);
        assert.equal(review.count, "已添加 0 张，未发送。");
        receipt.states.push({ phase: "review", ...review });
        await screenshot(`${name}-review.png`);
        await click(".app-shot-preview .image-thumbnail");
        await wait(`(${measure}).expanded`);
        receipt.states.push({
          phase: "expanded",
          ...(await check(width, height)),
        });
        await screenshot(`${name}-expanded.png`);

        await click(".app-shot-heading button");
        await wait("!document.querySelector('.app-shot-dialog')");
        assert.equal(
          (await check(width, height)).count,
          "已添加 0 张，未发送。",
        );
        await click('[aria-label="应用快照"]');
        await wait(
          "document.querySelectorAll('.app-shot-sources button').length===2",
        );
        await click(".app-shot-sources button");
        await wait(`(${measure}).imageReady`);
        await click(".app-shot-actions .primary-button");
        await wait("!document.querySelector('.app-shot-dialog')");
        const attached = await check(width, height);
        assert.equal(attached.count, "已添加 1 张，未发送。");
        receipt.states.push({ phase: "attached-not-sent", ...attached });
        await screenshot(`${name}-attached.png`);
        await click('[aria-label="应用快照"]');
        await wait(
          "document.querySelectorAll('.app-shot-sources button').length===2",
        );
        for (const type of ["rawKeyDown", "keyUp"])
          await send("Input.dispatchKeyEvent", {
            type,
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
          });
        await wait("!document.querySelector('.app-shot-dialog')");
        assert.equal(
          (await check(width, height)).count,
          "已添加 1 张，未发送。",
        );
        receipt.status = "passed";
      }
    },
  );
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await writeFile(
    path.join(directory, "app-shot-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
}
