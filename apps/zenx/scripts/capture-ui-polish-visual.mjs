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
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error(`Timed out waiting for ${message}`);
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("Missing ${selector}");
      const bounds = element.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      if (bounds.width <= 0 || bounds.height <= 0 || !element.contains(document.elementFromPoint(x, y)))
        throw new Error("Obscured ${selector}");
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
        type: "rawKeyDown",
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
            if (collapsed) await click(".sidebar-collapse-button");
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
          const machineAfterCancel = await evaluate(
            "document.querySelector('.fleet-machine-trigger')?.textContent?.trim()",
          );
          assert.equal(
            machineAfterCancel,
            machine.text,
            `${name}: Escape leaves the machine selection unchanged`,
          );

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
          await send("Input.insertText", { text: "Design" });
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
            `${name}: no machine connection/catalog request`,
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
            `(() => {const p=document.querySelector('.auxiliary-panel'),r=document.querySelector('.auxiliary-heading [role=tablist]').getBoundingClientRect();return{panel:{width:p.getBoundingClientRect().width,right:p.getBoundingClientRect().right},rail:{width:r.width,scrollWidth:document.querySelector('.auxiliary-heading [role=tablist]').scrollWidth},documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,tabs:[...document.querySelectorAll('.auxiliary-heading [role=tab]')].map(e=>({id:e.id,title:e.textContent?.trim(),icon:e.querySelector('svg')?.getAttribute('data-icon'),selected:e.getAttribute('aria-selected')}))}})()`,
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
              await send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                ...end,
                button: "left",
                buttons: 1,
              });
              await delay(250);
              return { start, end };
            };
            const finishDrag = async (point) =>
              send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                ...point,
                button: "left",
                buttons: 0,
                clickCount: 1,
              });
            const before = await evaluate(
              "window.__uiPolishAuxiliary.getState()",
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
            await screenshot(`${name}-drag-cancel-pending.png`);
            await key("Escape", "Escape", 27);
            await finishDrag(dragPoints.end);
            await waitFor(
              "!document.querySelector('.workspace-content-tab[data-drop-placement]')",
              "drag cancel feedback cleared",
            );
            const afterCancel = await evaluate(
              "window.__uiPolishAuxiliary.getState()",
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
            await screenshot(`${name}-drag-canceled.png`);

            const committedPoints = await drag(
              "custom:files",
              "custom:computer",
            );
            await waitFor(
              "document.querySelector('.workspace-content-tab[data-drop-placement]')",
              "second tab drag marker",
            );
            await finishDrag(committedPoints.end);
            await waitFor(
              "window.__uiPolishAuxiliary.getState().order[2]==='custom:files'",
              "dragged tab order applied",
            );
            const afterDrop = await evaluate(
              "window.__uiPolishAuxiliary.getState()",
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
            await screenshot(`${name}-drag-reordered.png`);
            evidence.auxiliary.push({
              name,
              initial,
              dimensions,
              afterCancel,
              afterDrop,
              canceledMarker,
            });
          } else evidence.auxiliary.push({ name, initial, dimensions });
          await writeFile(
            path.join(directory, "ui-polish-progress.json"),
            JSON.stringify(evidence, null, 2) + "\n",
          );
        }
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
