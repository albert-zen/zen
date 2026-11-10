/** Real Chromium layout/input checks; browser-page content and ports are synthetic. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";

const directory = path.resolve(
  process.argv[2] ?? ".fullscreen-primary-chat-preview",
);
const report = {
  scope:
    "Real Chromium geometry and pointer interaction with production AuxiliaryPanel and ThreadView. Synthetic conversations, browser page DOM and mount receipts only. Not native WebContentsView/webview, Host, full App/header integration, OS input or packaged Electron acceptance.",
  source: JSON.parse(
    await readFile(path.join(directory, "source.json"), "utf8"),
  ),
  scenes: [],
  status: "running",
};
const panel = "#thread-workspace-panel";
const primaryTab = "#aux-tab-primary-conversation";
const expand = `${panel} > .auxiliary-heading > button[aria-pressed]`;
const measure = `(() => {
  const root = document.querySelector('#primary-conversation-content');
  const read = (selector) => {
    const e = typeof selector === "string" ? document.querySelector(selector) : selector; if (!e) return null;
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom,
      clientWidth:e.clientWidth, scrollWidth:e.scrollWidth, clientHeight:e.clientHeight,
      scrollHeight:e.scrollHeight, scrollTop:e.scrollTop, visibility:s.visibility,
      display:s.display, paddingTop:parseFloat(s.paddingTop), paddingBottom:parseFloat(s.paddingBottom) };
  };
  const editor = root?.querySelector('textarea, .cm-content');
  const r = editor?.getBoundingClientRect();
  const hit = r && document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
  return {
    viewport:{width:innerWidth,height:innerHeight}, workspace:read('.workspace'),
    primary:read('#primary-conversation-content'), thread:read('#primary-conversation-content .thread-view'),
    virtual:read('#primary-conversation-content .experimental-transcript-viewport'),
    virtualParent:read(root?.querySelector('.experimental-transcript-viewport')?.parentElement),
    rows:[...root.querySelectorAll('.virtual-transcript-row')].map(read),
    messages:read('#primary-conversation-content .messages'), composer:read('#primary-conversation-content .composer'),
    anchor:(() => {
      const viewport=root?.querySelector('.messages');
      if (!viewport) return null;
      const top=viewport.getBoundingClientRect().top;
      const row=[...viewport.querySelectorAll('[data-transcript-row-key]')]
        .filter(e=>e.getBoundingClientRect().bottom>top)
        .sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0];
      return row ? {key:row.dataset.transcriptRowKey,offset:row.getBoundingClientRect().top-top} : null;
    })(),
    paused:!!root?.querySelector('.back-live'),
    bottom:read('#primary-conversation-content .bottom-zone'), heading:read('.auxiliary-heading'),
    panel:read('#thread-workspace-panel'), overview:read('.fixture-overview'),
    selected:document.querySelector('[role="tab"][aria-selected="true"]')?.id,
    expanded:document.querySelector('#thread-workspace-panel')?.dataset.expanded,
    primaryActive:document.querySelector('#thread-workspace-panel')?.dataset.primaryActive,
    visiblePrimaryDescendants:[...root.querySelectorAll('*')].filter(e=>getComputedStyle(e).visibility==='visible').length,
    browserHidden:document.querySelector('.synthetic-native-page')?.hidden,
    draft:editor?.value ?? editor?.textContent,
    samePrimary:root===window.__layoutIdentity?.primary,
    sameEditor:editor===window.__layoutIdentity?.editor,
    editorHit:!!hit && (editor===hit || editor.contains(hit)),
    receipts:window.__fullscreenPrimaryPreview?.receipts.slice(-12)
  };
})()`;
const near = (actual, expected, label) =>
  assert.ok(
    Math.abs(actual - expected) <= 2,
    `${label}: ${actual} vs ${expected}`,
  );
function checkPrimary(m, draft) {
  assert.equal(m.selected, "aux-tab-primary-conversation");
  assert.equal(m.primaryActive, "true");
  assert.equal(m.primary.visibility, "visible");
  assert.equal(
    m.browserHidden,
    true,
    "synthetic browser relinquishes its page surface",
  );
  assert.ok(
    m.samePrimary && m.sameEditor,
    "original conversation and composer nodes survive switching",
  );
  assert.equal(m.draft, draft, "unsent draft survives switching");
  assert.ok(
    m.editorHit,
    "composer receives pointer hits, not the transparent workspace overlay",
  );
  near(
    m.primary.width,
    m.workspace.width,
    "main conversation uses the full workspace width",
  );
  near(
    m.primary.height,
    m.workspace.height,
    "main conversation uses the full workspace height",
  );
  near(
    m.thread.height,
    m.primary.height - m.primary.paddingTop - m.primary.paddingBottom,
    "ThreadView fills restored content area",
  );
  near(
    m.thread.bottom,
    m.primary.bottom - m.primary.paddingBottom,
    "ThreadView reaches the content bottom",
  );
  assert.ok(
    m.thread.y >= m.heading.bottom - 2,
    "conversation starts below the expanded tab strip",
  );
  assert.ok(
    m.virtual,
    "production virtual transcript is active (not fallback DOM)",
  );
  assert.ok(
    m.virtual.width > 300,
    "virtual scroller is not latched to a narrow inline width",
  );
  near(
    m.virtual.width,
    m.virtualParent.width,
    "virtual scroller fills its containing block",
  );
  assert.ok(m.rows.length > 0, "virtual transcript rows are rendered");
  for (const row of m.rows) {
    assert.ok(
      row.width > 200,
      "virtual row is not collapsed to one-pixel text wrapping",
    );
    assert.ok(
      row.x >= m.primary.x - 2 && row.right <= m.primary.right + 2,
      "virtual row remains inside the main surface",
    );
  }
  assert.ok(
    m.messages.height > 250,
    "transcript has a usable reading area, not a collapsed grid row",
  );
  assert.ok(
    m.composer.height > 30 && m.composer.width > 200,
    "composer has usable geometry",
  );
  assert.ok(
    m.composer.y > m.thread.y + 160,
    "reading lane remains above the composer",
  );
  assert.ok(
    m.composer.bottom <= m.viewport.height + 1 &&
      m.composer.bottom >= m.thread.bottom - 70,
    "composer stays near the visible bottom",
  );
  for (const key of ["primary", "thread", "messages", "composer"])
    assert.ok(
      m[key].scrollWidth <= m[key].clientWidth + 2,
      `${key} has no horizontal overflow`,
    );
}
try {
  await withPreviewBrowser(
    directory,
    async ({ send, evaluate, url, screenshot, onEvent }) => {
      report.browserVersion = await send("Browser.getVersion");
      async function until(expression, label) {
        for (let i = 0; i < 120; i++) {
          if (await evaluate(expression)) return;
          await delay(50);
        }
        throw Error(`Timed out: ${label}`);
      }
      async function click(selector) {
        const point = await evaluate(`(() => {
        const e=document.querySelector(${JSON.stringify(selector)});
        if(!e) throw Error('Missing click target: '+${JSON.stringify(selector)});
        const r=e.getBoundingClientRect();
        const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
        if(!r.width || !r.height || !(hit===e || e.contains(hit))) throw Error('Occluded click target: '+${JSON.stringify(selector)});
        return {x,y};
      })()`);
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", {
            type,
            ...point,
            button: "left",
            clickCount: 1,
          });
        await delay(250);
      }
      for (const scene of [
        { width: 1280, height: 900, theme: "light", owner: "thread-a" },
        { width: 1000, height: 700, theme: "light", owner: "thread-a" },
        { width: 1280, height: 900, theme: "dark", owner: "thread-b" },
        { width: 1000, height: 700, theme: "dark", owner: "thread-b" },
      ]) {
        const result = { ...scene, status: "running", observations: [] };
        report.scenes.push(result);
        const prefix = `${scene.width}x${scene.height}-${scene.theme}-${scene.owner}`;
        async function capture(phase) {
          result.phase = phase;
          const m = await evaluate(measure);
          result.observations.push({ phase, ...m });
          await screenshot(`${prefix}-${phase}.png`);
          return m;
        }
        try {
          await send("Emulation.setDeviceMetricsOverride", {
            width: scene.width,
            height: scene.height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const destination = `${url}/fullscreen-primary-chat.html?theme=${scene.theme}&owner=${scene.owner}`;
          await send("Page.navigate", { url: destination });
          await until(
            `location.href===${JSON.stringify(destination)} && document.body?.dataset.previewReady==='true' && !!document.querySelector('#primary-conversation-content textarea, #primary-conversation-content .cm-content') && document.querySelector('.synthetic-native-page')?.hidden===false`,
            "fixture ready with synthetic browser page",
          );
          await evaluate("document.fonts.ready.then(() => true)");
          await delay(300);
          await evaluate(
            `(() => { window.__layoutIdentity={primary:document.querySelector('#primary-conversation-content'),editor:document.querySelector('#primary-conversation-content textarea, #primary-conversation-content .cm-content')}; return true; })()`,
          );
          const split = await capture("split-browser");
          // Below the existing 1100px breakpoint, a resource replaces the
          // conversation instead of compressing it. Preserve that contract.
          const overlayMode = scene.width < 1100;
          assert.equal(
            split.primary.display === "none",
            overlayMode,
            "resource presentation follows the existing 1100px breakpoint",
          );
          if (overlayMode)
            near(
              split.panel.width,
              split.workspace.width,
              "narrow resource fills workspace",
            );
          else {
            assert.ok(
              split.primary.width > 0,
              "split conversation remains visible",
            );
            near(
              split.primary.width + split.panel.width,
              split.workspace.width,
              "initial split allocation",
            );
          }
          result.presentation = overlayMode
            ? "narrow-resource-overlay"
            : "split";
          // Real production layout, synthetic DOM toggle. Retain every sampled
          // frame to distinguish an animated resize from a final-width-only pass.
          await send("Emulation.setEmulatedMedia", {
            features: [
              { name: "prefers-reduced-motion", value: "no-preference" },
            ],
          });
          for (const phase of [
            "close",
            "reopen",
            "close-again",
            "reopen-again",
          ]) {
            // CDP returns a bounded sample of actual compositor frames, not a
            // promise of every display frame. Keep timestamps/gaps for review.
            const filmstrip = { frames: [], discarded: 0, errors: [] };
            const writes = [];
            const remove = onEvent(
              "Page.screencastFrame",
              ({ data, metadata, sessionId }) => {
                writes.push(
                  send("Page.screencastFrameAck", { sessionId }).catch(
                    (error) => filmstrip.errors.push(String(error)),
                  ),
                );
                if (filmstrip.frames.length >= 60) {
                  filmstrip.discarded++;
                  return;
                }
                const file = `${prefix}-${phase}-paint-${String(filmstrip.frames.length).padStart(3, "0")}.jpg`;
                filmstrip.frames.push({ file, ...metadata });
                writes.push(
                  writeFile(
                    path.join(directory, file),
                    Buffer.from(data, "base64"),
                  ).catch((error) => filmstrip.errors.push(String(error))),
                );
              },
            );
            let trajectory;
            try {
              await send("Page.startScreencast", {
                format: "jpeg",
                quality: 85,
                everyNthFrame: 1,
              });
              trajectory = await evaluate(`(async () => {
                const rawFrames = [], frames = [], observerFrames = [], started = performance.now();
                const read = () => {
                  const panel = document.querySelector('#thread-workspace-panel').getBoundingClientRect();
                  const primary = document.querySelector('#primary-conversation-content').getBoundingClientRect();
                  const rows = [...document.querySelectorAll('#primary-conversation-content .virtual-transcript-row')].map(e => { const r=e.getBoundingClientRect(); return { x:r.x, right:r.right, width:r.width }; });
                  return { elapsed:performance.now()-started, panel:panel.width, primary:primary.width, x:primary.x, right:primary.right, rows };
                };
                // This observer is registered after the production observer.
                // Its callback measures the same resize-delivery boundary after
                // the product has committed its shared allocation. A normal
                // deferred React update would still be stale here.
                const observer = new ResizeObserver(() => observerFrames.push(read()));
                observer.observe(document.querySelector('#thread-workspace-panel'), { box: 'border-box' });
                try {
                  document.querySelector('#thread-browser-toggle').click();
                  while (performance.now() - started < 450) {
                    await new Promise(requestAnimationFrame);
                    rawFrames.push(read());
                    // A later task can force a newer animation layout before its
                    // observer delivery; retain it as diagnostics, not paint proof.
                    await new Promise(resolve => setTimeout(resolve, 0));
                    frames.push(read());
                  }
                } finally {
                  observer.disconnect();
                }
                return { started, timeOrigin:performance.timeOrigin, rawFrames, frames, observerFrames };
              })()`);
            } finally {
              try {
                await send("Page.stopScreencast");
              } catch (error) {
                filmstrip.errors.push(String(error));
              }
              remove();
              await Promise.all(writes);
              result.observations.push({
                phase: `compression-${phase}`,
                ...trajectory,
                filmstrip,
              });
            }
            assert.deepEqual(
              filmstrip.errors,
              [],
              "compositor evidence writes and acknowledgments succeed",
            );
            assert.equal(
              filmstrip.discarded,
              0,
              "bounded compositor capture did not overflow",
            );
            assert.ok(
              filmstrip.frames.length > 2,
              `${phase}: compositor emitted multiple painted frames`,
            );
            const { frames } = trajectory;
            const closing = phase.startsWith("close");
            assert.ok(
              new Set(frames.map((f) => Math.round(f.panel))).size > 2,
              `${phase}: panel width actually animates`,
            );
            if (overlayMode && !closing) {
              for (const f of frames)
                near(
                  f.primary,
                  0,
                  `${phase}: narrow resource keeps the conversation hidden`,
                );
            } else {
              assert.ok(
                new Set(frames.map((f) => Math.round(f.primary))).size > 2,
                `${phase}: conversation width actually animates`,
              );
            }
            const last = frames.at(-1);
            near(
              last.panel,
              closing ? 0 : split.panel.width,
              `${phase}: settled panel width`,
            );
            near(
              last.primary + last.panel,
              split.workspace.width,
              `${phase}: settled conversation allocation`,
            );
            const intermediate = trajectory.observerFrames.filter(
              (f) => f.panel > 40 && f.panel < split.panel.width - 40,
            );
            assert.ok(
              intermediate.length > 0,
              `${phase}: intermediate resize deliveries were sampled`,
            );
            for (const f of intermediate) {
              if (overlayMode && !closing)
                near(
                  f.primary,
                  0,
                  `${phase}: narrow resource owns the surface`,
                );
              else
                near(
                  f.primary + f.panel,
                  split.workspace.width,
                  `${phase}: moving conversation allocation`,
                );
              assert.ok(
                f.rows.length > 0,
                `${phase}: moving virtual rows remain mounted`,
              );
              assert.ok(
                f.primary < split.workspace.width - 20,
                `${phase}: no early jump to full width`,
              );
              for (const row of f.rows)
                assert.ok(
                  row.x >= f.x - 2 && row.right <= f.right + 2,
                  `${phase}: moving virtual content stays inside conversation`,
                );
            }
            assert.ok(
              last.rows.length > 0,
              "actual virtual rows remain mounted",
            );
            for (const row of last.rows)
              assert.ok(
                row.x >= last.x - 2 && row.right <= last.right + 2,
                `${phase}: virtual content shrinks inside conversation`,
              );
            const settled = await capture(`compression-${phase}`);
            assert.ok(
              settled.samePrimary && settled.sameEditor,
              "resize never remounts conversation or draft",
            );
            assert.equal(settled.draft, split.draft, "resize preserves draft");
          }
          const browserTab = `[id="aux-tab-browser:page-${scene.owner}"]`;
          await click(expand);
          const expanded = await capture("expanded-browser");
          assert.equal(expanded.expanded, "true");
          assert.equal(
            expanded.selected,
            `aux-tab-browser:page-${scene.owner}`,
            "expansion preserves browser selection",
          );
          assert.equal(expanded.browserHidden, false);
          near(
            expanded.panel.width,
            expanded.workspace.width,
            "expanded browser panel fills workspace",
          );
          let first;
          let reading;
          const checkReading = (m, saved, phase) => {
            assert.equal(
              m.paused,
              true,
              `${phase}: manual reading remains paused`,
            );
            near(
              m.messages.scrollTop,
              saved.messages.scrollTop,
              `${phase}: native scroll offset`,
            );
            assert.equal(
              m.anchor?.key,
              saved.anchor?.key,
              `${phase}: same visible row`,
            );
            near(
              m.anchor.offset,
              saved.anchor.offset,
              `${phase}: same position within row`,
            );
          };
          const pauseByWheel = async (deltaY) => {
            const m = await evaluate(measure);
            await send("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: m.messages.x + m.messages.width / 2,
              y: m.messages.y + Math.min(160, m.messages.height / 3),
              deltaX: 0,
              deltaY,
            });
            await until(
              `!!document.querySelector('#primary-conversation-content .back-live') && document.querySelector('#primary-conversation-content .messages').scrollTop < ${m.messages.scrollTop - 2}`,
              "real upward wheel pauses live follow",
            );
            await delay(300);
          };
          for (let round = 1; round <= 3; round++) {
            await click(primaryTab);
            await until(
              "document.querySelector('#thread-workspace-panel').dataset.primaryActive==='true' && document.querySelector('.synthetic-native-page').hidden",
              "primary selected and synthetic browser hidden",
            );
            const m = await capture(`primary-${round}`);
            checkPrimary(m, split.draft);
            if (reading) checkReading(m, reading, `primary-${round}`);
            else {
              const range = m.messages.scrollHeight - m.messages.clientHeight;
              assert.ok(range > 200, "fixture provides scrollable history");
              await pauseByWheel(-range * 0.55);
              reading = await capture("paused-history");
              assert.ok(
                reading.anchor,
                "paused reader has a canonical virtual row anchor",
              );
              assert.ok(
                reading.messages.scrollTop > 50,
                "reader is away from both edges",
              );
            }
            if (first) {
              for (const key of ["primary", "thread", "composer"])
                for (const dimension of ["x", "y", "width", "height"])
                  near(
                    m[key][dimension],
                    first[key][dimension],
                    `${key}.${dimension} stable after repeated switches`,
                  );
            } else first = m;
            if (round < 3) {
              await click(browserTab);
              await until(
                "!document.querySelector('.synthetic-native-page').hidden",
                "synthetic browser remounted",
              );
              const hidden = await capture(`browser-${round}`);
              assert.equal(hidden.primaryActive, "false");
              assert.equal(hidden.primary.visibility, "hidden");
              assert.equal(
                hidden.visiblePrimaryDescendants,
                0,
                "resource tabs hide explicitly visible conversation descendants too",
              );
              assert.equal(
                await evaluate(`(() => {
                const root=document.querySelector('#primary-conversation-content');
                root.querySelector('textarea, .cm-content')?.focus();
                return root.contains(document.activeElement);
              })()`),
                false,
                "hidden conversation cannot take keyboard focus",
              );
              for (const dimension of ["width", "height"])
                near(
                  hidden.messages[dimension],
                  reading.messages[dimension],
                  `hidden transcript ${dimension}`,
                );
              near(
                hidden.messages.scrollTop,
                reading.messages.scrollTop,
                "hidden transcript retains native offset",
              );
            }
          }
          // Activity preview is distinct from an explicit resource-tab selection:
          // the owner's primary choice must survive while the Browser is displayed.
          const preview = (sequence) =>
            evaluate(
              `window.__fullscreenPrimaryPreview.preview(${JSON.stringify(scene.owner)}, ${sequence})`,
            );
          await preview(1);
          await until(
            "document.querySelector('#thread-workspace-panel').dataset.primaryActive==='false' && !document.querySelector('.synthetic-native-page').hidden",
            "activity preview overrides retained primary choice",
          );
          const activity = await capture("activity-preview");
          assert.equal(activity.primary.visibility, "hidden");
          assert.equal(activity.visiblePrimaryDescendants, 0);
          assert.equal(
            await evaluate(
              "getComputedStyle(document.querySelector('.workspace-browser-address')).visibility",
            ),
            "visible",
          );
          await click(primaryTab);
          const returned = await capture("activity-preview-return");
          checkPrimary(returned, split.draft);
          checkReading(returned, reading, "activity preview return");
          await preview(1);
          await delay(300);
          assert.equal(
            (await evaluate(measure)).primaryActive,
            "true",
            "dismissed activity stays hidden",
          );
          await preview(2);
          await until(
            "!document.querySelector('.synthetic-native-page').hidden",
            "new activity previews",
          );
          await evaluate(
            `window.__fullscreenPrimaryPreview.retire(${JSON.stringify(scene.owner)}, 2)`,
          );
          await until(
            "document.querySelector('#thread-workspace-panel').dataset.primaryActive==='true' && document.querySelector('.synthetic-native-page').hidden",
            "retired activity restores primary",
          );
          const retired = await capture("activity-preview-retired");
          checkPrimary(retired, split.draft);
          checkReading(retired, reading, "retired activity return");
          await click('[id="aux-tab-custom:overview"]');
          const overview = await capture("overview-control");
          assert.equal(overview.selected, "aux-tab-custom:overview");
          assert.equal(overview.browserHidden, true);
          assert.equal(
            overview.primary.visibility,
            "hidden",
            "nonbrowser resource keeps primary hidden",
          );
          assert.ok(
            overview.overview.width > 200 && overview.overview.height > 30,
          );
          await click(primaryTab);
          const fromOverview = await capture("primary-from-overview");
          checkPrimary(fromOverview, split.draft);
          checkReading(fromOverview, reading, "nonbrowser return");
          // Explicit Back to live owns the position again, and the next native
          // upward wheel must still release following after another tab round trip.
          await click("#primary-conversation-content .back-live");
          await click(browserTab);
          await click(primaryTab);
          const live = await capture("live-return");
          assert.equal(live.paused, false);
          near(
            live.messages.scrollTop,
            live.messages.scrollHeight - live.messages.clientHeight,
            "live reader stays at the bottom",
          );
          await pauseByWheel(-90);
          const nearBottom = await capture("paused-near-bottom");
          await click(browserTab);
          await click(primaryTab);
          checkReading(
            await capture("near-bottom-return"),
            nearBottom,
            "near-bottom reader return",
          );
          near(
            fromOverview.thread.height,
            first.thread.height,
            "browser and nonbrowser return paths agree",
          );
          await click(expand);
          const restored = await capture("restored-split");
          assert.equal(restored.expanded, "false");
          assert.ok(restored.samePrimary && restored.sameEditor);
          assert.equal(restored.draft, split.draft);
          near(
            restored.primary.width,
            split.primary.width,
            "split width restored",
          );
          near(
            restored.thread.height,
            split.thread.height,
            "split ThreadView height restored",
          );
          result.status = "passed";
        } catch (error) {
          result.status = "failed";
          result.error = String(error.stack ?? error);
          try {
            result.failure = await evaluate(measure);
            await screenshot(`${prefix}-failed.png`);
          } catch (failure) {
            result.captureError = String(failure);
          }
          throw error;
        }
      }
      // Room uses a nonvirtual feed, but shares the fullscreen surface contract.
      for (const width of [1280, 1000]) {
        const result = {
          owner: "room-a",
          width,
          height: 900,
          status: "running",
          observations: [],
        };
        report.scenes.push(result);
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const destination = `${url}/fullscreen-primary-chat.html?owner=room-a`;
        await send("Page.navigate", { url: destination });
        await until(
          `location.href===${JSON.stringify(destination)} && !!document.querySelector('.rooms-chat-feed .room-message') && !document.querySelector('.synthetic-native-page')?.hidden`,
          "Room fixture ready",
        );
        await click(expand);
        await click(primaryTab);
        const roomMeasure = `(() => {
          const root=document.querySelector('#primary-conversation-content');
          const feed=root.querySelector('.rooms-chat-feed');
          const r=feed.getBoundingClientRect();
          const anchor=[...feed.querySelectorAll('[data-room-message-id]')].find(e=>e.getBoundingClientRect().bottom>r.top);
          return {x:r.x,y:r.y,width:r.width,height:r.height,top:feed.scrollTop,range:feed.scrollHeight-feed.clientHeight,
            visibility:getComputedStyle(feed).visibility,
            anchor:anchor?.dataset.roomMessageId,offset:anchor?.getBoundingClientRect().top-r.top,
            draft:root.querySelector('textarea')?.value};
        })()`;
        let saved = await evaluate(roomMeasure);
        assert.ok(saved.range > 300, "Room fixture has scrollable history");
        // Narrow split mode initially mounts this feed under display:none.
        // Establish a native bottom position rather than depending on a hidden
        // mount's attempted scroll-to-end before testing the fullscreen round trip.
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: saved.x + saved.width / 2,
          y: saved.y + 100,
          deltaX: 0,
          deltaY: saved.range + saved.height,
        });
        await until(
          `(() => {
          const feed=document.querySelector('.rooms-chat-feed');
          return feed.scrollHeight-feed.clientHeight-feed.scrollTop <= 2;
        })()`,
          "Room reader reaches the live edge before pausing",
        );
        await delay(300);
        saved = await evaluate(roomMeasure);
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: saved.x + saved.width / 2,
          y: saved.y + 100,
          deltaX: 0,
          deltaY: -saved.range * 0.5,
        });
        await delay(350);
        saved = await evaluate(roomMeasure);
        assert.ok(
          saved.top > 40 && saved.top < saved.range - 40,
          "Room reader moved away from both edges",
        );
        for (const tab of [
          '[id="aux-tab-browser:page-thread-a"]',
          '[id="aux-tab-custom:overview"]',
        ]) {
          await click(tab);
          const hidden = await evaluate(roomMeasure);
          assert.equal(hidden.visibility, "hidden");
          near(hidden.width, saved.width, "hidden Room feed width");
          near(hidden.height, saved.height, "hidden Room feed height");
          near(hidden.top, saved.top, "hidden Room scroll position");
          await click(primaryTab);
          const shown = await evaluate(roomMeasure);
          assert.equal(shown.visibility, "visible");
          assert.equal(
            shown.anchor,
            saved.anchor,
            "Room returns to same message",
          );
          near(
            shown.offset,
            saved.offset,
            "Room retains message-relative position",
          );
          assert.equal(shown.draft, saved.draft, "Room draft is retained");
          result.observations.push({ tab, hidden, shown });
        }
        await evaluate(
          "window.__fullscreenPrimaryPreview.preview('thread-a', 1)",
        );
        await until(
          "document.querySelector('#thread-workspace-panel').dataset.primaryActive==='false' && !document.querySelector('.synthetic-native-page').hidden",
          "Room activity preview",
        );
        const previewHidden = await evaluate(roomMeasure);
        assert.equal(previewHidden.visibility, "hidden");
        near(
          previewHidden.top,
          saved.top,
          "Room preview retains hidden scroll",
        );
        await screenshot(`${width}x900-room-activity-preview.png`);
        await click(primaryTab);
        const previewReturn = await evaluate(roomMeasure);
        assert.equal(previewReturn.anchor, saved.anchor);
        near(previewReturn.offset, saved.offset, "Room preview return offset");
        assert.equal(previewReturn.draft, saved.draft);
        assert.equal(
          await evaluate(
            "document.querySelector('.synthetic-native-page').hidden",
          ),
          true,
        );
        result.observations.push({
          phase: "activity-preview-return",
          hidden: previewHidden,
          shown: previewReturn,
        });
        await screenshot(`${width}x900-room-reading-return.png`);
        result.status = "passed";
      }
    },
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  await writeFile(
    path.join(directory, "measurements.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
