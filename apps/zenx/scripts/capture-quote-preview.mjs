import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".quote-preview");
const evidence = {
  source:
    "Production components with synthetic native-message projection. Browser scenes call no Provider; exact five-reference payload is compared with a separately captured model user message.",
  scenes: [],
  remountCenterTargets: [],
  atomicDeletes: [],
};
for (const entry of [
  { inputMode: "desktop", theme: "light", width: 1280, height: 1000 },
  { inputMode: "desktop", theme: "dark", width: 1280, height: 1000 },
  { inputMode: "desktop", theme: "light", width: 420, height: 900 },
  { inputMode: "desktop", theme: "dark", width: 420, height: 900 },
  { inputMode: "touch", theme: "light", width: 420, height: 900 },
]) {
  evidence.currentScene = entry;
  if (entry.inputMode === "desktop")
    process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
  else delete process.env.ZENX_PREVIEW_DESKTOP_INPUT;
  await withPreviewBrowser(
    directory,
    async ({ send, evaluate, url, screenshot: captureScreenshot }) => {
      const screenshot = async (name) => {
        evidence.checkpoint = `screenshot: ${name}`;
        await captureScreenshot(name);
      };
      const waitFor = async (expression) => {
        evidence.checkpoint = `waiting for: ${expression}`;
        for (let i = 0; i < 200; i++) {
          if (await evaluate(expression)) return;
          await delay(50);
        }
        throw new Error(`Fixture condition timed out: ${expression}`);
      };
      const settle = () =>
        evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
      const assertComposerFocus = async (stage) => {
        evidence.checkpoint = `composer focus: ${stage}`;
        await settle();
        const focus = await evaluate(`(() => {
          const input = document.querySelector('#thread-composer');
          const shell = input.closest('.composer');
          const editor = input.closest('.cm-editor');
          const styles = [input, ...(editor ? [editor] : [])].map(element => {
            const style = getComputedStyle(element);
            return { element: element.className, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
          });
          const probe = document.createElement('span');
          probe.style.color = 'var(--color-focus-ring)'; shell.append(probe);
          const expectedBorder = getComputedStyle(probe).color; probe.remove();
          return { focused: document.activeElement === input, styles, border: getComputedStyle(shell).borderTopColor, expectedBorder };
        })()`);
        assert.equal(
          focus.focused,
          true,
          `${stage}: editable input retains focus`,
        );
        for (const style of focus.styles)
          assert.ok(
            style.outlineStyle === "none" || style.outlineWidth === "0px",
            `${stage}: no inner outline: ${JSON.stringify(style)}`,
          );
        assert.equal(
          focus.border,
          focus.expectedBorder,
          `${stage}: neutral outer focus border remains`,
        );
        evidence.scenes.push({
          name: "composer-focus",
          stage,
          ...entry,
          ...focus,
        });
      };
      const settleDialog = async (selector) => {
        const state = await evaluate(`(async () => {
          const dialog = document.querySelector(${JSON.stringify(selector)});
          const overlay = document.querySelector('.ui-dialog-overlay[data-state="open"]');
          if (!dialog || !overlay) throw new Error('Open dialog or overlay missing');
          const animations = [dialog, overlay]
            .flatMap(element => element.getAnimations({ subtree: false }))
            .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
          await Promise.all(animations.map(animation => animation.finished));
          await new Promise(resolve => requestAnimationFrame(resolve));
          return {
            dialogOpacity: getComputedStyle(dialog).opacity,
            overlayOpacity: getComputedStyle(overlay).opacity,
            dialogState: dialog.getAttribute('data-state'),
          };
        })()`);
        assert.deepEqual(state, {
          dialogOpacity: "1",
          overlayOpacity: "1",
          dialogState: "open",
        });
      };
      const press = async (key, code = key, modifiers = 0) => {
        evidence.checkpoint = `keyboard: ${code}, modifiers ${modifiers}`;
        const windowsVirtualKeyCode =
          key === "Tab"
            ? 9
            : key === "Enter"
              ? 13
              : key === "Backspace"
                ? 8
                : key === "Escape"
                  ? 27
                  : key.toUpperCase().charCodeAt(0);
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code,
          windowsVirtualKeyCode,
          modifiers,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code,
          windowsVirtualKeyCode,
          modifiers,
        });
      };
      const click = async (selector) => {
        const point = await evaluate(
          `(() => { const target=document.querySelector(${JSON.stringify(selector)}); if(!target) throw new Error('Target missing: ${selector}'); target.scrollIntoView({block:'center'}); const r=target.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
        );
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          ...point,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 1,
          ...point,
        });
      };
      const name = `quote-${entry.inputMode}-${entry.theme}-${entry.width}`;
      if (entry.inputMode === "touch") {
        await send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 1,
        });
      }
      await send("Emulation.setDeviceMetricsOverride", {
        width: entry.width,
        height: entry.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", {
        url: `${url}/quote-frame.html?theme=${entry.theme}${entry.width < 600 ? "&narrow" : ""}`,
      });
      await waitFor(
        `Boolean(window.quoteFixture && document.querySelector('[data-sent-message-id="message-synthetic-example"]') && document.documentElement.dataset.appearance === '${entry.theme}')`,
      );
      const capabilities = await evaluate(`({
        fine: matchMedia('(pointer: fine)').matches,
        hover: matchMedia('(hover: hover)').matches,
        anyFine: matchMedia('(any-pointer: fine)').matches,
        anyHover: matchMedia('(any-hover: hover)').matches,
        coarse: matchMedia('(pointer: coarse)').matches,
        noHover: matchMedia('(hover: none)').matches
      })`);
      const desktop = entry.inputMode === "desktop";
      assert.deepEqual(
        capabilities,
        {
          fine: desktop,
          hover: desktop,
          anyFine: desktop,
          anyHover: desktop,
          coarse: !desktop,
          noHover: !desktop,
        },
        "Input capabilities must match the screenshot label",
      );
      await evaluate("document.fonts.ready");
      await settle();
      assert.equal(
        await evaluate("document.querySelector('.turn-outcome') === null"),
        true,
        "Synthetic completed turns have an explicit final acknowledgment",
      );
      await click("#thread-composer");
      await assertComposerFocus("legacy textarea mouse focus");
      await screenshot(`${name}-initial-sent.png`);
      // Use an actual DOM Range; the production selectionchange listener owns the toolbar.
      await evaluate(
        `(() => {const body=document.querySelector('[data-quote-item-id="synthetic-answer"] p');if(!body)throw new Error('Source absent');body.scrollIntoView({block:'center'});const range=document.createRange();range.setStart(body.firstChild,0);range.setEnd(body.firstChild,3);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));})()`,
      );
      await waitFor(
        "document.querySelector('.message-selection-actions') !== null",
      );
      await settle();
      await screenshot(`${name}-selection-toolbar.png`);
      const quoteAction = await evaluate(
        "(() => {const button=[...document.querySelectorAll('.message-selection-actions button')].find(button=>button.textContent==='引用');const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()",
      );
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...quoteAction,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        ...quoteAction,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...quoteAction,
      });
      await waitFor(
        "window.quoteFixture.getDraft().references.length === 1 && document.querySelectorAll('.inline-composer-editor .reference-token').length === 1",
      );
      assert.equal(
        await evaluate("window.quoteFixture.getSent().length"),
        0,
        "Quote never sends",
      );
      await assertComposerFocus("first reference insertion");
      const quotedDraft = await evaluate("window.quoteFixture.getDraft()");
      await click(".inline-composer-editor .reference-token-remove");
      await waitFor("window.quoteFixture.getDraft().references.length === 0");
      await click("#thread-composer");
      await assertComposerFocus("last reference removed then mouse refocus");
      await screenshot(`${name}-empty-refocus.png`);
      await press("z", "KeyZ", 2);
      await waitFor("window.quoteFixture.getDraft().references.length === 1");
      assert.deepEqual(
        await evaluate("window.quoteFixture.getDraft()"),
        quotedDraft,
      );
      await assertComposerFocus("undo restores final reference");
      // Tab enters the real editor from a temporary preceding keyboard stop.
      await evaluate(
        `(() => { const input=document.querySelector('#thread-composer'); const stop=document.createElement('button'); stop.id='focus-probe'; input.closest('.inline-composer-editor').before(stop); stop.focus(); })()`,
      );
      await press("Tab", "Tab");
      await assertComposerFocus("keyboard entry");
      await evaluate("document.querySelector('#focus-probe').remove()");
      await press("Tab", "Tab");
      assert.equal(
        await evaluate(
          `(() => { const target=document.activeElement; return target.matches('.reference-token button') && getComputedStyle(target).outlineStyle !== 'none'; })()`,
        ),
        true,
        "reference button keeps its keyboard focus indicator",
      );
      await click("#thread-composer");
      await assertComposerFocus("mouse returns from reference control");
      await evaluate(
        "window.quoteFixture.setComposerCaret(window.quoteFixture.getDraft().text.length)",
      );
      await send("Input.insertText", { text: "请解释这三个字。" });
      await waitFor(
        "window.quoteFixture.getDraft().text.includes('请解释这三个字。')",
      );
      await evaluate(
        "document.querySelector('#thread-composer').scrollIntoView({block:'end'})",
      );
      await settle();
      const draft = await evaluate(
        `(() => {const pill=document.querySelector('.inline-composer-editor .reference-token');const rect=pill.getBoundingClientRect();const details=pill.querySelector('.reference-token-details');const remove=pill.querySelector('.reference-token-remove');const draft=window.quoteFixture.getDraft();return {height:rect.height,buttonHeight:details.getBoundingClientRect().height,removeHeight:remove.getBoundingClientRect().height,radius:getComputedStyle(pill).borderRadius,excerpt:details.querySelector('span').textContent,position:draft.references[0].position,text:draft.text,insideComposer:!!pill.closest('.composer'),overflow:document.documentElement.scrollWidth>innerWidth};})()`,
      );
      assert.equal(draft.radius, "999px");
      assert.equal(draft.height, desktop ? 24 : 48);
      if (!desktop) {
        assert.ok(draft.buttonHeight >= 44);
        assert.ok(draft.removeHeight >= 44);
      }
      assert.equal(draft.position, 0);
      assert.equal(draft.insideComposer, true);
      assert.equal(draft.overflow, false);
      await screenshot(`${name}-draft.png`);
      await press("Enter");
      await waitFor(
        "window.quoteFixture.getSent().length === 1 && document.querySelector('[data-sent-message-id=\"message-synthetic-send-1\"]') !== null",
      );
      await evaluate(
        "document.querySelector('[data-sent-message-id=\"message-synthetic-send-1\"]').scrollIntoView({block:'center'})",
      );
      await settle();
      const sent = await evaluate(
        `(() => {const row=document.querySelector('[data-sent-message-id="message-synthetic-send-1"]');const pill=row.querySelector('.user-bubble .reference-token');return {height:pill.getBoundingClientRect().height,radius:getComputedStyle(pill).borderRadius,text:row.textContent,excerpt:pill.querySelector('.reference-token-details > span').textContent,remove:!!pill.querySelector('.reference-token-remove'),inBubble:!!pill.closest('.user-bubble'),draft:window.quoteFixture.getDraft(),raw:window.quoteFixture.getSent()[0],overflow:document.documentElement.scrollWidth>innerWidth};})()`,
      );
      assert.equal(sent.height, desktop ? 28 : 48);
      assert.equal(sent.radius, "999px");
      assert.equal(sent.excerpt, draft.excerpt);
      assert.match(sent.text, /请解释这三个字/);
      assert.equal(sent.remove, false);
      assert.equal(sent.inBubble, true);
      assert.equal(
        await evaluate(
          "document.querySelector('.composer .reference-token') === null",
        ),
        true,
      );
      assert.equal(sent.draft.references.length, 0);
      assert.equal(sent.draft.text, "");
      assert.equal(sent.overflow, false);
      assert.deepEqual(
        await evaluate(
          "window.quoteFixture.getThread().canonicalItems.filter(item=>item.turnId==='turn-synthetic-send-1').map(item=>item.type)",
        ),
        ["turn_started", "user_message", "agent_message", "turn_completed"],
      );
      assert.equal(
        await evaluate("document.querySelector('.turn-outcome') === null"),
        true,
        "Local preview must not imply a failed backend send",
      );
      await screenshot(`${name}-sent.png`);
      await click("#thread-composer");
      await assertComposerFocus("after send clears references");
      await evaluate("window.quoteFixture.navigate()");
      await waitFor(
        "document.querySelector('#thread-composer')?.tagName === 'TEXTAREA'",
      );
      await click("#thread-composer");
      await assertComposerFocus("thread switch unmounts editor");
      evidence.scenes.push({ ...entry, capabilities, draft, sent });
      if (desktop) {
        await send("Page.navigate", {
          url: `${url}/unified-reference-frame.html?theme=${entry.theme}${entry.width < 600 ? "&narrow" : ""}`,
        });
        await waitFor(
          "window.quoteFixture && document.querySelectorAll('.inline-composer-editor .reference-token').length === 5",
        );
        await evaluate("document.fonts.ready");
        await settle();
        assert.equal(await evaluate("window.quoteFixture.getSent().length"), 0);
        const baseline = await evaluate("window.quoteFixture.getDraft()");
        // A contenteditable center can be a reference's remove button. Record
        // the old pointer target without activating it; focus the editor itself.
        const remountCenterTarget = await evaluate(`(() => {
          const input = document.querySelector('#thread-composer');
          input.scrollIntoView({ block: 'center' });
          const rect = input.getBoundingClientRect();
          const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          const target = document.elementFromPoint(point.x, point.y);
          const control = target?.closest('button, a, input, select, textarea, [role="button"]');
          return {
            point,
            target: target ? { tag: target.tagName, className: target.getAttribute('class') } : null,
            control: control ? { tag: control.tagName, className: control.getAttribute('class'), role: control.getAttribute('role'), label: control.getAttribute('aria-label'), title: control.getAttribute('title') } : null,
          };
        })()`);
        evidence.remountCenterTargets.push({
          ...entry,
          ...remountCenterTarget,
        });
        await evaluate("window.quoteFixture.setComposerCaret(0)");
        await assertComposerFocus("remounted reference editor");
        assert.deepEqual(
          await evaluate("window.quoteFixture.getDraft()"),
          baseline,
          "remount focus must not activate a reference control or alter the draft",
        );
        assert.equal(baseline.references.length, 5);
        assert.ok(
          baseline.references.every(
            (reference) => baseline.text[reference.position] === "\uFFFC",
          ),
        );
        assert.ok(
          baseline.text.split("\uFFFC").filter(Boolean).length >= 3,
          "five references must be interleaved with prose",
        );
        assert.equal(
          await evaluate("document.documentElement.scrollWidth > innerWidth"),
          false,
        );
        await screenshot(`unified-${entry.theme}-${entry.width}-draft.png`);
        // Real keyboard edits around atomic chips, not a mock textarea facade.
        const atomicDelete = {
          ...entry,
          beforeSelection: await evaluate(
            "window.quoteFixture.getComposerEditorState()",
          ),
        };
        evidence.atomicDeletes.push(atomicDelete);
        const deletionCaret = baseline.references[2].position + 1;
        await evaluate(
          `window.quoteFixture.setComposerCaret(${deletionCaret})`,
        );
        await settle();
        atomicDelete.beforeKey = await evaluate(
          "window.quoteFixture.getComposerEditorState()",
        );
        assert.equal(
          atomicDelete.beforeKey.focused,
          true,
          "atomic delete input is focused",
        );
        assert.deepEqual(
          atomicDelete.beforeKey.editorSelection,
          { anchor: deletionCaret, head: deletionCaret },
          "atomic delete CodeMirror caret is after the selected token",
        );
        assert.deepEqual(
          atomicDelete.beforeKey.domSelection,
          { anchor: deletionCaret, head: deletionCaret },
          "atomic delete native caret matches CodeMirror",
        );
        assert.equal(
          atomicDelete.beforeKey.editorText,
          baseline.text,
          "atomic delete editor still matches draft",
        );
        await press("Backspace");
        await settle();
        atomicDelete.afterKey = await evaluate(
          "window.quoteFixture.getComposerEditorState()",
        );
        await waitFor("window.quoteFixture.getDraft().references.length === 4");
        await press("z", "KeyZ", 2);
        await waitFor("window.quoteFixture.getDraft().references.length === 5");
        assert.deepEqual(
          await evaluate("window.quoteFixture.getDraft()"),
          baseline,
          "undo restores token identity and position",
        );
        const betweenStart = baseline.references[0].position + 1;
        const between = [
          ...baseline.text.slice(betweenStart, baseline.references[1].position),
        ];
        const middle =
          betweenStart +
          between.slice(0, Math.floor(between.length / 2)).join("").length;
        await evaluate(`window.quoteFixture.setComposerCaret(${middle})`);
        await send("Input.insertText", { text: "中间探针" });
        await waitFor(
          "window.quoteFixture.getDraft().text.includes('中间探针')",
        );
        await press("z", "KeyZ", 2);
        await waitFor(
          `window.quoteFixture.getDraft().text.length === ${baseline.text.length}`,
        );
        assert.deepEqual(
          await evaluate("window.quoteFixture.getDraft()"),
          baseline,
          "caret insertion undo returns exact interleaved draft",
        );
        await evaluate(`window.quoteFixture.setComposerCaret(${middle})`);
        await send("Input.insertText", { text: " @" });
        await waitFor(
          "Boolean(document.querySelector('#thread-composer')?.getAttribute('aria-controls'))",
        );
        await screenshot(
          `unified-${entry.theme}-${entry.width}-mention-between.png`,
        );
        await press("z", "KeyZ", 2);
        await waitFor(
          `window.quoteFixture.getDraft().text.length === ${baseline.text.length}`,
        );
        assert.deepEqual(
          await evaluate("window.quoteFixture.getDraft()"),
          baseline,
          "mention probe must not alter captured payload",
        );
        assert.equal(
          await evaluate(
            `(() => {const content=document.querySelector('#thread-composer');content.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));content.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true,isComposing:true}));content.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));return window.quoteFixture.getSent().length;})()`,
          ),
          0,
          "composing Enter must not send",
        );
        await settle();
        assert.equal(
          await evaluate("window.quoteFixture.getSent().length"),
          0,
          "composing Enter must not send after React settles",
        );
        await assertComposerFocus("after composition");
        const afterSyntheticComposition = await evaluate(
          "window.quoteFixture.getDraft()",
        );
        if (afterSyntheticComposition.text !== baseline.text) {
          // Dispatching a synthetic composing keydown does not ask Chrome's
          // IME to consume it. CodeMirror's compositionstart sets composing=0;
          // a real composition edit increments it above 0 before keydown.
          // This bare synthetic event can therefore insert a newline.
          // Verify that this is the only change, then undo the probe before
          // testing the exact native-send payload.
          const insertedAt = afterSyntheticComposition.text.indexOf("\n");
          assert.ok(
            insertedAt >= 0,
            "synthetic composition only inserts a newline",
          );
          assert.equal(
            afterSyntheticComposition.text.slice(0, insertedAt) +
              afterSyntheticComposition.text.slice(insertedAt + 1),
            baseline.text,
            "synthetic composition does not alter any other prose or token",
          );
          assert.deepEqual(
            afterSyntheticComposition.references,
            baseline.references.map((reference) => ({
              ...reference,
              position:
                reference.position >= insertedAt
                  ? reference.position + 1
                  : reference.position,
            })),
            "synthetic composition preserves all reference identities",
          );
          await press("z", "KeyZ", 2);
          await waitFor(
            `window.quoteFixture.getDraft().text.length === ${baseline.text.length}`,
          );
        }
        assert.deepEqual(
          await evaluate("window.quoteFixture.getDraft()"),
          baseline,
          "composition probe must leave the exact draft before native send",
        );
        await evaluate("document.querySelector('#thread-composer').focus()");
        await press("Enter");
        await waitFor(
          "window.quoteFixture.getSent().length === 1 && document.querySelectorAll('.user-bubble .reference-token').length === 5",
        );
        const payloadComparison = await evaluate(`(() => {
          const actual = window.quoteFixture.getSent()[0];
          const expected = window.quoteFixture.expectedPayload;
          let offset = 0;
          while (offset < Math.min(actual.length, expected.length) &&
            actual[offset] === expected[offset]) offset++;
          return {
            equal: actual === expected,
            actualLength: actual.length,
            expectedLength: expected.length,
            firstDifferentOffset: offset,
            actualAroundDifference: actual.slice(Math.max(0, offset - 50), offset + 100),
            expectedAroundDifference: expected.slice(Math.max(0, offset - 50), offset + 100),
          };
        })()`);
        assert.equal(
          payloadComparison.equal,
          true,
          `visible five-reference send exactly matches captured model user message: ${JSON.stringify(payloadComparison)}`,
        );
        await evaluate(
          "document.querySelector('.user-bubble .reference-token').scrollIntoView({block:'center'})",
        );
        await settle();
        await screenshot(`unified-${entry.theme}-${entry.width}-sent.png`);
        if (entry.width >= 600) {
          await click("[data-model-user-message]");
          await waitFor(
            "document.querySelector('[data-model-user-payload]')?.textContent === window.quoteFixture.expectedPayload",
          );
          await settleDialog('.ui-dialog[data-state="open"]');
          await screenshot(
            `unified-${entry.theme}-${entry.width}-model-user-message.png`,
          );
          await press("Escape");
        }
        if (entry.width === 420) {
          await send("Emulation.setDeviceMetricsOverride", {
            width: 420,
            height: 480,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await send("Page.navigate", {
            url: `${url}/unified-reference-frame.html?stress&narrow`,
          });
          await waitFor(
            "Boolean(window.quoteFixture && document.querySelectorAll('.inline-composer-editor .reference-token').length === 15 && document.querySelectorAll('.composer-images img').length === 6 && document.querySelector('.queue-shelf'))",
          );
          await evaluate("document.fonts.ready");
          await settle();
          const reachability = await evaluate(`(async () => {
            const zone = document.querySelector('.bottom-zone');
            const scroller = document.querySelector('.inline-composer-editor .cm-scroller');
            const targets = [...document.querySelectorAll('.inline-composer-editor .reference-token-details, .inline-composer-editor .reference-token-remove, .composer-images .remove-draft-image'), document.querySelector('.inline-composer-editor .cm-editor')];
            const checks = [];
            for (const target of targets) {
              target.scrollIntoView({ block: 'center', inline: 'nearest' });
              await new Promise(resolve => requestAnimationFrame(resolve));
              const r = target.getBoundingClientRect(), z = zone.getBoundingClientRect();
              const x = r.x + r.width / 2, y = r.y + r.height / 2;
              checks.push({ visible: y >= z.top && y <= z.bottom && y >= 0 && y <= innerHeight, hit: target.contains(document.elementFromPoint(x, y)) });
            }
            return { checks, overflowY: getComputedStyle(zone).overflowY, scrollHeight: zone.scrollHeight, clientHeight: zone.clientHeight, editorOverflowY:getComputedStyle(scroller).overflowY, editorScrollHeight:scroller.scrollHeight, editorClientHeight:scroller.clientHeight, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
          })()`);
          assert.equal(reachability.horizontalOverflow, false);
          assert.equal(reachability.overflowY, "auto");
          assert.equal(reachability.editorOverflowY, "auto");
          assert.ok(
            reachability.editorScrollHeight > reachability.editorClientHeight,
            "fifteen chips must scroll within CodeMirror",
          );
          assert.ok(
            reachability.checks.every((check) => check.visible && check.hit),
            "Every reference, image remove target and Composer must be reachable without clipping",
          );
          await screenshot("unified-short-queue-composer.png");
          await evaluate(
            "document.querySelector('.inline-composer-editor .reference-token-details').scrollIntoView({block:'center'})",
          );
          await settle();
          await screenshot("unified-short-queue-references.png");
          if (
            await evaluate(
              "document.querySelector('.queue-shelf-toggle').getAttribute('aria-expanded') === 'false'",
            )
          )
            await click(".queue-shelf-toggle");
          if (
            await evaluate(
              "document.querySelector('.queue-view-all')?.getAttribute('aria-expanded') === 'false'",
            )
          )
            await click(".queue-view-all");
          await click('[data-queue-id="queue-99"] .queue-row-edit');
          await waitFor(
            "document.querySelectorAll('.queued-message-editor .reference-token').length === 5",
          );
          await settleDialog(
            '.ui-dialog.queued-message-editor[data-state="open"]',
          );
          await screenshot("unified-short-queue-edit-inline.png");
          const beforeQueueEdit = await evaluate(
            "window.quoteFixture.getDraft()",
          );
          await evaluate("window.quoteFixture.setQueueCaret(0)");
          assert.equal(
            await evaluate(
              "document.activeElement.matches('.queued-message-editor .cm-content')",
            ),
            true,
            "queue editor retains editable focus",
          );
          await send("Input.insertText", { text: "队列前缀" });
          await click(".queue-editor-save");
          await waitFor(
            "window.quoteFixture.getEditedQueue()?.text.startsWith('队列前缀')",
          );
          const editedQueue = await evaluate(
            "window.quoteFixture.getEditedQueue()",
          );
          assert.deepEqual(
            editedQueue.references.map((reference) => reference.position),
            beforeQueueEdit.references
              .slice(0, 5)
              .map((reference) => reference.position + "队列前缀".length),
            "queue edit keeps all five reference offsets after a prefix insertion",
          );
          evidence.scenes.push({
            name: "short-queue-references-images",
            width: 420,
            height: 480,
            reachability,
          });
        }
      }
      if (entry.width === 420) {
        await send("Emulation.setDeviceMetricsOverride", {
          width: entry.width,
          height: entry.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Page.navigate", {
          url: `${url}/unified-reference-frame.html?long&narrow&theme=${entry.theme}`,
        });
        await waitFor(
          "window.quoteFixture && document.querySelectorAll('.inline-composer-editor .reference-token').length === 1",
        );
        await evaluate("document.fonts.ready");
        await evaluate(
          "document.querySelector('.inline-composer-editor .reference-token').scrollIntoView({block:'center'})",
        );
        await settle();
        const longChip = await evaluate(`(() => {
          const host=document.querySelector('.inline-composer-reference');
          const token=host.querySelector('.reference-token');
          const label=host.querySelector('.reference-token-details > span');
          const remove=host.querySelector('.reference-token-remove');
          const shell=document.querySelector('.inline-composer-editor');
          const h=host.getBoundingClientRect(),t=token.getBoundingClientRect(),r=remove.getBoundingClientRect(),s=shell.getBoundingClientRect();
          return {hostWidth:h.width,tokenWidth:t.width,tokenHeight:t.height,removeHeight:r.height,removeRightGap:h.right-r.right,insideShell:h.left>=s.left-1&&h.right<=s.right+1,ellipsized:label.scrollWidth>label.clientWidth,overflow:document.documentElement.scrollWidth>innerWidth};
        })()`);
        assert.ok(
          longChip.hostWidth <= 300 && longChip.tokenWidth <= 300,
          "long CJK/Latin/unbroken path chip stays bounded",
        );
        assert.ok(
          longChip.removeRightGap >= -1 && longChip.removeRightGap <= 6,
          "remove button remains at the chip's far right",
        );
        assert.equal(longChip.insideShell, true);
        assert.equal(longChip.ellipsized, true);
        assert.equal(longChip.overflow, false);
        if (entry.inputMode === "touch")
          assert.ok(longChip.tokenHeight >= 44 && longChip.removeHeight >= 44);
        await screenshot(`refsLong-${entry.inputMode}-${entry.theme}-420.png`);
        evidence.scenes.push({
          name: "long-inline-reference",
          ...entry,
          longChip,
        });
      }
    },
  ).catch(async (error) => {
    // Synthetic fixture data only; preserve the original failure and checkpoint.
    evidence.failure = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
    await writeFile(
      path.join(directory, "measurements.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    ).catch((writeError) => {
      console.error(
        "Could not retain partial synthetic measurements:",
        writeError,
      );
    });
    throw error;
  });
}
await writeFile(
  path.join(directory, "measurements.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  "Captured real-browser inline draft/sent, undo, mention, composition, queue edit, stress and long-chip scenes with verified input capabilities.",
);
