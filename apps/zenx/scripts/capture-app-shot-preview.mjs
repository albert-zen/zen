/** Production component, synthetic pixels and API; never reads an application. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";
import {
  appShotPreviewClickPosition,
  settleAppShotPreview,
} from "./app-shot-preview-stability.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Capture is CI-only.");
assert.equal(process.platform, "linux", "Capture targets Ubuntu CI.");
const directory = path.resolve(process.argv[2] ?? ".app-shot-preview");
const evidence = {
  scope:
    "Real AppShotButton, ThreadView, Composer, Dialog, AttachmentImage and CSS in Chromium. All window identities, images and API results are synthetic. This does not test Electron desktopCapturer, native shortcuts, Screen Recording, AX or model delivery.",
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
    pendingFiniteAnimations: document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime) && (a.pending || a.playState === 'running')).length,
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
      const stable = () => evaluate(`(${settleAppShotPreview.toString()})()`);
      const click = async (selector) => {
        const position = await evaluate(
          `(${appShotPreviewClickPosition.toString()})(${JSON.stringify(selector)}, ${settleAppShotPreview.toString()})`,
        );
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", {
            type,
            ...position,
            button: "left",
            clickCount: 1,
          });
      };
      const reveal = async (selector) => {
        await evaluate(
          `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`,
        );
        await stable();
        assert.equal(
          await evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          const r = element.getBoundingClientRect(), d = document.querySelector('.app-shot-dialog').getBoundingClientRect();
          return r.height > 0 && r.top >= d.top && r.bottom <= d.bottom && r.left >= d.left && r.right <= d.right;
        })()`),
          true,
          "Setup/revocation text must be reachable inside the dialog",
        );
      };
      const check = async (width, height) => {
        await stable();
        const state = await evaluate(measure);
        assert.equal(state.overflow, false, "No horizontal page overflow.");
        assert.equal(
          state.pendingFiniteAnimations,
          0,
          "Capture only settled production motion.",
        );
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
        { theme: "light", width: 390, platform: "win32" },
        { theme: "light", width: 390, platform: "niri" },
        { theme: "dark", width: 1280, platform: "niri" },
        { theme: "dark", width: 390, platform: "portal" },
        { theme: "light", width: 1280, platform: "portal" },
        { theme: "light", width: 390, platform: "gnome" },
        { theme: "dark", width: 1280, platform: "gnome" },
        { theme: "light", width: 390, platform: "kde" },
        { theme: "dark", width: 1280, platform: "kde", helper: "ready" },
        { theme: "light", width: 390, platform: "hyprland" },
        { theme: "dark", width: 1280, platform: "hyprland", helper: "ready" },
        { theme: "light", width: 390, platform: "darwin", context: "semantic" },
        { theme: "dark", width: 1280, platform: "darwin", context: "semantic" },
      ];
      for (const {
        theme,
        width,
        platform,
        helper = "setup",
        context = "pixels",
      } of cases) {
        const height = 900;
        const name = `${platform}-${theme}-${width}${context === "semantic" ? "-semantic" : ""}`;
        const receipt = {
          name,
          theme,
          width,
          height,
          platform,
          helper,
          context,
          states: [],
        };
        evidence.cases.push(receipt);
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const destination = `${url}/app-shot.html?theme=${theme}&platform=${platform}&helper=${helper}&context=${context}`;
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
        if (
          (platform === "win32" || (platform === "darwin" && width === 1280)) &&
          theme === "light" &&
          context === "pixels"
        ) {
          const pairLabels = [
            ["both-shift", "Shift"],
            ["both-control", "Control"],
            ["both-alt", platform === "darwin" ? "Option" : "Alt"],
            ["both-meta", platform === "darwin" ? "Command" : "Windows"],
          ];
          for (const [kind, label] of pairLabels) {
            const selector = `input[type="radio"][value="${kind}"]`;
            await click(selector);
            assert.equal(
              await evaluate(
                `document.querySelector(${JSON.stringify(selector)}).checked`,
              ),
              true,
            );
            assert.equal(
              await evaluate(
                `document.querySelector(${JSON.stringify(selector)}).closest('label').textContent.includes(${JSON.stringify(label)})`,
              ),
              true,
            );
            assert.equal(
              await evaluate(
                `document.querySelector('.app-shot-shortcut input[type="checkbox"]').checked`,
              ),
              false,
            );
            if (
              platform === "win32" &&
              (kind === "both-alt" || kind === "both-meta")
            ) {
              const warning =
                kind === "both-alt" ? "激活应用菜单栏" : "打开系统菜单";
              assert.equal(
                await evaluate(
                  `document.querySelector('.app-shot-shortcut').textContent.includes(${JSON.stringify(warning)})`,
                ),
                true,
              );
              await reveal(".app-shot-shortcut > p:last-of-type");
              receipt.states.push({
                phase: kind + "-menu-warning",
                ...(await check(width, height)),
              });
              await screenshot(`${name}-${kind}-warning.png`);
            }
          }
          // The pre-existing chord stays selectable, then save a non-default pair.
          await click('input[type="radio"][value="chord"]');
          await wait(`document.querySelector('input[value="chord"]').checked`);
          await click('input[type="radio"][value="both-meta"]');
          await wait(
            `document.querySelector('input[value="both-meta"]').checked`,
          );
          // A fresh page keeps only the actual renderer preference, not React state.
          await send("Page.navigate", { url: "about:blank" });
          await wait('location.href === "about:blank"');
          await send("Page.navigate", { url: destination });
          await wait(
            `location.href===${JSON.stringify(destination)} && document.querySelectorAll('.app-shot-sources button').length===2`,
          );
          assert.equal(
            await evaluate(
              `document.querySelector('input[value="both-meta"]').checked`,
            ),
            true,
          );
          assert.equal(
            await evaluate(
              `document.querySelector('.app-shot-shortcut input[type="checkbox"]').checked`,
            ),
            false,
          );
          assert.equal(
            await evaluate(
              `document.querySelector('.app-shot-option input[type="checkbox"]').checked`,
            ),
            false,
          );
          assert.match(
            await evaluate(
              'document.querySelector(".app-shot-shortcut fieldset").textContent',
            ),
            /每个输入框仍需单独启用/,
          );
          await reveal('input[type="radio"][value="both-meta"]');
          const remembered = await check(width, height);
          assert.equal(remembered.imageReady, false);
          assert.equal(remembered.count, "已添加 0 张，未发送。");
          receipt.states.push({
            phase: "remembered-meta-pair-disabled",
            ...remembered,
          });
          await screenshot(`${name}-remembered-shortcut.png`);
          // Leave the remaining synthetic scenarios at the normal platform choice.
          await click('input[type="radio"][value="both-shift"]');
        }
        if (
          (platform === "darwin" ||
            platform === "win32" ||
            platform === "portal") &&
          context === "pixels"
        ) {
          const before = await evaluate("({...window.appShotPreviewCalls})");
          await click("[data-keybinding-capture]");
          await wait(
            `document.querySelector('[data-keybinding-capture]').getAttribute('aria-pressed') === 'true'`,
          );
          const key = {
            key: "k",
            code: "KeyK",
            windowsVirtualKeyCode: 75,
            modifiers: platform === "darwin" ? 5 : 3,
          };
          await send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
          await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
          await wait(
            `document.querySelector('[data-app-shot-chord]')?.textContent.includes('Alt+K') && !document.querySelector('.app-shot-shortcut input[type="checkbox"]').disabled`,
          );
          assert.equal(
            await evaluate(
              `document.querySelector('.app-shot-shortcut input[type="checkbox"]').checked`,
            ),
            false,
          );
          assert.equal(
            await evaluate("window.appShotPreviewCalls.arm"),
            before.arm,
          );
          assert.equal(
            await evaluate("window.appShotPreviewCalls.capture"),
            before.capture,
          );
          await reveal("[data-keybinding-capture]");
          receipt.states.push({
            phase: "recorded-custom-chord-not-armed",
            ...(await check(width, height)),
          });
          await screenshot(`${name}-custom-chord.png`);
          await click("[data-keybinding-capture]");
          await wait(
            `document.querySelector('[data-keybinding-capture]').getAttribute('aria-pressed') === 'true'`,
          );
          for (const type of ["keyDown", "keyUp"])
            await send("Input.dispatchKeyEvent", {
              type,
              key: "Escape",
              code: "Escape",
              windowsVirtualKeyCode: 27,
            });
          await wait(
            `document.querySelector('.app-shot-dialog') && document.querySelector('[data-keybinding-capture]').getAttribute('aria-pressed') === 'false' && !document.querySelector('.app-shot-shortcut input[type="checkbox"]').disabled`,
          );
          assert.equal(
            await evaluate("window.appShotPreviewCalls.arm"),
            before.arm,
          );
          // Keep subsequent capture scenarios at their existing platform defaults.
          await click(
            platform === "portal"
              ? 'input[value="chord"]'
              : 'input[value="both-shift"]',
          );
        }
        if (platform === "niri" || platform === "hyprland") {
          assert.equal(
            await evaluate(
              "Boolean(document.querySelector('[data-keybinding-capture]'))",
            ),
            false,
          );
        }
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
        if (platform === "kde" || platform === "hyprland") {
          assert.equal(
            await evaluate(
              "document.querySelector('.app-shot-shortcut details').open",
            ),
            false,
          );
          await click(".app-shot-shortcut details summary");
          await wait(
            "document.querySelector('.app-shot-shortcut details')?.open",
          );
          await stable();
          const setup = await evaluate(
            "document.querySelector('.app-shot-shortcut details').textContent",
          );
          assert.match(setup, /resources\/app-shot-linux\//);
          assert.match(setup, /用户自有路径/);
          assert.match(setup, /撤销/);
          receipt.states.push({
            phase: "native-manual-setup",
            ...(await check(width, height)),
          });
          await screenshot(`${name}-manual-setup.png`);
          await reveal(".app-shot-shortcut details > p:last-child");
          receipt.states.push({
            phase: "native-manual-revoke",
            ...(await check(width, height)),
            revokeVisible: true,
          });
          await screenshot(`${name}-manual-revoke.png`);
          await click(".app-shot-shortcut details summary");
          await stable();
        }
        if (platform === "hyprland") {
          await click(".app-shot-hyprland-binding summary");
          await wait(
            "document.querySelector('.app-shot-hyprland-binding')?.open",
          );
          await stable();
          const binding = await evaluate(
            "document.querySelector('.app-shot-hyprland-binding').textContent",
          );
          assert.match(binding, /xdg-desktop-portal-hyprland/);
          assert.match(
            binding,
            /bind = CTRL SHIFT, 2, global, io\.github\.albert_zen\.ZenX:capture-window/,
          );
          assert.match(binding, /hl\.bind/);
          receipt.states.push({
            phase: "hyprland-manual-binding",
            ...(await check(width, height)),
          });
          await screenshot(`${name}-manual-binding.png`);
          await reveal(".app-shot-hyprland-binding pre:last-child");
          receipt.states.push({
            phase: "hyprland-lua-binding",
            ...(await check(width, height)),
            luaVisible: true,
          });
          await screenshot(`${name}-lua-binding.png`);
          await click(".app-shot-hyprland-binding summary");
          await click('.app-shot-shortcut input[type="checkbox"]');
          await wait(
            "document.querySelector('.app-shot-shortcut input[type=checkbox]').checked",
          );
          const state = await evaluate(
            "document.querySelector('.app-shot-shortcut').textContent",
          );
          assert.match(state, /捕获动作已注册/);
          assert.equal(state.includes("桌面快捷键："), false);
          assert.equal(state.includes("配置桌面快捷键"), false);
          receipt.states.push({
            phase: "hyprland-action-only",
            ...(await check(width, height)),
          });
          await screenshot(`${name}-action-only.png`);
          await click('.app-shot-shortcut input[type="checkbox"]');
          await wait(
            "!document.querySelector('.app-shot-shortcut input[type=checkbox]').checked",
          );
        }
        if (
          platform === "portal" ||
          platform === "gnome" ||
          platform === "kde"
        ) {
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

        if (context === "semantic") {
          await click(".app-shot-option input");
          await wait(
            "document.querySelector('.app-shot-option input').checked",
          );
        }
        const capturesBeforeSelection = await evaluate(
          "window.appShotPreviewCalls.capture",
        );
        await click(".app-shot-sources button");
        await wait(`(${measure}).imageReady`);
        await stable();
        const review = await check(width, height);
        assert.match(review.context, /Example Notes/);
        if (context === "semantic") {
          assert.match(review.context, /"format":"element-tree"/);
          assert.match(review.context, /"actions":\["press"\]/);
          assert.match(review.context, /"bounds":null/);
          assert.match(
            review.context,
            /"bounds":\{"x":52,"y":145,"width":820,"height":80\}/,
          );
          assert.match(review.context, /review-end/);
        } else assert.match(review.context, /screenshot only/);
        assert.equal(review.count, "已添加 0 张，未发送。");
        assert.equal(
          await evaluate("window.appShotPreviewCalls.capture"),
          capturesBeforeSelection + 1,
          "Explicit window selection must increment the synthetic capture counter exactly once",
        );
        receipt.states.push({ phase: "review", ...review });
        await screenshot(`${name}-review.png`);
        if (context === "semantic") {
          const atEnd = await evaluate(`(() => {
            const e = document.querySelector('.app-shot-context');
            e.scrollTop = e.scrollHeight;
            return e.scrollHeight - e.clientHeight - e.scrollTop < 1 && e.textContent.endsWith(']}}');
          })()`);
          assert.equal(
            atEnd,
            true,
            "Full semantic JSON remains locally inspectable.",
          );
          receipt.states.push({
            phase: "semantic-context-end",
            contextEndReachable: true,
            ...(await check(width, height)),
          });
          await screenshot(`${name}-context-end.png`);
        }
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

      // Additional direct-shortcut scenarios use the actual ThreadView/Composer.
      // Only the fixture's armed listener is injected; no OS shortcut or window is read.
      for (const { theme, width, height, context } of [
        { theme: "light", width: 390, height: 600, context: "pixels" },
        { theme: "dark", width: 1280, height: 900, context: "pixels" },
        { theme: "light", width: 390, height: 600, context: "semantic" },
      ]) {
        const name = `composer-darwin-${theme}-${width}-${context}`;
        const receipt = {
          name,
          theme,
          width,
          height,
          platform: "darwin",
          context,
          states: [],
        };
        evidence.cases.push(receipt);
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const destination = `${url}/app-shot.html?mode=composer&theme=${theme}&platform=darwin&context=${context}`;
        await send("Page.navigate", { url: destination });
        await wait(
          `location.href===${JSON.stringify(destination)} && document.querySelectorAll('.app-shot-sources button').length===2`,
        );
        await click('input[type="radio"][value="both-shift"]');
        if (context === "semantic")
          await click('.app-shot-option input[type="checkbox"]');
        await click('.app-shot-shortcut input[type="checkbox"]');
        await wait(
          "document.querySelector('.app-shot-shortcut input[type=checkbox]').checked && !document.querySelector('.app-shot-shortcut input[type=checkbox]').disabled",
        );
        await click(".app-shot-heading button");
        await wait("!document.querySelector('[role=dialog]')");
        await evaluate("window.emitAppShotShortcutCapture()");
        await wait(
          "window.appShotComposerSnapshot?.imageCount === 1 && document.querySelector('.draft-image img')?.naturalWidth > 0",
        );
        assert.equal(
          await evaluate("document.querySelectorAll('[role=dialog]').length"),
          0,
          "Shortcut success stages directly without a capture modal.",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('.draft-image').closest('.composer') === null",
          ),
          true,
          "The attachment uses the existing shelf outside Composer.",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('.draft-image pre, .draft-image details') === null",
          ),
          true,
          "Context is not a permanent shelf disclosure.",
        );
        assert.equal(
          await evaluate(
            "document.activeElement === document.querySelector('#synthetic-app-shot-composer')",
          ),
          true,
          "Direct capture returns focus to the same Composer.",
        );
        const calls = await evaluate("({...window.appShotPreviewCalls})");
        assert.equal(calls.shortcutCapture, 1);
        assert.equal(
          calls.capture,
          0,
          "Opening and attaching never repeats capture.",
        );
        assert.equal(calls.attach, 1);
        assert.equal(calls.send, 0);
        receipt.states.push({
          phase: "shortcut-direct-draft-no-modal",
          ...(await check(width, height)),
          calls,
        });
        await screenshot(`${name}-direct-draft.png`);

        await click(".draft-image .image-thumbnail");
        await wait(
          "document.querySelector('.app-shot-attachment-context pre') && document.querySelector('.app-shot-attachment-preview img')?.naturalWidth > 0",
        );
        const details = await evaluate(`(() => {
          const text = document.querySelector('.app-shot-attachment-context pre').textContent;
          const state = window.appShotComposerSnapshot;
          const sent = JSON.parse(state.preparedText.slice(state.preparedText.indexOf('\\n') + 1));
          const dialog = document.querySelector('.app-shot-attachment-preview');
          const bounds = document.querySelector('.app-shot-attachment-preview .image-preview-content').getBoundingClientRect();
          return {
            exactContext: text === state.contexts[0] && text === sent[0].context,
            readOnly: dialog.querySelectorAll('button').length === 1 && !dialog.querySelector('input, textarea'),
            contentWithinViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1,
            context: text,
          };
        })()`);
        assert.equal(
          details.exactContext,
          true,
          "Viewer text equals the exact data in ordinary Send preparation.",
        );
        assert.equal(
          details.readOnly,
          true,
          "The viewer has only its Close action.",
        );
        assert.equal(details.contentWithinViewport, true);
        assert.equal(await evaluate("window.appShotPreviewCalls.send"), 0);
        receipt.states.push({
          phase: "attachment-details",
          ...(await check(width, height)),
          ...details,
        });
        await screenshot(`${name}-details.png`);
        if (context === "semantic") {
          assert.match(details.context, /review-end/);
          const endReachable = await evaluate(`(() => {
            const content = document.querySelector('.app-shot-attachment-preview .image-preview-content');
            content.scrollTop = content.scrollHeight;
            const end = document.querySelector('.app-shot-attachment-context pre').getBoundingClientRect();
            const close = document.querySelector('.image-preview-close').getBoundingClientRect();
            return content.scrollHeight - content.clientHeight - content.scrollTop < 1 && end.bottom <= content.getBoundingClientRect().bottom + 1 && close.top >= 0 && close.bottom <= innerHeight;
          })()`);
          assert.equal(
            endReachable,
            true,
            "Long context ends and Close remain reachable in a 390 × 600 window.",
          );
          receipt.states.push({
            phase: "attachment-context-end",
            contextEndReachable: true,
            ...(await check(width, height)),
          });
          await screenshot(`${name}-context-end.png`);
        }
        for (const type of ["rawKeyDown", "keyUp"])
          await send("Input.dispatchKeyEvent", {
            type,
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
          });
        await wait("!document.querySelector('[role=dialog]')");
        assert.equal(
          await evaluate(
            "document.activeElement === document.querySelector('.draft-image .image-thumbnail')",
          ),
          true,
        );
        await click(".draft-image .image-thumbnail");
        await wait(
          "Boolean(document.querySelector('.app-shot-attachment-context'))",
        );
        await click(".image-preview-close");
        await wait("!document.querySelector('[role=dialog]')");
        assert.equal(
          await evaluate(
            "document.activeElement === document.querySelector('.draft-image .image-thumbnail')",
          ),
          true,
        );
        await click(".remove-draft-image");
        await wait(
          "window.appShotComposerSnapshot.imageCount === 0 && !document.querySelector('.draft-image')",
        );
        const removed = await evaluate(
          "({snapshot: window.appShotComposerSnapshot, calls: {...window.appShotPreviewCalls}})",
        );
        assert.equal(removed.snapshot.text, "请检查这张应用快照。");
        assert.deepEqual(removed.snapshot.contexts, []);
        assert.equal(removed.snapshot.preparedText, "");
        assert.equal(removed.calls.remove, 1);
        assert.equal(removed.calls.attach, 1);
        assert.equal(removed.calls.capture, 0);
        assert.equal(removed.calls.send, 0);
        receipt.states.push({
          phase: "removed-without-send",
          ...(await check(width, height)),
          ...removed,
        });
        await screenshot(`${name}-removed.png`);
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
