import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
const directory = path.resolve(process.argv[2] ?? ".ui-polish-visual");
const manifestPath = path.join(directory, "source.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const dirtyFiles = execFileSync("git", ["status", "--porcelain"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);
assert.equal(commit, manifest.commit, "Rebuild after the frozen source commit");
assert.deepEqual(dirtyFiles, [], "Capture requires a clean frozen worktree");
assert.deepEqual(
  manifest.dirtyFiles,
  [],
  "Build the artifact from a clean commit",
);
const html = await readFile(path.join(directory, manifest.artifact.html));
assert.equal(
  createHash("sha256").update(html).digest("hex"),
  manifest.artifact.htmlSha256,
  "Rebuild after the preview HTML changes",
);
for (const [source, expected] of Object.entries(manifest.sources)) {
  const actual = await readFile(path.join(appRoot, source));
  assert.equal(
    createHash("sha256").update(actual).digest("hex"),
    expected,
    `Rebuild after source change: ${source}`,
  );
}

// Existing Chrome only; the reusable helper never downloads a browser.
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const evidence = {
  commit,
  scope:
    "Synthetic local UI fixture using production App/Project selector/Fleet machine selector/AuxiliaryPanel. Network is blocked by fixture CSP; no real Host, profile, user data, model, filesystem or native desktop action.",
  welcome: [],
  auxiliary: [],
  status: "running",
};
const snapshot = async (evaluate, expression) => evaluate(expression);

await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    const waitFor = async (expression, message = expression) => {
      for (let index = 0; index < 240; index++) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await delay(50);
      }
      throw new Error(`Timed out waiting for ${message}`);
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("Missing " + ${JSON.stringify(selector)});
      const bounds = element.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      if (bounds.width <= 0 || bounds.height <= 0 || !element.contains(document.elementFromPoint(x, y)))
        throw new Error("Obscured " + ${JSON.stringify(selector)});
      return { x, y };
    })()`);
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        });
    };
    const key = async (value, code, virtualKeyCode, text) => {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: value,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        ...(text ? { text, unmodifiedText: text } : {}),
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: value,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
      });
    };
    const typeText = async (value) => {
      for (const character of value) {
        const upper = character.toUpperCase();
        const code = `Key${upper}`;
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: character,
          code,
          windowsVirtualKeyCode: upper.charCodeAt(0),
          text: character,
          unmodifiedText: character,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: character,
          code,
          windowsVirtualKeyCode: upper.charCodeAt(0),
        });
      }
    };
    const navigate = async (scene, theme, width, lang = "en") => {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      const query = new URLSearchParams({
        scene,
        theme,
        width: String(width),
        lang,
        platform: "darwin",
      });
      if (scene === "sidechat") query.set("conversationTabs", "1");
      const destination = `${url}/ui-polish-visual.html?${query}`;
      await send("Page.navigate", { url: destination });
      await waitFor(
        `location.href===${JSON.stringify(destination)} && document.body?.dataset.previewReady==='true'`,
        `${scene} fixture ready`,
      );
    };
    const viewport = () =>
      evaluate(
        `({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight})`,
      );

    try {
      for (const theme of ["light", "dark"])
        for (const width of [1280, 390]) {
          const name = `welcome-${theme}-${width}`;
          await navigate(
            "welcome",
            theme,
            width,
            theme === "light" ? "en" : "zh-CN",
          );
          await waitFor(
            "!!document.querySelector('.app-shell') && !!document.querySelector('.new-thread-action')",
            "App and Projects sidebar",
          );
          if (width <= 720) {
            const sidebar = await evaluate(
              "document.querySelector('#primary-sidebar')?.classList.contains('open')",
            );
            if (!sidebar) await click(".mobile-menu");
            await waitFor(
              "document.querySelector('#primary-sidebar')?.classList.contains('open')",
              "narrow Projects sidebar",
            );
            await delay(260);
          }
          await click(".new-thread-action");
          await waitFor(
            "!!document.querySelector('.new-thread-draft-empty') && !!document.querySelector('.fleet-machine-trigger')",
            "welcome draft with machine and Project controls",
          );
          if (width <= 720) {
            const collapsed = await evaluate(
              "document.querySelector('#primary-sidebar')?.classList.contains('open')",
            );
            if (collapsed) {
              await key("Escape", "Escape", 27);
              await waitFor(
                "!document.querySelector('#primary-sidebar')?.classList.contains('open')",
                "narrow Projects sidebar dismissed",
              );
              await delay(220);
            }
          }
          const base = await viewport();
          assert.ok(
            base.documentWidth <= width,
            `${name}: welcome has no horizontal page overflow`,
          );
          await screenshot(`${name}.png`);

          const machine = await evaluate(
            `(() => { const e=document.querySelector('.fleet-machine-trigger'); return e && {label:e.getAttribute('aria-label'),text:e.textContent,rect:(()=>{const r=e.getBoundingClientRect();return{x:r.x,right:r.right,width:r.width}})()}; })()`,
          );
          assert.ok(
            machine?.label,
            `${name}: machine trigger has an accessible name`,
          );
          await click(".fleet-machine-trigger");
          await waitFor(
            "document.querySelector('.fleet-machine-trigger')?.getAttribute('data-state')==='open'",
            "machine menu open",
          );
          const machineMenu = await evaluate(
            `(() => ({options:[...document.querySelectorAll('[role=option]')].map(e=>e.textContent?.trim()),highlighted:document.querySelector('[role=option][data-highlighted]')?.textContent?.trim()??null,viewportWidth:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}))()`,
          );
          assert.ok(
            machineMenu.options.length >= 3,
            `${name}: local and synthetic machine choices are present`,
          );
          await screenshot(`${name}-machine-open.png`);
          await key("ArrowDown", "ArrowDown", 40);
          await key("Escape", "Escape", 27);
          await waitFor(
            "document.querySelector('.fleet-machine-trigger')?.getAttribute('data-state')!=='open'",
            "machine menu canceled",
          );
          await waitFor(
            "document.activeElement===document.querySelector('.fleet-machine-trigger')",
            "machine focus restoration after Escape",
          );
          await evaluate(
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          );
          const machineAfterCancel = await evaluate(
            "document.querySelector('.fleet-machine-trigger')?.textContent?.trim()",
          );
          assert.equal(
            machineAfterCancel,
            machine.text,
            `${name}: Escape leaves the machine selection unchanged`,
          );
          await click(".fleet-machine-trigger");
          await waitFor(
            "!!document.querySelector('.fleet-machine-popover [role=option][data-value=\"synthetic-design\"]')",
            "long-name machine option",
          );
          await click(
            '.fleet-machine-popover [role="option"][data-value="synthetic-design"]',
          );
          await waitFor(
            "window.__uiPolishTelemetry.machineCatalogCalls===1 && document.querySelector('.fleet-machine-trigger')?.getAttribute('data-value')==='synthetic-design'",
            "long-name machine selected",
          );
          const longMachine = await evaluate(`(() => {
            const trigger = document.querySelector('.fleet-machine-trigger');
            const label = trigger?.querySelector('.fleet-machine-choice > span');
            const bounds = trigger?.getBoundingClientRect();
            const labelStyle = label ? getComputedStyle(label) : null;
            return {
              label: label?.textContent?.trim() ?? null,
              labelClientWidth: label?.clientWidth ?? 0,
              labelScrollWidth: label?.scrollWidth ?? 0,
              labelOverflow: labelStyle?.overflow ?? null,
              labelTextOverflow: labelStyle?.textOverflow ?? null,
              labelWhiteSpace: labelStyle?.whiteSpace ?? null,
              triggerWidth: bounds?.width ?? 0,
              triggerLeft: bounds?.left ?? 0,
              triggerRight: bounds?.right ?? 0,
              viewportWidth: innerWidth,
              pageOverflow: document.documentElement.scrollWidth > innerWidth,
              catalogCalls: window.__uiPolishTelemetry.machineCatalogCalls,
              machineThreadCreateCalls: window.__uiPolishTelemetry.machineThreadCreateCalls,
            };
          })()`);
          assert.ok(
            longMachine.label?.includes("visual QA lab"),
            `${name}: the selected machine label is the long synthetic device`,
          );
          assert.equal(longMachine.labelOverflow, "hidden");
          assert.equal(longMachine.labelTextOverflow, "ellipsis");
          assert.equal(longMachine.labelWhiteSpace, "nowrap");
          assert.ok(
            longMachine.triggerWidth <= 360 &&
              longMachine.triggerLeft >= 0 &&
              longMachine.triggerRight <= width &&
              !longMachine.pageOverflow,
            `${name}: long machine trigger stays inside viewport`,
          );
          assert.equal(longMachine.catalogCalls, 1);
          assert.equal(longMachine.machineThreadCreateCalls, 0);
          await screenshot(`${name}-machine-long-label.png`);
          await navigate(
            "welcome",
            theme,
            width,
            theme === "light" ? "en" : "zh-CN",
          );
          await waitFor(
            "!!document.querySelector('.app-shell') && !!document.querySelector('.new-thread-action')",
            "welcome reset to local fixture",
          );
          if (width <= 720) {
            const sidebar = await evaluate(
              "document.querySelector('#primary-sidebar')?.classList.contains('open')",
            );
            if (!sidebar) await click(".mobile-menu");
            await waitFor(
              "document.querySelector('#primary-sidebar')?.classList.contains('open')",
              "narrow Projects sidebar after machine check",
            );
            await delay(260);
          }
          await click(".new-thread-action");
          await waitFor(
            "!!document.querySelector('.new-thread-draft-empty') && !!document.querySelector('.new-thread-project-trigger-chip')",
            "local draft restored for Project selector check",
          );
          if (width <= 720) {
            await key("Escape", "Escape", 27);
            await waitFor(
              "!document.querySelector('#primary-sidebar')?.classList.contains('open')",
              "narrow Projects sidebar dismissed after machine check",
            );
            await delay(220);
          }

          await click(".new-thread-project-trigger-chip");
          await waitFor(
            "!!document.querySelector('.new-thread-project-popover-portal')",
            "Project popover open",
          );
          await waitFor(
            "document.activeElement?.matches('.new-thread-project-search input')",
            "Project search focus",
          );
          const projectOpen = await evaluate(
            `(() => {const e=document.querySelector('.new-thread-project-popover-portal');const r=e.getBoundingClientRect();return{options:[...e.querySelectorAll('[role=menuitemradio]')].map(x=>x.textContent?.trim()),rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},overflow:document.documentElement.scrollWidth>innerWidth}})()`,
          );
          assert.ok(
            projectOpen.options.length >= 3,
            `${name}: synthetic Projects are offered`,
          );
          assert.ok(
            projectOpen.rect.left >= 0 && projectOpen.rect.right <= width + 1,
            `${name}: Project popover stays in viewport`,
          );
          await screenshot(`${name}-project-open.png`);
          await typeText("Design");
          await waitFor(
            "document.querySelectorAll('.new-thread-project-popover-portal [role=menuitemradio]').length===1",
            "filtered Project result",
          );
          await key("ArrowDown", "ArrowDown", 40);
          const focusedProject = await evaluate(
            "document.activeElement?.getAttribute('role')==='menuitemradio' && document.activeElement?.textContent?.trim()",
          );
          assert.ok(
            focusedProject,
            `${name}: ArrowDown moves focus from search to a Project`,
          );
          await screenshot(`${name}-project-keyboard.png`);
          await key("Enter", "Enter", 13, "\r");
          await waitFor(
            "!document.querySelector('.new-thread-project-popover-portal')",
            "Project selection closes popover",
          );
          const selectedProject = await evaluate(
            "document.querySelector('.new-thread-project-trigger-chip span')?.textContent?.trim()",
          );
          assert.equal(
            selectedProject,
            "Design system",
            `${name}: keyboard selection updates only the visible draft Project`,
          );
          await click(".new-thread-project-trigger-chip");
          await waitFor(
            "!!document.querySelector('.new-thread-project-popover-portal')",
            "Project popover reopened",
          );
          await key("Escape", "Escape", 27);
          await waitFor(
            "!document.querySelector('.new-thread-project-popover-portal')",
            "Project popover canceled",
          );
          assert.equal(
            await evaluate(
              "document.activeElement?.matches('.new-thread-project-trigger-chip')",
            ),
            true,
            `${name}: Escape restores Project trigger focus`,
          );
          assert.equal(
            await evaluate(
              "document.querySelector('.new-thread-project-trigger-chip span')?.textContent?.trim()",
            ),
            "Design system",
            `${name}: cancel does not change selected Project`,
          );

          const telemetry = await evaluate("window.__uiPolishTelemetry");
          assert.equal(
            telemetry.machineCatalogCalls,
            0,
            `${name}: reset fixture has no machine catalog calls before Project interaction`,
          );
          assert.equal(
            telemetry.workspaceUsedCalls,
            0,
            `${name}: no Project preference write`,
          );
          assert.ok(
            !telemetry.protocolCalls.some((method) =>
              /thread.*create|create.*thread/i.test(method),
            ),
            `${name}: no Thread created before first Send`,
          );
          evidence.welcome.push({
            name,
            viewport: base,
            machineMenu,
            projectOpen,
            focusedProject,
            selectedProject,
            telemetry,
          });
          await writeFile(
            path.join(directory, "ui-polish-progress.json"),
            JSON.stringify(evidence, null, 2) + "\n",
          );
        }

      for (const theme of ["light", "dark"])
        for (const width of [1280, 390]) {
          const name = `auxiliary-${theme}-${width}`;
          await navigate(
            "auxiliary",
            theme,
            width,
            theme === "light" ? "en" : "zh-CN",
          );
          await waitFor(
            "!!document.querySelector('.auxiliary-panel[data-open=true]') && !!window.__uiPolishAuxiliary",
            "AuxiliaryPanel ready",
          );
          const initial = await snapshot(
            evaluate,
            "window.__uiPolishAuxiliary.getState()",
          );
          const dimensions = await evaluate(
            `(() => {const p=document.querySelector('.auxiliary-panel'),r=document.querySelector('.auxiliary-heading [role=tablist]').getBoundingClientRect();return{panel:{width:p.getBoundingClientRect().width,right:p.getBoundingClientRect().right},rail:{width:r.width,scrollWidth:document.querySelector('.auxiliary-heading [role=tablist]').scrollWidth},documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,tabs:[...document.querySelectorAll('.auxiliary-heading [role=tab]')].map(e=>{const w=e.closest('.workspace-content-tab'),r=w.getBoundingClientRect();return{id:e.id,title:e.textContent?.trim(),icon:e.querySelector('svg')?.getAttribute('data-icon'),selected:e.getAttribute('aria-selected'),draggable:w.draggable,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})}})()`,
          );
          assert.ok(
            dimensions.documentWidth <= width,
            `${name}: no horizontal page overflow`,
          );
          assert.ok(
            dimensions.tabs.every((tab) => tab.icon),
            `${name}: every tab uses its production icon component`,
          );
          await screenshot(`${name}.png`);
          if (theme === "light" && width === 1280) {
            const drag = async (sourceId, targetId, fraction = 0.82) => {
              const start = await evaluate(
                `(() => {const e=document.getElementById(${JSON.stringify(`aux-tab-${sourceId}`)})?.closest('.workspace-content-tab');if(!e)throw new Error('Missing drag source');const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`,
              );
              const end = await evaluate(
                `(() => {const e=document.getElementById(${JSON.stringify(`aux-tab-${targetId}`)})?.closest('.workspace-content-tab');if(!e)throw new Error('Missing drag target');const r=e.getBoundingClientRect();return{x:r.left+r.width*${fraction},y:r.top+r.height/2}})()`,
              );
              await send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                ...start,
              });
              await send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                ...start,
                button: "left",
                buttons: 1,
                clickCount: 1,
              });
              await delay(150);
              for (let step = 1; step <= 12; step++) {
                const progress = step / 12;
                await send("Input.dispatchMouseEvent", {
                  type: "mouseMoved",
                  x: start.x + (end.x - start.x) * progress,
                  y: start.y + (end.y - start.y) * progress,
                  button: "left",
                  buttons: 1,
                });
                await delay(30);
              }
              await delay(250);
              return { start, end };
            };
            const finishDrag = async (point, sourceId) => {
              if (sourceId) {
                await send("Input.dispatchDragEvent", {
                  type: "drop",
                  ...point,
                  data: {
                    items: [
                      {
                        mimeType: "application/x-zenx-workspace-tab",
                        data: sourceId,
                      },
                    ],
                    dragOperationsMask: 16,
                  },
                });
              }
              return send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                ...point,
                button: "left",
                buttons: 0,
                clickCount: 1,
              });
            };
            const before = await evaluate(
              "window.__uiPolishAuxiliary.getState()",
            );
            await evaluate(
              `(() => {window.__uiPolishDragEvents=[];for(const type of ['dragstart','dragenter','dragover','drop','dragend'])document.addEventListener(type,e=>window.__uiPolishDragEvents.push({type,target:e.target?.closest?.('.workspace-content-tab')?.querySelector('[role=tab]')?.id??e.target?.id??null,x:e.clientX,defaultPrevented:e.defaultPrevented,dropEffect:e.dataTransfer?.dropEffect??null}),false)})()`,
            );
            const dragPoints = await drag("custom:files", "custom:computer");
            await waitFor(
              "document.querySelector('.workspace-content-tab[data-drop-placement]')",
              "visible tab drag insertion marker",
            );
            const cancelledMarker = await evaluate(
              "document.querySelector('.workspace-content-tab[data-drop-placement]')?.dataset.dropPlacement",
            );
            assert.ok(
              cancelledMarker === "before" || cancelledMarker === "after",
            );
            await key("Escape", "Escape", 27);
            await finishDrag(dragPoints.end);
            await waitFor(
              "!document.querySelector('.workspace-content-tab[data-drop-placement]')",
              "drag cancel feedback cleared",
            );
            const afterCancel = await evaluate(
              "window.__uiPolishAuxiliary.getState()",
            );
            const cancelEvents = await evaluate("window.__uiPolishDragEvents");
            assert.ok(
              !cancelEvents.some((event) => event.type === "drop"),
              `${name}: Escape canceled the native drag before drop`,
            );
            assert.deepEqual(
              afterCancel.order,
              before.order,
              `${name}: Escape cancels without changing order`,
            );
            assert.equal(
              afterCancel.writes.length,
              before.writes.length,
              `${name}: canceled drag does not persist an order`,
            );

            const committedPoints = await drag(
              "custom:files",
              "custom:computer",
            );
            await waitFor(
              "document.querySelector('.workspace-content-tab[data-drop-placement]')",
              "second tab drag marker",
            );
            const dropTarget = await evaluate(`(() => {
              const point = ${JSON.stringify(committedPoints.end)};
              const hit = document.elementFromPoint(point.x, point.y);
              const tab = hit?.closest('.workspace-content-tab');
              const rect = tab?.getBoundingClientRect();
              const rail = document.querySelector('.auxiliary-heading [role=tablist]');
              return {
                point,
                hit: hit?.outerHTML?.slice(0, 220) ?? null,
                tabId: tab?.querySelector('[role=tab]')?.id ?? null,
                tabRect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null,
                railScrollLeft: rail?.scrollLeft ?? null,
              };
            })()`);
            assert.equal(
              dropTarget.tabId,
              "aux-tab-custom:computer",
              `${name}: drop hit-testing targets the Computer tab`,
            );
            await finishDrag(committedPoints.end, "custom:files");
            await waitFor(
              "window.__uiPolishAuxiliary.getState().order[2]==='custom:files'",
              "dragged tab order applied",
            );
            const afterDrop = await evaluate(
              "window.__uiPolishAuxiliary.getState()",
            );
            const committedEvents = await evaluate(
              "window.__uiPolishDragEvents",
            );
            assert.ok(
              committedEvents.some(
                (event) =>
                  event.type === "drop" &&
                  event.target === "aux-tab-custom:computer",
              ),
              `${name}: CDP drop input reached the Computer tab`,
            );
            assert.deepEqual(afterDrop.order, [
              "custom:browser",
              "custom:computer",
              "custom:files",
              "custom:subagents",
              "custom:triggers",
            ]);
            assert.equal(
              afterDrop.writes.length,
              before.writes.length + 1,
              `${name}: one completed drag produces one order update`,
            );
            await delay(400);
            await screenshot(`${name}-drag-reordered.png`);
            evidence.auxiliary.push({
              name,
              initial,
              dimensions,
              afterCancel,
              afterDrop,
              cancelledMarker,
              cancelEvents,
              committedEvents,
              dropTarget,
            });
          } else evidence.auxiliary.push({ name, initial, dimensions });
          await writeFile(
            path.join(directory, "ui-polish-progress.json"),
            JSON.stringify(evidence, null, 2) + "\n",
          );
        }
      const sidechatName = "sidechat-light-1280";
      await navigate("sidechat", "light", 1280);
      await waitFor(
        "!!document.querySelector('.app-shell') && !!document.querySelector('.thread-row')",
        "synthetic parent thread ready for side chat",
      );
      await click(".thread-row");
      await waitFor(
        "!!document.querySelector('#thread-browser-toggle')",
        "parent thread opened",
      );
      await click("#thread-browser-toggle");
      await waitFor(
        "(document.querySelector('#thread-workspace-panel[data-open=\"true\"]')?.getBoundingClientRect().width??0)>=360 && !!document.querySelector('#thread-workspace-panel .workspace-tab-types')",
        "parent auxiliary panel opened",
      );
      await click("#thread-workspace-panel .workspace-plugin-choice button");
      await waitFor(
        "!!document.querySelector('#thread-workspace-panel [role=tablist]')",
        "Subagents panel tab opened",
      );
      const subagentsTab =
        await evaluate(`(() => [...document.querySelectorAll('#thread-workspace-panel [role=tab]')]
        .find(tab => tab.textContent?.includes('Subagents'))?.id ?? null)()`);
      assert.ok(
        subagentsTab,
        "Subagents tab is visible in the actual parent panel",
      );
      await waitFor(
        "!!document.querySelector('#thread-workspace-panel [aria-label=\"New side chat\"]')",
        "Subagents side chat action",
      );
      await click('#thread-workspace-panel [aria-label="New side chat"]');
      await waitFor(
        "!!document.querySelector('[id^=\"side-chat-draft-\"]')",
        "local side chat draft composer",
      );
      const sideDraft = await evaluate(`(() => ({
        tabs: [...document.querySelectorAll('#thread-workspace-panel [role=tab]')].map(tab => tab.textContent?.trim()),
        composer: document.querySelector('[id^="side-chat-draft-"]')?.getAttribute('placeholder') ?? null,
        nativeCreateCalls: window.__uiPolishTelemetry.protocolCalls.filter(method => method.includes('create-child')).length,
        pluginCreateCalls: window.__uiPolishTelemetry.sideChatCreateCommandCalls,
      }))()`);
      assert.equal(
        sideDraft.nativeCreateCalls,
        0,
        "opening a side chat draft creates no native thread",
      );
      assert.equal(
        sideDraft.pluginCreateCalls,
        0,
        "opening a side chat draft invokes no provider create command",
      );
      await waitFor(
        "(document.querySelector('.window-titlebar')?.getBoundingClientRect().right??Infinity) <= (document.querySelector('#thread-workspace-panel')?.getBoundingClientRect().left??0) + 1",
        "titlebar resized clear of the parent auxiliary panel",
      );
      const sideLayout = await evaluate(`(() => {
        const shell = document.querySelector('.app-shell');
        const titlebar = document.querySelector('.window-titlebar');
        const panel = document.querySelector('#thread-workspace-panel');
        const tab = [...panel.querySelectorAll('[role=tab]')].find(entry => entry.textContent?.includes('Side chat'));
        const icon = tab?.querySelector('svg');
        const rect = element => {
          const bounds = element?.getBoundingClientRect();
          return bounds ? { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom } : null;
        };
        const iconRect = icon?.getBoundingClientRect();
        const hit = iconRect ? document.elementFromPoint(iconRect.left + iconRect.width / 2, iconRect.top + iconRect.height / 2) : null;
        return {
          workspacePanelWidth: shell?.style.getPropertyValue('--workspace-panel-width') ?? '',
          titlebar: rect(titlebar),
          panel: rect(panel),
          tab: rect(tab),
          tabId: tab?.id ?? null,
          tabIcon: icon?.getAttribute('data-icon') ?? null,
          icon: rect(icon),
          iconHitTabId: hit?.closest('[role=tab]')?.id ?? null,
        };
      })()`);
      assert.equal(
        sideLayout.iconHitTabId,
        sideLayout.tabId,
        "Side chat icon is visible and receives pointer hit testing",
      );
      await screenshot(`${sidechatName}.png`);
      await click('#thread-workspace-panel [aria-label="Close tab Side chat"]');
      await waitFor(
        "!document.querySelector('[id^=\"side-chat-draft-\"]')",
        "side chat draft closed",
      );
      const sideDraftAfterClose = await evaluate(`({
        nativeCreateCalls: window.__uiPolishTelemetry.protocolCalls.filter(method => method.includes('create-child')).length,
        pluginCreateCalls: window.__uiPolishTelemetry.sideChatCreateCommandCalls,
      })`);
      assert.equal(sideDraftAfterClose.nativeCreateCalls, 0);
      assert.equal(sideDraftAfterClose.pluginCreateCalls, 0);
      evidence.sidechat = {
        name: sidechatName,
        sideDraft,
        sideLayout,
        sideDraftAfterClose,
      };
      evidence.status = "passed";
    } catch (error) {
      evidence.status = "failed";
      evidence.error = String(error?.stack ?? error);
      try {
        await writeFile(
          path.join(directory, "ui-polish-failure.json"),
          JSON.stringify(evidence, null, 2) + "\n",
        );
        await screenshot("ui-polish-failed.png");
      } catch (artifactError) {
        console.error(
          `Could not retain failure evidence: ${String(artifactError)}`,
        );
      }
      throw error;
    } finally {
      await writeFile(
        path.join(directory, "ui-polish-capture.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
    }
  },
);
console.log(`Captured UI polish evidence in ${directory}`);
