import assert from "node:assert/strict";

export const roomPreviewPaths = [
  ".github/workflows/room-file-owner-preview.yml",
  "apps/zenx/scripts/build-room-file-owner-preview.mjs",
  "apps/zenx/scripts/room-file-owner-main-ui-preview.mjs",
  "apps/zenx/scripts/capture-main-ui-preview.mjs",
  "apps/zenx/scripts/sidebar-state-preview.tsx",
  "apps/zenx/scripts/build-sidebar-state-preview.mjs",
  "apps/zenx/scripts/prepare-preview-fonts.mjs",
  "apps/zenx/scripts/preview-font-probe.mjs",
  "apps/zenx/scripts/preview-fonts-OFL.txt",
  "apps/zenx/scripts/preview-browser-lifecycle.mjs",
  "apps/zenx/src/renderer/src/auxiliary-panel.tsx",
  "apps/zenx/src/renderer/src/room-file-owner-labels.ts",
  "apps/zenx/src/renderer/src/workspace-resting-labels.ts",
  "apps/zenx/src/renderer/src/i18n/panels.ts",
  "apps/zenx/src/renderer/src/styles.css",
  "apps/zenx/src/renderer/src/theme.css",
  "apps/zenx/test/room-file-owner-preview.test.mjs",
  "apps/zenx/test/room-file-owner-labels.test.ts",
  "apps/zenx/test/room-file-owner-tabs.test.ts",
  "package-lock.json",
];
export const roomPreviewNeeded = (paths, expected, checkout, current) =>
  /^[a-f0-9]{40}$/.test(expected ?? "") &&
  expected === checkout &&
  expected === current &&
  paths.some((path) => roomPreviewPaths.includes(path));

export const roomReceiptPaths = roomPreviewPaths.filter(
  (file) => !file.includes("/test/"),
);

export function assertRoomReceipt(source, expected) {
  assert.match(expected ?? "", /^[a-f0-9]{40}$/);
  assert.equal(source.commit, expected);
  assert.match(source.tree ?? "", /^[a-f0-9]{40}$/);
  assert.equal(source.clean, true);
  assert.deepEqual(Object.keys(source.scenes ?? {}), ["room"]);
  assert.equal(source.scenes.room.html, "room.html");
  assert.match(source.scenes.room.sha256 ?? "", /^[a-f0-9]{64}$/);
  const entries = Object.entries(source.sources ?? {});
  for (const file of roomReceiptPaths)
    assert.ok(
      Object.hasOwn(source.sources ?? {}, file),
      `Missing Room source: ${file}`,
    );
  for (const [file, hash] of entries) {
    assert.ok(
      (file.startsWith("apps/zenx/") ||
        file === "package-lock.json" ||
        file === ".github/workflows/room-file-owner-preview.yml") &&
        !file
          .split("/")
          .some((part) => !part || part === "." || part === "..") &&
        !file.includes("\\"),
      "Ordinary repo-relative source receipt only",
    );
    assert.match(hash, /^[a-f0-9]{64}$/);
  }
}

export function assertRoomLabels(result, titles) {
  assert.equal(result.owner.kind, "room");
  assert.equal(result.labels.length, 2);
  for (const [index, label] of result.labels.entries()) {
    assert.equal(label.id, `file:@thread-${index ? "b" : "a"}:README.md`);
    for (const value of [label.label, label.title, label.closeLabel])
      assert.ok(value.includes(titles[index]));
    assert.ok(
      label.owner?.clientWidth > 0 &&
        label.owner.scrollWidth <= label.owner.clientWidth,
      "Actual source text fits",
    );
    assert.ok(
      label.filename?.rect.height > 0 &&
        label.filename.rect.top >= label.tab.top &&
        label.filename.rect.bottom <= label.owner.rect.top &&
        label.owner.rect.height > 0 &&
        label.owner.rect.bottom <= label.tab.bottom,
      "Both rows fit vertically",
    );
    for (const row of [label.filename.rect, label.owner.rect])
      assert.ok(
        row.width > 0 &&
          row.left >= label.tab.left &&
          row.right <= label.tab.right &&
          row.right <= label.close.left,
        "Rows clear Close and stay in their tab; basename ellipsis is permitted",
      );
    assert.ok(
      label.tab.height <= 30.5 && label.closeHit,
      "Unchanged rail budget and hit geometry, not Close visibility",
    );
  }
  assert.notEqual(result.labels[0].owner.text, result.labels[1].owner.text);
}

export function roomOwnerReady(result, owner) {
  const id = `file:@thread-${owner}:README.md`;
  return (
    result?.owner?.kind === "room" &&
    result.owner.id === "room-shared" &&
    result.states?.find(
      (state) =>
        state.owner.kind === "room" && state.owner.id === "room-shared",
    )?.selectedTab === id &&
    result.selectedDocument?.includes(
      owner === "a" ? "设计任务 A" : "协作成员 B",
    ) &&
    result.calls?.some(
      (call) =>
        call.method === "read" &&
        call.threadId === `thread-${owner}` &&
        call.path === "README.md",
    )
  );
}

