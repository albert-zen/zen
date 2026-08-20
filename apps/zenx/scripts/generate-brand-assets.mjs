import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { board04TracePaths } from "./zenx-board04-trace-data.mjs";

const run = promisify(execFile);
const zenxRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rendererAssets = path.join(
  zenxRoot,
  "src",
  "renderer",
  "src",
  "assets",
  "brand",
);
const iconAssets = path.join(zenxRoot, "resources", "icons");
const docsAssets = path.join(zenxRoot, "docs", "assets", "brand");
const expectedIcnsSha256 =
  "092be1243492780cd0a75882434e4f269c00430c1f38eb29c70421b5569701b2";

export const geometryVersion = "zenx-board04-mechanical-v1";
export const wordmarkPaths = [
  "M4 14H54V18L13 46H54V50H4V46L45 18H4Z",
  "M80 14H128V18H85V30H122V34H85V46H128V50H80Z",
  "M154 50V14H158L198 44V14H202V50H198L158 20V50Z",
  "M228 14H234L252 29L270 14H276L255 32L276 50H270L252 35L234 50H228L249 32Z",
];

const markContent = board04TracePaths.x
  .map((pathValue) =>
    pathTag(pathValue, 'transform="translate(0 5) scale(.29)"'),
  )
  .join("\n  ");
const symbolContent = `${board04TracePaths.z
  .map((pathValue) => pathTag(pathValue, 'transform="scale(.32)"'))
  .join("\n  ")}
  ${board04TracePaths.x
    .map((pathValue) =>
      pathTag(pathValue, 'transform="translate(84 5) scale(.29)"'),
    )
    .join("\n  ")}`;
const wordmarkContent = wordmarkPaths
  .map((value) => pathTag(value))
  .join("\n  ");
const lockupContent = `<g transform="translate(8 16)">
    ${symbolContent.replaceAll("\n  ", "\n    ")}
  </g>
  <g transform="translate(172 16)">
    ${wordmarkContent.replaceAll("\n  ", "\n    ")}
  </g>`;

const generatedTextAssets = new Map([
  [
    path.join(rendererAssets, "zenx-mark.svg"),
    canonicalSvg({
      id: "zenx-mark-title",
      title: "ZenX compact mark",
      viewBox: "0 0 64 64",
      content: markContent,
    }),
  ],
  [
    path.join(rendererAssets, "zenx-symbol.svg"),
    canonicalSvg({
      id: "zenx-symbol-title",
      title: "ZenX symbol",
      viewBox: "0 0 148 64",
      content: symbolContent,
    }),
  ],
  [
    path.join(rendererAssets, "zenx-wordmark.svg"),
    canonicalSvg({
      id: "zenx-wordmark-title",
      title: "ZenX wordmark",
      viewBox: "0 0 300 64",
      content: wordmarkContent,
    }),
  ],
  [
    path.join(rendererAssets, "zenx-lockup.svg"),
    canonicalSvg({
      id: "zenx-lockup-title",
      title: "ZenX symbol and wordmark",
      viewBox: "0 0 480 96",
      content: lockupContent,
    }),
  ],
  [path.join(iconAssets, "zenx-app-icon.svg"), appIconSvg()],
  [path.join(docsAssets, "zenx-brand-preview.svg"), previewSvg()],
]);

if (process.argv.includes("--check")) {
  await checkGeneratedAssets();
} else {
  await writeGeneratedAssets();
}

async function writeGeneratedAssets() {
  if (process.platform !== "darwin") {
    throw new Error(
      "Generating the ZenX ICNS requires macOS sips and iconutil",
    );
  }
  await Promise.all(
    [...generatedTextAssets].map(async ([target, source]) => {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }),
  );
  const icns = await generateNativeIcns(appIconSvg());
  await writeFile(path.join(iconAssets, "zenx.icns"), icns);
  console.log(
    `Generated ${generatedTextAssets.size} ZenX SVG assets and ${icns.length} byte macOS icon`,
  );
}

