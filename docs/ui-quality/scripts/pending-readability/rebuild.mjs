/** Build-only. Production styles/components are bundled without source rewriting. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv[2] || !process.argv[3])
  throw Error("Usage: node rebuild.mjs REPOSITORY NEW_OUTPUT_DIRECTORY");
const root = await realpath(process.argv[2]);
const out = path.resolve(process.argv[3]);
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
// Refuse existing outputs so a rebuild cannot overwrite captured evidence/profile data.
await mkdir(out);
const sourcePaths = [
  "fixture.tsx",
  "rebuild.mjs",
  "launch.cjs",
  "launch.sh",
  "README.md",
];
const require = createRequire(path.join(root, "package.json"));
const { build } = await import(require.resolve("vite"));
const { JSDOM, VirtualConsole } = require("jsdom");
const result = await build({
  configFile: false,
  root,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  resolve: {
    alias: [
      { find: "@repo", replacement: root },
      ...["react", "react/jsx-runtime", "react-dom", "react-dom/client"].map(
        (name) => ({
          find: new RegExp(`^${name}$`),
          replacement: require.resolve(name),
        }),
      ),
    ],
  },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(sourceDirectory, "fixture.tsx"),
      name: "PendingReadabilityCandidate",
      formats: ["iife"],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const assets = (Array.isArray(result) ? result[0] : result).output;
const js = assets
  .filter((item) => item.type === "chunk")
  .map((item) => item.code)
  .join("\n");
const css = assets
  .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
  .map((item) => String(item.source))
  .join("\n");
assert.ok(js && css);
const escapeScript = (source) => source.replaceAll("</script", "<\\/script");
const component = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pending/readability · synthetic production components</title><style>${css}</style></head><body><div id="root"></div><script>${escapeScript(js)}</script></body></html>`;
await writeFile(path.join(out, "component.html"), component);

function initializeFrame(component, height) {
  const options = new URLSearchParams(location.search);
  const frame = document.querySelector("iframe");
  frame.style.height = `${height}px`;
  const config =
    `<script>window.__qaSearch=${JSON.stringify(options.toString())};<` +
    "/script>";
  frame.srcdoc = component.replace("<body>", `<body>${config}`);
  window.__pendingReadabilityFrame = frame;
  setInterval(() => {
    const child = frame.contentWindow;
    const status = child?.__pendingReadability;
    document.querySelector("[data-frame-metrics]").textContent = status?.ready
      ? `Actual iframe viewport: ${child.innerWidth} × ${child.innerHeight} CSS px. Native zoom is recorded by the launcher.`
      : "Waiting for production fixture…";
  }, 250);
}
for (const [name, height] of [
  ["narrow.html", 680],
  ["narrow-zoom200.html", 300],
]) {
  const script = `(${initializeFrame.toString()})(${JSON.stringify(component)}, ${height});`;
  await writeFile(
    path.join(out, name),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>390px component viewport · synthetic</title><style>body{margin:0;padding:12px;font:12px/1.4 sans-serif;background:#ddd;color:#222}header{margin:0 0 8px;max-width:650px}iframe{display:block;border:0;width:390px;box-shadow:0 0 0 1px #777}p{margin:4px 0}</style></head><body><header><strong>390px iframe component viewport, not full-app mobile support</strong><p data-frame-metrics>Waiting for production fixture…</p></header><iframe title="Production ThreadView and send controls in an exact 390px CSS viewport"></iframe><script>${escapeScript(script)}</script></body></html>`,
  );
}

const validated = [];
for (const scenario of ["pending", "send", "footer"]) {
  for (const lang of ["en", "zh-CN"]) {
    const errors = [];
    const console = new VirtualConsole();
    console.on("jsdomError", (error) => {
      if (error.type !== "css-parsing") errors.push(error.message);
    });
    console.on("error", (error) => errors.push(String(error)));
    const dom = new JSDOM(component, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: `http://localhost/component.html?scenario=${scenario}&lang=${lang}`,
      virtualConsole: console,
      beforeParse(window) {
        window.structuredClone = structuredClone;
        window.matchMedia = (media) => ({
          media,
          matches: false,
          addEventListener() {},
          removeEventListener() {},
        });
        window.HTMLElement.prototype.scrollIntoView = function () {};
        window.HTMLElement.prototype.scrollTo = function () {};
        window.HTMLElement.prototype.hasPointerCapture = () => false;
        window.HTMLElement.prototype.setPointerCapture = function () {};
        window.HTMLElement.prototype.releasePointerCapture = function () {};
        window.Range.prototype.getClientRects = () => [];
        window.Range.prototype.getBoundingClientRect = () => ({
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          top: 0,
          left: 0,
          bottom: 0,
          right: 0,
        });
        window.scrollTo = function () {};
      },
    });
    try {
      const deadline = performance.now() + 10000;
      while (
        !dom.window.__pendingReadability?.ready &&
        !errors.length &&
        performance.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(errors, [], `${scenario}/${lang}: runtime errors`);
      assert.equal(
        dom.window.__pendingReadability?.ready,
        true,
        `${scenario}/${lang}: ready`,
      );
      const doc = dom.window.document;
      assert.equal(doc.querySelectorAll(".pending-tray").length, 1);
      assert.equal(doc.querySelectorAll(".steer-shelf-row").length, 2);
      assert.equal(
        doc.querySelectorAll(".queue-shelf:not(.steer-shelf) .queue-row")
          .length,
        3,
      );
      assert.equal(
        doc.documentElement.hasAttribute("data-scrollbar-autohide"),
        true,
      );
      if (scenario !== "pending") {
        const panel = doc.querySelector(".composer-send-popover");
        assert.equal(panel?.getAttribute("role"), "dialog");
        assert.equal(
          panel.querySelectorAll(
            ".composer-send-summary, .composer-send-options button",
          ).length,
          5,
        );
        assert.equal(panel.querySelectorAll("kbd").length, 2);
        assert.ok(panel.querySelector(".composer-send-default .ui-select"));
        if (scenario === "footer")
          assert.ok(
            doc.activeElement.matches(".composer-send-default .ui-select"),
          );
        doc.activeElement.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(doc.querySelector(".composer-send-popover"), null);
        assert.ok(
          doc.activeElement.matches(".composer-send-control .action-orb"),
        );
      } else assert.equal(doc.querySelector(".composer-send-popover"), null);
      validated.push({
        scenario,
        lang,
        status: "passed",
        boundary: "JSDOM content/focus only, no layout claim",
      });
    } finally {
      dom.window.close();
    }
  }
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relevant = [
  "apps/zenx/src/renderer/src/ThreadView.tsx",
  "apps/zenx/src/renderer/src/ComposerSendControl.tsx",
  "apps/zenx/src/renderer/src/ComposerSendControl.css",
  "apps/zenx/src/renderer/src/queued-messages.css",
  "apps/zenx/src/renderer/src/QueuedMessages.tsx",
  "apps/zenx/src/renderer/src/PendingSteerPanel.tsx",
  "apps/zenx/src/renderer/src/styles.css",
  "apps/zenx/src/renderer/src/theme.css",
  "apps/zenx/src/renderer/src/scrollbar-visibility.ts",
  "apps/zenx/src/renderer/src/i18n/shell.ts",
  "apps/zenx/test/fixtures/agent-runtime-data.ts",
  "apps/zenx/test/fixtures/agent-queue-data.ts",
  "apps/zenx/test/native-recovery-fixture.ts",
];
const source = [];
for (const file of relevant)
  source.push({
    path: file,
    sha256: hash(await readFile(path.join(root, file))),
  });
const files = [];
for (const file of ["component.html", "narrow.html", "narrow-zoom200.html"]) {
  const bytes = await readFile(path.join(out, file));
  files.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
}
const fixtureSources = [];
for (const file of sourcePaths)
  fixtureSources.push({
    path: file,
    sha256: hash(await readFile(path.join(sourceDirectory, file))),
  });
await writeFile(
  path.join(out, "manifest.json"),
  JSON.stringify(
    {
      kind: "zenx-pending-readability-component-qa-v1",
      status: "BUILT_FUNCTIONALLY_VALIDATED_NOT_NATIVE_CAPTURED",
      boundary:
        "Unmodified production ThreadView, ComposerSendControl and shared CSS. Synthetic canonical 2-steer/3-queue history and local callback simulation, no Host/provider/network. QA header and initial focus driver are fixture-only. No native app launch or screenshot in preparation.",
      root,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      source,
      files,
      fixtureSources,
      validated,
      viewportModes: {
        desktop:
          "component.html fills actual BrowserWindow content. Record actual viewport; requested outer size is not proof.",
        narrow:
          "narrow.html embeds the exact same bundle in a 390 × 680 CSS-pixel iframe. This is component viewport testing, not full-app mobile support.",
        zoom200:
          "component.html at native Electron webContents.setZoomFactor(2); actual reduced CSS viewport measured at launch.",
        "narrow-zoom200":
          "narrow-zoom200.html with exact 390 × 300 CSS-pixel iframe at native zoomFactor 2. No CSS zoom/transform or screenshot manipulation.",
      },
      fixedClock:
        "QA-only Date.now = 2026-11-09T07:57:00Z; timers are unchanged",
      nativeCapture: {
        performed: false,
        requestedOuterBounds: { width: 1188, height: 848 },
        actualBounds: null,
        actualZoom: null,
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    {
      out,
      functionalCases: validated.length,
      entries: ["component.html", "narrow.html", "narrow-zoom200.html"],
    },
    null,
    2,
  ),
);