/** Production component/synthetic ports only; no new answer or external command. */
export async function captureRoomFileOwners({
  send,
  evaluate,
  wait,
  click,
  capture,
  diagnostic,
  evidence,
  options,
  url,
}) {
  const titles = ["成员 A", "成员 B"];
  evidence.roomCases ??= [];
  const settle = async (expected) => {
    let prior,
      stable = 0,
      result;
    for (let i = 0; i < 100; i++) {
      assert.deepEqual(evidence.rendererErrors, []);
      const sample = await evaluate(
        "document.fonts.status === 'loaded' && window.__sidebarFixture?.measure()",
      );
      const key =
        sample?.labels?.length === 2 &&
        sample.labels.every(
          (label) =>
            label.owner?.clientWidth > 0 &&
            label.owner.scrollWidth <= label.owner.clientWidth,
        )
          ? JSON.stringify(sample.labels)
          : undefined;
      stable = key === undefined ? 0 : key === prior ? stable + 1 : 1;
      prior = key;
      if (stable === 3) {
        result = sample;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(result, "Room labels settle and fit with loaded fonts");
    assertRoomLabels(result, expected);
    return result;
  };
  const record = async (suffix, expected) => {
    const result = await settle(expected);
    await send("DOM.enable");
    await send("CSS.enable");
    const { root } = await send("DOM.getDocument");
    const faces = [];
    for (let index = 1; index <= 2; index++) {
      const selector = `.workspace-content-tab:nth-child(${index}) .workspace-tab-label-box > .workspace-tab-title`;
      const { nodeId } = await send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector,
      });
      assert.ok(nodeId, "Actual production source-label node exists");
      const { fonts } = await send("CSS.getPlatformFontsForNode", { nodeId });
      faces.push({
        selector,
        fonts: fonts.filter((font) => font.glyphCount > 0),
      });
      assert.ok(
        faces.at(-1).fonts.length,
        "Production label has rendered glyph faces",
      );
    }
    const appearance = await evaluate(
      "document.documentElement.dataset.appearance",
    );
    assert.equal(
      appearance,
      options.theme,
      "Actual fixture theme matches capture label",
    );
    const name = `room-${options.theme}-${suffix}`;
    evidence.roomCases.push({
      screenshot: `${name}.png`,
      ...result,
      appearance,
      viewport: {
        width: options.width,
        height: options.height,
        deviceScaleFactor: 1,
      },
      visibleSourceNames: result.labels.map((label) => label.owner.text),
      htmlLang: await evaluate("document.documentElement.lang"),
      faces,
      fontScope:
        "Actual production fallback faces, not an assertion of SC or equivalence to prior apt screenshots",
    });
    await capture(name, options, "room");
  };
  const waitOwner = (owner) =>
    wait(
      `(${roomOwnerReady.toString()})(window.__sidebarFixture.measure(), ${JSON.stringify(owner)})`,
    );
  const select = async (owner, key) => {
    if (key) {
      const code = key === "ArrowRight" ? 39 : 37;
      for (const type of ["keyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", {
          type,
          key,
          code: key,
          windowsVirtualKeyCode: code,
        });
    } else await click(`[id="aux-tab-file:@thread-${owner}:README.md"]`);
    await waitOwner(owner);
    const r = await evaluate("window.__sidebarFixture.measure()");
    if (key)
      assert.equal(r.activeId, `aux-tab-file:@thread-${owner}:README.md`);
    assert.ok(
      r.labels.find((label) => label.selected === "true")?.closeOpacity > 0,
      "Selected Close painted after actual pointer/key input",
    );
  };
  let loaded = false;
  try {
    await wait("!!window.__sidebarFixture");
    loaded = true;
    await evaluate("window.__sidebarFixture.room()");
    await click('[data-owner="room-shared"]');
    await waitOwner("b");
    await record("members", titles);
    await select("a");
    await select("b", "ArrowRight");
    await select("a", "ArrowLeft");
    await record("keyboard-return", titles);
    const shared = new URL(url);
    shared.searchParams.set("owners", "shared-prefix");
    await send("Page.navigate", { url: shared.href });
    await wait(
      `location.href === ${JSON.stringify(shared.href)} && !!window.__sidebarFixture`,
    );
    await evaluate("window.__sidebarFixture.room()");
    await click('[data-owner="room-shared"]');
    await waitOwner("b");
    await record("shared-prefix", [
      "Release readiness and documentation review Alpha",
      "Release readiness and documentation review Beta",
    ]);
  } catch (error) {
    evidence.roomFailure = {
      status: "failed",
      error: String(error),
      diagnosticNotAcceptance: true,
    };
    if (loaded)
      await diagnostic(`diagnostic-room-${options.theme}-failed`).catch(
        (diagnosticError) => {
          evidence.roomFailure.diagnosticError = String(diagnosticError);
        },
      );
    throw error;
  }
}
