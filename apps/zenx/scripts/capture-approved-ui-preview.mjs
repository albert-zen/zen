import assert from "node:assert/strict";
import { assertOutputUsageObservation } from "./output-usage-preview-assertions.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".approved-ui-preview");
const evidence = {
  source:
    "Real production components and CSS; synthetic fixtures only; Chrome desktop-input emulation on Linux CI, not physical macOS/Windows input; no Host actions or private data.",
  sidebar: [],
  context: [],
  outputUsage: [],
};
const rect =
  "e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; }";
const sidebarMeasure = `(() => { const rect=${rect}; return [...document.querySelectorAll('.thread-row-shell')].map(shell => { const row=shell.querySelector(':scope > .thread-row'); const rail=shell.querySelector('.thread-status-rail'); const hint=getComputedStyle(row,'::after'); const r=rect(row); const padding=parseFloat(getComputedStyle(row).paddingInlineEnd); const hintWidth=parseFloat(hint.width)+(hint.boxSizing==='border-box'?0:parseFloat(hint.paddingLeft)+parseFloat(hint.paddingRight)+parseFloat(hint.borderLeftWidth)+parseFloat(hint.borderRightWidth)); const painted=[...rail.querySelectorAll('.thread-status-slot > *, .thread-menu-trigger')].filter(e=>{const s=getComputedStyle(e);return e.getBoundingClientRect().width>0&&s.visibility!=='hidden'&&Number(s.opacity)>0}).map(rect); return { id:shell.dataset.threadId, hint:row.dataset.shortcutKey ?? null, row:r, rail:rect(rail), painted, paintedRight:Math.max(0,...painted.map(r=>r.right)), hintWidth, hintLeft:r.right-parseFloat(hint.insetInlineEnd)-hintWidth, padding, titleRight:shell.querySelector('.thread-title')?.getBoundingClientRect().right, slot:getComputedStyle(shell).getPropertyValue('--thread-shortcut-space'), statusCount:shell.querySelectorAll('.thread-status-slot').length }; }); })()`;
const contextMeasure = `(() => { const rect=${rect}; const trigger=document.querySelector('.context-usage-trigger'); const panel=document.querySelector('.context-usage-popover'); const svg=trigger.querySelector('svg'); return {trigger:rect(trigger),label:trigger.getAttribute('aria-label'),expanded:trigger.getAttribute('aria-expanded'),scale:getComputedStyle(svg).scale,filter:getComputedStyle(svg).filter,panel:panel?rect(panel):null,opacity:panel?Number(getComputedStyle(panel).opacity):null,placement:panel?.dataset.placement,bridge:document.querySelector('.context-usage-hover-bridge')?rect(document.querySelector('.context-usage-hover-bridge')):null,animation:panel?getComputedStyle(panel).animationName:null,overflow:document.documentElement.scrollWidth>innerWidth}; })()`;
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    const waitFor = async (expression) => {
      for (let i = 0; i < 200; i++) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error(`Fixture condition timed out: ${expression}`);
    };
    const navigate = async (name, query, width, height) => {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const destination = `${url}/${name}.html?${new URLSearchParams(query)}`;
      await send("Page.navigate", { url: destination });
      await waitFor(
        `location.href===${JSON.stringify(destination)} && document.readyState==='complete'`,
      );
      const capabilities = await evaluate(
        "({hover:matchMedia('(hover: hover)').matches, fine:matchMedia('(pointer: fine)').matches, anyHover:matchMedia('(any-hover: hover)').matches, anyFine:matchMedia('(any-pointer: fine)').matches, hoverNone:matchMedia('(hover: none)').matches, pointerNone:matchMedia('(pointer: none)').matches, coarse:matchMedia('(pointer: coarse)').matches, anyCoarse:matchMedia('(any-pointer: coarse)').matches, anyPointerNone:matchMedia('(any-pointer: none)').matches, anyHoverNone:matchMedia('(any-hover: none)').matches})",
      );
      assert.deepEqual(
        capabilities,
        {
          hover: true,
          fine: true,
          anyHover: true,
          anyFine: true,
          hoverNone: false,
          pointerNone: false,
          coarse: false,
          anyCoarse: false,
          anyPointerNone: false,
          anyHoverNone: false,
        },
        `${name}: actual browser desktop-input media capabilities`,
      );
      evidence.inputCapabilities = capabilities;
    };
    const move = async (x, y) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    };
    const escape = async () => {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        windowsVirtualKeyCode: 27,
      });
    };
    for (const [lang, theme, width] of [
      ["en", "light", 1100],
      ["zh-CN", "dark", 390],
    ]) {
      const scene = `output-usage-${lang}-${theme}-${width}`;
      let observation;
      try {
        await navigate("output-usage", { lang, theme }, width, 760);
        await waitFor(
          "!!document.querySelector('.message-cache') && !!document.querySelector('.context-usage-trigger')",
        );
        // Keep the terminal response actions visible while hovering the context
        // ring; focus changes presentation only and never invokes Copy.
        await evaluate("document.querySelector('.message-copy').focus()");
        const point = await evaluate(
          "(() => { const r=document.querySelector('.context-usage-trigger').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()",
        );
        await move(point.x, point.y);
        await waitFor("!!document.querySelector('.context-usage-popover')");
        await delay(250);
        observation = await evaluate(`(() => {
        const message = document.querySelector('.message-cache');
        const panel = document.querySelector('.context-usage-popover');
        const header = document.querySelector('.turn-toggle');
        return {message:message.textContent, title:message.title, panel:panel.textContent, header:header.textContent, contextLabel:document.querySelector('.context-usage-trigger').getAttribute('aria-label'), overflow:document.documentElement.scrollWidth>innerWidth};
      })()`);
        assertOutputUsageObservation(observation, lang);
        evidence.outputUsage.push({ lang, theme, width, ...observation });
        await screenshot(`${scene}.png`);
        await writeFile(
          path.join(directory, "output-usage-progress.json"),
          JSON.stringify(evidence.outputUsage, null, 2) + "\n",
        );
      } catch (error) {
        // Persist the failed scene before browser cleanup or later CI steps.
        // Existing CDP calls are bounded; a screenshot failure never masks it.
        const failure = {
          scene,
          lang,
          theme,
          width,
          observation,
          error: String(error),
        };
        console.error(JSON.stringify(failure));
        try {
          await writeFile(
            path.join(directory, "output-usage-failure.json"),
            JSON.stringify(failure, null, 2) + "\n",
          );
        } catch (writeError) {
          console.error(
            `Failure diagnostics unavailable: ${String(writeError)}`,
          );
        }
        try {
          await screenshot(`${scene}-failed.png`);
        } catch (captureError) {
          console.error(
            `Failure screenshot unavailable: ${String(captureError)}`,
          );
        }
        throw error;
      }
    }

    for (const options of [
      { width: 220, theme: "light", platform: "darwin", lang: "zh-CN" },
      { width: 360, theme: "dark", platform: "darwin", lang: "en" },
      { width: 220, theme: "dark", platform: "win32", lang: "zh-CN" },
      { width: 360, theme: "light", platform: "win32", lang: "en" },
    ]) {
      for (const variant of ["before", "after"]) {
        const name = `sidebar-${variant}-${options.platform}-${options.theme}-${options.width}`;
        await navigate(`sidebar-${variant}`, options, 1100, 820);
        await waitFor("Boolean(window.__sidebarVisual?.ready)");
        await evaluate("window.__sidebarVisual.setModifier(true)");
        await waitFor(
          "document.querySelectorAll('.thread-row[data-shortcut-key]').length===5",
        );
        await delay(200);
        const held = await evaluate(sidebarMeasure);
        assert.equal(held.length, 5);
        assert.ok(held.every((r) => r.hint));
        if (variant === "after")
          for (const row of held) {
            assert.ok(
              Number.isFinite(row.hintLeft),
              `${name}: measured shortcut`,
            );
            assert.ok(
              row.paintedRight <= row.hintLeft + 0.5,
              `${name}: ${row.id} status paint before shortcut`,
            );
            assert.ok(
              row.titleRight <= row.hintLeft + 0.5,
              `${name}: ${row.id} title before shortcut`,
            );
          }
        await screenshot(`${name}.png`);
        if (variant === "after") {
          assert.ok(
            await evaluate(
              "[...document.querySelectorAll('.thread-status-rail .thread-menu-trigger')].every(e=>e.getBoundingClientRect().width===0)",
            ),
            `${name}: desktop actions are hidden until hover`,
          );
          // Hover the actual More target, not a synthetic CSS class.
          const row = held[0];
          await move(row.rail.right - 14, row.row.y + row.row.height / 2);
          await delay(180);
          assert.equal(
            await evaluate(
              "document.querySelector('.thread-status-rail .thread-menu-trigger').getBoundingClientRect().width",
            ),
            28,
            `${name}: actual hover reveals the desktop More target`,
          );
          const hover = await evaluate(sidebarMeasure);
          assert.ok(
            hover[0].paintedRight <= hover[0].hintLeft + 0.5,
            `${name}: status and More target before shortcut`,
          );
          await screenshot(`${name}-hover.png`);
          await move(1050, 780);
          await evaluate("window.__sidebarVisual.setModifier(false)");
          await waitFor(
            "document.querySelectorAll('.thread-row[data-shortcut-key]').length===0",
          );
          const released = await evaluate(sidebarMeasure);
          assert.ok(released.every((r) => r.slot.trim() === "0px"));
          await screenshot(`${name}-released.png`);
          await evaluate("window.__sidebarVisual.setModifier(true)");
          await waitFor(
            "document.querySelectorAll('.thread-row[data-shortcut-key]').length===5",
          );
          await evaluate("window.__sidebarVisual.blur()");
          await waitFor(
            "document.querySelectorAll('.thread-row[data-shortcut-key]').length===0",
          );
          evidence.sidebar.push({
            variant,
            ...options,
            held,
            hover,
            released,
            blurCleared: true,
          });
        } else evidence.sidebar.push({ variant, ...options, held });
      }
    }
    for (const options of [
      { width: 900, theme: "light", placement: "above", lang: "zh-CN" },
      { width: 900, theme: "dark", placement: "below", lang: "en" },
      { width: 390, theme: "light", placement: "below", lang: "zh-CN" },
      { width: 390, theme: "dark", placement: "above", lang: "en" },
    ]) {
      for (const variant of ["before", "after"]) {
        const name = `context-${variant}-${options.theme}-${options.width}-${options.placement}`;
        await navigate(`context-${variant}`, options, options.width, 720);
        await waitFor(
          "Boolean(document.querySelector('.context-usage-trigger'))",
        );
        await delay(200);
        const initial = await evaluate(contextMeasure);
        await move(
          initial.trigger.x + initial.trigger.width / 2,
          initial.trigger.y + initial.trigger.height / 2,
        );
        await waitFor(
          "Boolean(document.querySelector('.context-usage-popover'))",
        );
        await delay(250);
        const hover = await evaluate(contextMeasure);
        const breakdown = await evaluate(
          `(() => ({ rows: [...document.querySelectorAll('.context-usage-breakdown > div')].map(row => row.textContent), explanation: document.querySelector('.context-usage-explanation')?.textContent }))()`,
        );
        assert.equal(
          breakdown.rows.length,
          4,
          `${name}: all additive input categories shown`,
        );
        assert(
          breakdown.rows.every((row) => !row.includes("contextCategory.")),
          `${name}: translated category labels`,
        );
        assert(breakdown.explanation, `${name}: estimate limitations visible`);
        hover.breakdown = breakdown;
        assert.deepEqual(
          hover.trigger,
          initial.trigger,
          `${name}: hit target stays fixed`,
        );
        assert.equal(hover.placement, options.placement);
        assert.equal(hover.overflow, false);
        assert.equal(hover.label, initial.label, `${name}: usage is factual`);
        if (variant === "after") assert.equal(Number(hover.scale), 1.12);
        await screenshot(`${name}.png`);
        if (variant === "after") {
          const b = hover.bridge,
            p = hover.panel;
          await move(b.x + b.width / 2, b.y + b.height / 2);
          await delay(220);
          assert.ok(
            (await evaluate(contextMeasure)).panel,
            `${name}: hover corridor remains open`,
          );
          await move(p.x + p.width / 2, p.y + p.height / 2);
          await delay(220);
          assert.ok(
            (await evaluate(contextMeasure)).panel,
            `${name}: entering popup remains open`,
          );
          // Escape is deliberately scoped to this focused control, not BODY.
          await evaluate(
            "document.querySelector('.context-usage-compact').focus()",
          );
          assert.equal(
            await evaluate("document.activeElement.className"),
            "context-usage-compact",
          );
          await escape();
          await waitFor("!document.querySelector('.context-usage-popover')");
          // Fresh entry: record actual keyframe positions without moving its hitbox.
          await move(2, 700);
          await move(
            initial.trigger.x + initial.trigger.width / 2,
            initial.trigger.y + initial.trigger.height / 2,
          );
          await waitFor(
            "Boolean(document.querySelector('.context-usage-popover'))",
          );
          const phases = [];
          for (const time of [30, 150]) {
            const animations = await evaluate(
              `(() => { const animations=document.getAnimations().filter(a=>a.animationName==='context-usage-enter'); animations.forEach(a=>{a.pause();a.currentTime=${time}}); return animations.length; })()`,
            );
            assert.equal(animations, 1, `${name}: live popup fade exists`);
            phases.push(await evaluate(contextMeasure));
            if (options.width === 900 && options.theme === "light")
              await screenshot(`${name}-fade-${time}.png`);
          }
          assert.deepEqual(
            phases[0].panel,
            phases[1].panel,
            `${name}: stationary popup throughout fade`,
          );
          assert.ok(
            phases[0].opacity > 0 &&
              phases[0].opacity < phases[1].opacity &&
              phases[1].opacity === 1,
            `${name}: fade changes opacity without moving its hitbox`,
          );
          await send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            clickCount: 1,
            x: initial.trigger.x + 18,
            y: initial.trigger.y + 18,
          });
          await delay(150);
          const pressed = await evaluate(contextMeasure);
          assert.equal(Number(pressed.scale), 0.96);
          await screenshot(`${name}-pressed.png`);
          await send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            clickCount: 1,
            x: initial.trigger.x + 18,
            y: initial.trigger.y + 18,
          });
          await send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-reduced-motion", value: "reduce" }],
          });
          await delay(100);
          const reduced = await evaluate(contextMeasure);
          assert.ok(["none", "1"].includes(reduced.scale));
          if (reduced.panel) assert.equal(reduced.animation, "none");
          await screenshot(`${name}-reduced-motion.png`);
          await send("Emulation.setEmulatedMedia", { features: [] });
          evidence.context.push({
            variant,
            ...options,
            initial,
            hover,
            phases,
            pressed,
            reduced,
            hoverBridge: true,
            escapeClosed: true,
          });
        } else evidence.context.push({ variant, ...options, initial, hover });
      }
    }
  },
);
await writeFile(
  path.join(directory, "measurements.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  "Captured approved Sidebar shortcut and context hover before/after, geometry, dismissal and reduced-motion evidence.",
);
