import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
const root = path.resolve(process.env.ZENX_SOURCE_ROOT ?? process.cwd());
const require = createRequire(`${root}/package.json`);
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { Markdown } = await import(
  pathToFileURL(`${root}/apps/zenx/src/renderer/src/Markdown.tsx`)
);
const { i18n } = await import(
  pathToFileURL(`${root}/apps/zenx/src/renderer/src/i18n.ts`)
);
await i18n.changeLanguage("en");
const markdown = (text) =>
  renderToStaticMarkup(createElement(Markdown, { text }));
const samples = [
  ["Simple user message", "Simple agent answer."],
  [
    "Line one\nLine two\n\nSecond paragraph",
    "**Bold** and *emphasis*, then `code`.",
  ],
  ["List request", "- first\n- second\n\n1. ordered\n2. again"],
  [
    "Table request",
    "| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |",
  ],
  ["Code request", "```ts\nconst a = 1;\n  const b = 2;\n```"],
  [
    "Quote request",
    "> quoted text\n> next line\n\n[Example](https://example.com)",
  ],
  [
    "Unicode: 中 文 🙂\n\nTrailing  spaces  ",
    "NBSP: A\u00a0B and tab:\tend.\n\nLast paragraph.",
  ],
  ["Empty final response", ""],
];
const icon =
  '<svg aria-hidden="true" width="14" height="14"><path d="M2 2h8v8H2z" fill="none" stroke="currentColor"/></svg>';
const actions = (kind) =>
  `<div class="message-actions ${kind}-message-actions"><time class="message-time" datetime="2026-11-04T12:00:00Z">12:00</time><span class="message-cache">cache 50%</span><button class="message-copy" type="button" aria-label="Copy">${icon}</button></div>`;
const rows = samples.map(
  ([user, agent], index) =>
    `<div class="fixture-row" data-row-key="${index}"><section class="turn completed"><article class="user-row" tabindex="-1"><div class="user-bubble">${markdown(user)}</div>${actions("user")}</article><button class="turn-toggle" type="button" aria-expanded="false"><span class="turn-work-label">Worked for 1s</span>${icon}</button><div class="turn-final"><article class="agent-copy" tabindex="-1"><div data-message-quote-body>${markdown(agent)}</div>${agent ? "" : '<span class="stream-cursor"></span>'}${actions("assistant")}</article></div></section></div>`,
);
const sourceCSS = await readFile(
  `${root}/apps/zenx/src/renderer/src/styles.css`,
  "utf8",
);
// Literal product CSS slices, not a replacement CSS interpretation.
const css =
  sourceCSS.slice(
    sourceCSS.indexOf("\n.turn {"),
    sourceCSS.indexOf(".stream-cursor {"),
  ) +
  sourceCSS.slice(
    sourceCSS.indexOf("\n.markdown-body {"),
    sourceCSS.indexOf(
      "@media (max-width: 820px)",
      sourceCSS.indexOf("\n.markdown-body {"),
    ),
  );
const mechanism = (
  await readFile(new URL("./segments.mjs", import.meta.url), "utf8")
).replaceAll("export ", "");
const runner = await readFile(
  new URL("./fixture-runner.js", import.meta.url),
  "utf8",
);
const payload = JSON.stringify(rows).replaceAll("<", "\\u003c");
const page = `<!doctype html><meta charset="utf-8"><title>Native selection segment mechanism fixture</title>
<style>
:root { --font-size-caption:12px; --color-text-primary:#222; --text-3:#555; --text-2:#333; --color-border:#ddd; --color-surface-elevated:#f5f5f5; --color-surface-wash:#fff; --surface-2:#eee; --border:#ccc; --border-soft:#ddd; --surface-inset:#fafafa; }
body { margin:20px; font:14px system-ui; } .fixture-toolbar { margin-bottom:12px; display:flex; gap:8px; align-items:center; } .fixture-note { max-width:850px; } #viewport { height:540px; overflow:auto; border:1px solid #aaa; padding:12px; width:800px; max-width:calc(100vw - 70px); overflow-anchor:none; } .fixture-row { padding-bottom:20px; box-sizing:border-box; } .projection-gap { position:relative; overflow:clip; } .projection-body { position:absolute; inset:0; } .flat-gap { white-space:pre-wrap; margin:0; font:inherit; } #result { white-space:pre-wrap; } ::selection { background:#86b7ef; color:#111; }
${css}</style>
<p class="fixture-note">Synthetic standalone fixture using actual ZenX Markdown HTML and literal relevant product CSS. Not the full product, native menu bridge, clipboard acceptance, or a React performance benchmark. The buttons below are test instrumentation only.</p>
<div class="fixture-toolbar"><button id="run">Compare all candidates</button><button id="full">Reset full</button><button id="host">Host gap</button><button id="pruned">Pruned gap</button><button id="flat">Flat gap</button><button id="select">Select fixture</button><input id="editor" value="local editor draft"></div>
<div id="viewport"><div id="transcript"></div></div><pre id="result"></pre>
<script>${mechanism}\nconst rowHTML = ${payload};\n${runner}</script>`;
await writeFile(new URL("./fixture.html", import.meta.url), page);
console.log(
  JSON.stringify({
    output: "fixture.html",
    rows: rows.length,
    htmlBytes: Buffer.byteLength(page),
    source: root,
    note: "Generated only; native browser not run",
  }),
);