async function checkGeneratedAssets() {
  const mismatches = [];
  for (const [target, source] of generatedTextAssets) {
    const actual = await readFile(target, "utf8").catch(() => "");
    if (actual !== source) mismatches.push(path.relative(zenxRoot, target));
  }
  const iconTarget = path.join(iconAssets, "zenx.icns");
  const actualIcon = await readFile(iconTarget).catch(() => Buffer.alloc(0));
  const iconMatches =
    process.platform === "darwin"
      ? actualIcon.equals(await generateNativeIcns(appIconSvg()))
      : sha256(actualIcon) === expectedIcnsSha256;
  if (!iconMatches) mismatches.push(path.relative(zenxRoot, iconTarget));
  if (mismatches.length > 0) {
    throw new Error(
      `Generated brand assets are stale: ${mismatches.join(", ")}`,
    );
  }
  console.log("ZenX generated brand assets are current");
}

async function generateNativeIcns(source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-icon-"));
  try {
    const sourcePath = path.join(directory, "zenx-app-icon.svg");
    const master = path.join(directory, "zenx-app-icon.png");
    const iconset = path.join(directory, "zenx.iconset");
    const output = path.join(directory, "zenx.icns");
    await writeFile(sourcePath, source);
    await mkdir(iconset);
    await run("/usr/bin/sips", [
      "-s",
      "format",
      "png",
      sourcePath,
      "--out",
      master,
    ]);
    const rasters = new Map();
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      const target = path.join(directory, `${String(size)}.png`);
      await run("/usr/bin/sips", [
        "-z",
        String(size),
        String(size),
        master,
        "--out",
        target,
      ]);
      rasters.set(size, target);
    }
    for (const [name, size] of [
      ["icon_16x16.png", 16],
      ["icon_16x16@2x.png", 32],
      ["icon_32x32.png", 32],
      ["icon_32x32@2x.png", 64],
      ["icon_128x128.png", 128],
      ["icon_128x128@2x.png", 256],
      ["icon_256x256.png", 256],
      ["icon_256x256@2x.png", 512],
      ["icon_512x512.png", 512],
      ["icon_512x512@2x.png", 1024],
    ]) {
      await cp(rasters.get(size), path.join(iconset, name));
    }
    await run("/usr/bin/iconutil", ["-c", "icns", "-o", output, iconset]);
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSvg({ id, title, viewBox, content }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="currentColor" role="img" aria-labelledby="${id}" data-geometry="${geometryVersion}">
  <title id="${id}">${title}</title>
  ${content}
</svg>
`;
}

function pathTag(value, attributes = "") {
  return `<path d="${value}"${attributes === "" ? "" : ` ${attributes}`} />`;
}

function appIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="zenx-app-icon-title" data-geometry="${geometryVersion}" data-safe-area="80 80 864 864" data-fill-contract="near-black tile and warm-white mark">
  <title id="zenx-app-icon-title">ZenX application icon</title>
  <path fill="#121419" d="M276 80H748C856 80 944 168 944 276V748C944 856 856 944 748 944H276C168 944 80 856 80 748V276C80 168 168 80 276 80Z" />
  <g fill="#F4F4F2" transform="translate(208 208) scale(9.5)">
    ${markContent.replaceAll("\n  ", "\n    ")}
  </g>
</svg>
`;
}

function previewSvg() {
  const smallSizes = [16, 20, 24, 32, 64, 128];
  const smallRow = (color, y) =>
    smallSizes
      .map((size, index) => {
        const x = 72 + index * 132;
        const iconY = y + 52 + (128 - size) / 2;
        return `<g transform="translate(${x} ${iconY}) scale(${size / 64})" color="${color}"><use href="#mark" /></g>
      <text x="${x + 64}" y="${y + 210}" text-anchor="middle">${size}px</text>`;
      })
      .join("\n      ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1800 1900" role="img" aria-labelledby="preview-title" data-generated-from="${geometryVersion}">
  <title id="preview-title">ZenX production brand asset contact sheet</title>
  <defs>
    <g id="mark">${markContent}</g>
    <g id="symbol">${symbolContent}</g>
    <g id="wordmark">${wordmarkContent}</g>
    <g id="lockup">${lockupContent}</g>
    <g id="compact-zx" transform="translate(0 14) scale(.43)">${symbolContent}</g>
    <g id="app-icon">
      <path fill="#121419" d="M69 20H187C214 20 236 42 236 69V187C236 214 214 236 187 236H69C42 236 20 214 20 187V69C20 42 42 20 69 20Z" />
      <g color="#F4F4F2" transform="translate(52 52) scale(2.375)"><use href="#mark" /></g>
    </g>
  </defs>
  <style>
    text { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: currentColor }
    .eyebrow { font-size: 18px; letter-spacing: .16em; text-transform: uppercase }
    .label { font-size: 24px; font-weight: 600 }
    .note { font-size: 18px; fill: #8d929d }
    use { fill: currentColor }
  </style>
  <path fill="#0D0E11" d="M0 0H1800V1900H0Z" />
  <text class="label" x="48" y="62" color="#F4F4F2">ZenX production brand system</text>
  <text class="note" x="48" y="94">Flat vector masters · mechanical board-04 contour source · presentation effects intentionally excluded</text>

  <g color="#F4F4F2">
    <path fill="#15171C" d="M40 128H880V400H40Z" />
    <text class="eyebrow" x="72" y="170">Dark background</text>
    <g transform="translate(72 194) scale(1.15)"><use href="#symbol" /></g>
    <g transform="translate(300 206) scale(1.45)"><use href="#wordmark" /></g>
    <g transform="translate(72 306) scale(.92)"><use href="#lockup" /></g>
  </g>
  <g color="#121419">
    <path fill="#F4F4F2" d="M920 128H1760V400H920Z" />
    <text class="eyebrow" x="952" y="170">Light background</text>
    <g transform="translate(952 194) scale(1.15)"><use href="#symbol" /></g>
    <g transform="translate(1180 206) scale(1.45)"><use href="#wordmark" /></g>
    <g transform="translate(952 306) scale(.92)"><use href="#lockup" /></g>
  </g>

  <g color="#F4F4F2">
    <path fill="#15171C" d="M40 432H880V708H40Z" />
    <text class="eyebrow" x="72" y="474">Compact mark · dark</text>
    ${smallRow("#F4F4F2", 458)}
  </g>
  <g color="#121419">
    <path fill="#F4F4F2" d="M920 432H1760V708H920Z" />
    <text class="eyebrow" x="952" y="474">Compact mark · light</text>
    <g transform="translate(880 0)">${smallRow("#121419", 458)}</g>
  </g>

  <g color="#F4F4F2">
    <path fill="#15171C" d="M40 740H880V1324H40Z" />
    <text class="eyebrow" x="72" y="782">512px · dark</text>
    <g transform="translate(204 796) scale(8)"><use href="#mark" /></g>
  </g>
  <g color="#121419">
    <path fill="#F4F4F2" d="M920 740H1760V1324H920Z" />
    <text class="eyebrow" x="952" y="782">512px · light</text>
    <g transform="translate(1084 796) scale(8)"><use href="#mark" /></g>
  </g>

  <path fill="#15171C" d="M40 1356H1760V1860H40Z" />
  <g color="#F4F4F2">
    <text class="eyebrow" x="72" y="1400">macOS application icon</text>
    <g transform="translate(72 1430) scale(1.5)"><use href="#app-icon" /></g>
    <text class="note" x="72" y="1830">80px source safe area · flat near-black tile · warm-white compact mark</text>

    <text class="eyebrow" x="560" y="1400">Compact-mark decision</text>
    <path fill="#20232A" d="M560 1430H940V1778H560Z" />
    <g transform="translate(654 1480) scale(3)"><use href="#mark" /></g>
    <text class="label" x="750" y="1710" text-anchor="middle">A · center-seam mark</text>
    <text class="note" x="750" y="1742" text-anchor="middle">Recommended at 16–32px</text>

    <path fill="#20232A" d="M976 1430H1356V1778H976Z" />
    <g transform="translate(1058 1490) scale(3)"><use href="#compact-zx" /></g>
    <text class="label" x="1166" y="1710" text-anchor="middle">B · compressed ZX</text>
    <text class="note" x="1166" y="1742" text-anchor="middle">Too dense below 32px</text>

    <text class="eyebrow" x="1410" y="1400">Monochrome</text>
    <g transform="translate(1466 1496) scale(3)"><use href="#mark" /></g>
    <text class="note" x="1410" y="1742">One-color silhouette</text>
    <text class="note" x="1410" y="1772">No gradient, glow, filter, or raster</text>
  </g>
</svg>
`;
}
