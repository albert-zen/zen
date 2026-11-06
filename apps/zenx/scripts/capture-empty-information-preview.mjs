import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";
const directory = path.resolve(
  process.argv[2] ?? ".information-layout-preview",
);
const cases = [];
const toggleGeometry = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    const wait = async (expression) => {
      for (let i = 0; i < 240; i++) {
        assert.deepEqual(errors, []);
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw Error(`Timed out: ${expression}`);
    };
    let touchInput = false;
    const click = async (selector) => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
      const point = await evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(e.disabled||!r.width||!r.height||!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Hidden/disabled/obscured target');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      if (touchInput) {
        await send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ ...point, radiusX: 1, radiusY: 1, force: 1, id: 1 }],
        });
        await send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      } else {
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", {
            type,
            button: "left",
            clickCount: 1,
            ...point,
          });
      }
      await wait(
        "!document.querySelector('.editable-information-panel[data-busy=\"true\"]')",
      );
    };
    const count =
      "[...document.querySelectorAll('.information-widget')].filter(e=>e.getBoundingClientRect().height>0).length";
    let navigation = 0;
    const navigate = async (query) => {
      const token = `capture-${++navigation}`;
      const target = `${url}/information.html?question=0&${query}&capture=${token}`;
      await send("Page.navigate", { url: target });
      // A Page.navigate ACK can precede the replacement document. Match both
      // URL and a token initialized by that document, never the old global.
      await wait(
        `location.href===${JSON.stringify(target)} && window.__informationFixture?.navigationToken===${JSON.stringify(token)}`,
      );
      await click('[aria-label="Information board"]');
      await wait("!!document.querySelector('.editable-information-panel')");
      await delay(150);
    };
    const toggleSelector =
      '.information-trigger-list li:first-child [role="switch"]';
    const inspectToggle = async (label, expected) => {
      await wait(
        `document.querySelector(${JSON.stringify(toggleSelector)})?.getAttribute('aria-checked')===${JSON.stringify(String(expected))} && document.querySelector(${JSON.stringify(toggleSelector)})?.getAttribute('aria-busy')==='false'`,
      );
      await delay(220); // Inspect the final 180ms thumb transition, not an intermediate frame.
      const geometry = await evaluate(`(()=>{
        const e=document.querySelector(${JSON.stringify(toggleSelector)}), r=e.getBoundingClientRect();
        const box=(pseudo)=>{const s=getComputedStyle(e,pseudo), n=v=>parseFloat(v)||0, m=new DOMMatrixReadOnly(s.transform==='none'?undefined:s.transform);let width=n(s.width),height=n(s.height);if(s.boxSizing!=='border-box'){width+=n(s.borderLeftWidth)+n(s.borderRightWidth)+n(s.paddingLeft)+n(s.paddingRight);height+=n(s.borderTopWidth)+n(s.borderBottomWidth)+n(s.paddingTop)+n(s.paddingBottom);}return {left:r.left+n(s.left)+m.m41,top:r.top+n(s.top)+m.m42,width,height};};
        const statuses=[...document.querySelectorAll('.information-trigger-list small')].map(el=>{const s=getComputedStyle(el),b=el.getBoundingClientRect();return {text:el.textContent,clip:s.clip,clipPath:s.clipPath,overflow:s.overflow,width:b.width,height:b.height};});
        const clone=e.closest('.information-trigger-list').cloneNode(true);clone.querySelectorAll('.sr-only').forEach(n=>n.remove());
        return {track:box('::before'),thumb:box('::after'),checked:e.getAttribute('aria-checked'),ariaLabel:e.getAttribute('aria-label'),visibleRowText:clone.textContent,statuses,hover:matchMedia('(hover:hover)').matches,finePointer:matchMedia('(pointer:fine)').matches,touchPoints:navigator.maxTouchPoints};
      })()`);
      const { track, thumb } = geometry;
      assert.ok(
        track.width > 0 &&
          track.height > 0 &&
          thumb.width > 0 &&
          thumb.height > 0,
      );
      assert.ok(
        thumb.left >= track.left - 0.5 &&
          thumb.top >= track.top - 0.5 &&
          thumb.left + thumb.width <= track.left + track.width + 0.5 &&
          thumb.top + thumb.height <= track.top + track.height + 0.5,
        `${label}: thumb must stay inside track: ${JSON.stringify(geometry)}`,
      );
      assert.equal(geometry.checked, String(expected));
      if (touchInput)
        assert.ok(geometry.touchPoints > 0, "touch emulation must be active");
      if (!touchInput && process.env.ZENX_PREVIEW_DESKTOP_INPUT === "1")
        assert.ok(
          geometry.hover && geometry.finePointer,
          "desktop capture must exercise hover/fine-pointer CSS",
        );
      assert.match(geometry.ariaLabel, expected ? /Pause/ : /Enable/);
      assert.doesNotMatch(geometry.visibleRowText, /\b(?:Enabled|Paused)\b/i);
      for (const status of geometry.statuses)
        assert.ok(
          status.width <= 1 &&
            status.height <= 1 &&
            status.overflow === "hidden" &&
            (status.clip !== "auto" || status.clipPath !== "none"),
          `${label}: duplicate state must be visually clipped`,
        );
      toggleGeometry.push({
        label,
        input: touchInput ? "touch" : "mouse",
        ...geometry,
      });
      return geometry;
    };
    const exerciseToggle = async (label) => {
      const before = await evaluate(
        "window.__informationFixture.triggerUpdates().length",
      );
      const on = await inspectToggle(label + "-on", true);
      await click(toggleSelector);
      const off = await inspectToggle(label + "-off", false);
      assert.ok(
        on.thumb.left > off.thumb.left + 1,
        "on/off states must move the thumb",
      );
      await screenshot(`${label}-off.png`);
      await click(toggleSelector);
      await inspectToggle(label + "-restored-on", true);
      await screenshot(`${label}-on.png`);
      assert.deepEqual(
        await evaluate(
          `window.__informationFixture.triggerUpdates().slice(${before})`,
        ),
        [
          { command: "cancel", triggerId: "synthetic-timer", active: false },
          { command: "resume", triggerId: "synthetic-timer", active: true },
        ],
      );
      cases.push(
        `${label}: real ${touchInput ? "touch" : "mouse"} toggles update aria and synthetic provider facts once, both thumb states fit the track, no visible duplicate status`,
      );
    };
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1040,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate("scene=empty");
    await wait(`${count}===0`);
    assert.equal(
      await evaluate("document.querySelectorAll('.information-widget').length"),
      5,
      "empty providers stay mounted",
    );
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('button')].some(e=>/refresh/i.test(e.getAttribute('aria-label')||e.textContent))",
      ),
      false,
    );
    await screenshot("01-empty-light.png");
    await evaluate("window.__informationFixture.setScene('trigger')");
    await wait(`${count}===1`);
    await screenshot("02-trigger-auto-appears.png");
    await exerciseToggle("06-desktop-light-toggle");
    cases.push(
      "Empty providers stay mounted; trigger content automatically appears without a layout write or refresh control",
    );
    assert.equal(await evaluate("window.__informationFixture.updates()"), 0);
    await click('[aria-label="Hide · Thread triggers"]');
    await wait(`${count}===0`);
    await evaluate("window.__informationFixture.setScene('empty')");
    await delay(100);
    await evaluate("window.__informationFixture.setScene('trigger')");
    await delay(100);
    assert.equal(
      await evaluate(count),
      0,
      "explicitly hidden content stays hidden",
    );
    await click('[aria-label="Customize information"]');
    await wait(`${count}===5`);
    await screenshot("03-manage-light.png");
    await click(
      '[data-widget-id="default:triggers"] .information-widget-actions button:nth-child(3)',
    );
    await click(".information-customize");
    await wait(`${count}===1`);
    cases.push(
      "Explicit Hide persists across content changes; Manage/Show restores the chosen card",
    );
    await click('[aria-label="Close information"]');
    await wait("!document.querySelector('.editable-information-panel')");
    assert.equal(
      await evaluate("document.activeElement?.getAttribute('aria-label')"),
      "Information board",
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 760,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate("scene=trigger&theme=dark");
    await wait("!!document.querySelector('.information-popover')");
    await wait(`${count}===1`);
    await screenshot("04-narrow-dark-popover.png");
    await exerciseToggle("07-narrow-dark-toggle");
    await click('[aria-label="Close information"]');
    await wait("!document.querySelector('.information-popover')");
    assert.equal(
      await evaluate("document.activeElement?.getAttribute('aria-label')"),
      "Information board",
    );
    cases.push(
      "Narrow dark popover renders only available content; visible Close restores trigger focus",
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1040,
      deviceScaleFactor: 1,
      mobile: false,
    });
    touchInput = true;
    await send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 760,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate("scene=trigger&theme=light");
    await wait(`${count}===1`);
    await exerciseToggle("08-touch-light-toggle");
    touchInput = false;
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1040,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate("scene=populated");
    await wait(`${count}===3`);
    assert.equal(
      await evaluate("document.querySelectorAll('.board-field input').length"),
      2,
    );
    await screenshot("05-populated-boards.png");
    cases.push(
      "Existing independent Board documents remain visible alongside triggers",
    );
  },
);
await writeFile(
  path.join(directory, "empty-information-acceptance.json"),
  JSON.stringify(
    {
      ok: true,
      synthetic: true,
      scope:
        "Real production React components and CSS in Chromium; synthetic in-memory ports and outer scaffold, not native Electron/real Host acceptance",
      cases,
      toggleGeometry,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Captured ${cases.length} empty-information cases at ${directory}`);
