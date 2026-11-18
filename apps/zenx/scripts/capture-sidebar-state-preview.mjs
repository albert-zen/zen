import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Capture uses CI's existing Chrome only.",
);
const directory = path.resolve(process.argv[2] ?? ".sidebar-state-preview");
const cases = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    const waitFor = async (expression) => {
      for (let i = 0; i < 200; i++) {
        assert.deepEqual(errors, [], "Sidebar renderer exceptions");
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw Error(`Timed out: ${expression}`);
    };
    const pointerSelect = async (id) => {
      const point = await evaluate(`(() => {
        const button = document.getElementById(${JSON.stringify(id)});
        const r = button.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (r.width <= 0 || r.height <= 0 || !button.contains(document.elementFromPoint(x, y))) throw Error('Owner tab not hit-testable');
        return { x, y };
      })()`);
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: 1,
      });
    };
    const arrow = async (key, code) => {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code: key,
        windowsVirtualKeyCode: code,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code: key,
        windowsVirtualKeyCode: code,
      });
    };
    const verifyOwner = async (owner, keyboard = false) => {
      const id = `file:@thread-${owner}:README.md`;
      await waitFor(
        `(() => { const result = window.__sidebarFixture.measure(); return result.states.find(s => s.owner.kind === 'room')?.selectedTab === ${JSON.stringify(id)} && result.selectedDocument?.includes(${JSON.stringify(owner === "a" ? "设计任务 A" : "协作成员 B")}) && result.calls.some(call => call.method === 'read' && call.threadId === ${JSON.stringify(`thread-${owner}`)} && call.path === 'README.md'); })()`,
      );
      const result = await evaluate("window.__sidebarFixture.measure()");
      assert.match(
        result.selectedDocument,
        owner === "a" ? /设计任务 A/ : /协作成员 B/,
      );
      assert.ok(
        result.calls.some(
          (call) =>
            call.method === "read" &&
            call.threadId === `thread-${owner}` &&
            call.path === "README.md",
        ),
        "Exact synthetic owner/path was read (cached document reuse allowed)",
      );
      if (keyboard) assert.equal(result.activeId, `aux-tab-${id}`);
      const selectedLabel = result.labels.find(
        (label) => label.selected === "true",
      );
      assert.ok(
        selectedLabel?.closeHit && selectedLabel.closeOpacity > 0,
        "Selected tab Close is painted and hit-testable after real pointer/key input",
      );
      return result;
    };
    const verifyLabels = async (expected) => {
      let lastKey;
      let stable = 0;
      let result;
      for (let i = 0; i < 200; i++) {
        assert.deepEqual(errors, [], "Sidebar renderer exceptions");
        const sample = await evaluate(`(() => {
          if (document.fonts?.status !== 'loaded') return null;
          const result = window.__sidebarFixture.measure();
          return result.labels.length === 2 && result.labels.every(label =>
            label.owner && label.owner.clientWidth > 0 && label.owner.scrollWidth <= label.owner.clientWidth
          ) ? result : null;
        })()`);
        const key = sample ? JSON.stringify(sample.labels) : undefined;
        stable = key === undefined ? 0 : key === lastKey ? stable + 1 : 1;
        lastKey = key;
        if (stable === 3) {
          result = sample;
          break;
        }
        await delay(50);
      }
      assert.ok(result, "Labels must fit and settle with loaded fonts");
      assert.equal(result.labels.length, 2);
      for (const [index, label] of result.labels.entries()) {
        assert.ok(label.label.includes(expected[index]));
        assert.ok(label.title.includes(expected[index]));
        assert.ok(label.closeLabel.includes(expected[index]));
        assert.ok(
          label.owner.scrollWidth <= label.owner.clientWidth,
          "Source text must fit rather than merely ellipsize",
        );
        assert.ok(
          label.filename?.rect.height > 0 &&
            label.filename.rect.top >= label.tab.top &&
            label.filename.rect.bottom <= label.owner.rect.top &&
            label.owner.rect.height > 0 &&
            label.owner.rect.bottom <= label.tab.bottom,
          "Both lines remain inside existing tab height",
        );
        assert.ok(
          label.filename.rect.width > 0 &&
            label.filename.rect.left >= label.tab.left &&
            label.filename.rect.right <= label.tab.right &&
            label.filename.rect.right <= label.close.left &&
            label.owner.rect.left >= label.tab.left &&
            label.owner.rect.right <= label.close.left,
          "Both label boxes stay in the tab and clear Close (normal filename ellipsis is allowed)",
        );
        assert.ok(
          label.tab.height <= 30.5 && label.closeHit,
          "Existing rail budget and unobstructed Close geometry (not a visibility claim)",
        );
      }
      assert.notEqual(result.labels[0].owner.text, result.labels[1].owner.text);
      return result;
    };
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: `${url}/sidebar-state.html` });
    await waitFor(
      "!!window.__sidebarFixture && !!document.querySelector('[data-owner=thread-b]')",
    );
    await evaluate("window.__sidebarFixture.background()");
    await delay(100);
    let evidence = await evaluate("window.__sidebarFixture.measure()");
    assert.equal(evidence.owner.id, "thread-b");
    assert.ok(
      !evidence.calls.some(
        (call) =>
          call.method === "read" ||
          call.method === "materialize" ||
          call.method === "new",
      ),
    );
    await screenshot("01-background-a-foreground-b.png");
    cases.push(evidence);
    await evaluate("document.querySelector('[data-owner=thread-a]').click()");
    await waitFor(
      "window.__sidebarFixture.measure().calls.some(call => call.method === 'read') && !!document.querySelector('.cm-editor')",
    );
    await screenshot("02-thread-a-restored.png");
    evidence = await evaluate("window.__sidebarFixture.measure()");
    assert.equal(evidence.owner.id, "thread-a");
    cases.push(evidence);
    await evaluate("window.__sidebarFixture.room()");
    await evaluate(
      "document.querySelector('[data-owner=room-shared]').click()",
    );
    await waitFor(
      "!!document.getElementById('aux-tab-file:@thread-b:README.md') && !!document.querySelector('.cm-editor')",
    );
    const memberTitles = ["成员 A", "成员 B"];
    evidence = await verifyLabels(memberTitles);
    assert.equal(evidence.owner.kind, "room");
    cases.push(evidence);
    await screenshot("03-shared-room-owned-resources.png");
    await pointerSelect("aux-tab-file:@thread-a:README.md");
    cases.push(await verifyOwner("a"));
    await arrow("ArrowRight", 39);
    await verifyOwner("b", true);
    cases.push(await verifyLabels(memberTitles));
    await screenshot("04-shared-room-keyboard-owner-b.png");
    await arrow("ArrowLeft", 37);
    await verifyOwner("a", true);
    cases.push(await verifyLabels(memberTitles));
    await screenshot("05-shared-room-return-owner-a.png");
    await send("Page.navigate", {
      url: `${url}/sidebar-state.html?owners=shared-prefix`,
    });
    await waitFor("!!window.__sidebarFixture");
    await evaluate("window.__sidebarFixture.room()");
    await evaluate(
      "document.querySelector('[data-owner=room-shared]').click()",
    );
    await waitFor(
      "!!document.getElementById('aux-tab-file:@thread-b:README.md') && !!document.querySelector('.cm-editor')",
    );
    cases.push(
      await verifyLabels([
        "Release readiness and documentation review Alpha",
        "Release readiness and documentation review Beta",
      ]),
    );
    await screenshot("06-shared-prefix-room-file-owners.png");
  },
);
await writeFile(
  path.join(directory, "evidence.json"),
  JSON.stringify(
    {
      scope:
        "Actual production components/controller, synthetic ports only. No native Electron or production data.",
      cases,
    },
    null,
    2,
  ),
);
