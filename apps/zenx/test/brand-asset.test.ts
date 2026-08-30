import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const rendererRoot = new URL("../src/renderer/src/", import.meta.url);
const assetRoot = new URL("./assets/brand/", rendererRoot);
const iconRoot = new URL("../resources/icons/", import.meta.url);
const conceptBoard = new URL(
  "../docs/assets/brand/zenx-logo-concept-board.png",
  import.meta.url,
);
const appSource = await readFile(new URL("App.tsx", rendererRoot), "utf8");
const brandSource = await readFile(
  new URL("ZenXBrand.tsx", rendererRoot),
  "utf8",
).catch(() => "");
const stylesSource = await readFile(
  new URL("styles.css", rendererRoot),
  "utf8",
);

const canonicalAssets = [
  ["zenx-mark.svg", "0 0 64 64"],
  ["zenx-symbol.svg", "0 0 148 64"],
  ["zenx-wordmark.svg", "0 0 300 64"],
  ["zenx-lockup.svg", "0 0 480 96"],
] as const;

test("ZenX branding uses the production assets through the replaceable component seam", async () => {
  assert.match(appSource, /import \{ ZenXBrand \}/u);
  assert.match(appSource, /<ZenXBrand \/>/u);

  assert.match(brandSource, /assets\/brand\/zenx-mark\.svg/u);
  assert.match(brandSource, /assets\/brand\/zenx-wordmark\.svg/u);
  assert.doesNotMatch(brandSource, /placeholder/u);
  assert.doesNotMatch(brandSource, /<svg|<path|\sd=/u);
  assert.match(stylesSource, /mask-image:\s*var\(--zenx-brand-asset\)/u);

  await assert.rejects(
    access(new URL("assets/zenx-logo-placeholder.svg", rendererRoot)),
  );
});

test("canonical ZenX SVGs are path-only, monochrome, accessible vector assets", async () => {
  for (const [name, viewBox] of canonicalAssets) {
    const source = await readFile(new URL(name, assetRoot), "utf8");
    assert.match(source, new RegExp(`viewBox="${viewBox}"`, "u"), name);
    assert.match(source, /role="img"/u, name);
    assert.match(source, /<title id=/u, name);
    assert.match(source, /fill="currentColor"/u, name);
    assert.match(source, /<path\b/u, name);
    assert.doesNotMatch(
      source,
      /<(?:image|text|filter|linearGradient|radialGradient)\b|\bhref=|\burl\(|\bdata:/u,
      name,
    );
    assert.match(source, /data-geometry="zenx-board04-mechanical-v1"/u, name);
  }

  const wordmark = await readFile(
    new URL("zenx-wordmark.svg", assetRoot),
    "utf8",
  );
  assert.equal((wordmark.match(/<path\b/gu) ?? []).length, 4);

  const mark = await readFile(new URL("zenx-mark.svg", assetRoot), "utf8");
  const symbol = await readFile(new URL("zenx-symbol.svg", assetRoot), "utf8");
  const markComponents = [...mark.matchAll(/<path d="([^"]+)"/gu)].map(
    (match) => match[1],
  );
  const symbolComponents = [...symbol.matchAll(/<path d="([^"]+)"/gu)].map(
    (match) => match[1],
  );
  assert.equal(markComponents.length, 2);
  assert.equal(symbolComponents.length, 4);
  assert.deepEqual(symbolComponents.slice(2), markComponents);
  assert.equal(new Set(markComponents).size, 2);
});

test("the mechanically traced X keeps two separate component paths", async () => {
  const mark = await readFile(new URL("zenx-mark.svg", assetRoot), "utf8");
  const paths = [...mark.matchAll(/<path d="([^"]+)" transform="([^"]+)"/gu)];
  assert.equal(paths.length, 2);
  assert.ok(
    paths.every(([, , transform]) => transform === "translate(0 5) scale(.29)"),
  );
  assert.ok(paths.every(([d]) => d.includes("C")));
});

test("the mechanically traced Z keeps two separate component paths", async () => {
  const symbol = await readFile(new URL("zenx-symbol.svg", assetRoot), "utf8");
  const paths = [
    ...symbol.matchAll(/<path d="([^"]+)" transform="([^"]+)"\s*\/>/gu),
  ].slice(0, 2);
  assert.equal(paths.length, 2);
  assert.ok(paths.every(([, , transform]) => transform === "scale(.32)"));
  assert.ok(paths.every(([d]) => d.includes("C")));
});

test("the checked-in macOS icon is a complete ICNS generated from the flat SVG source", async () => {
  const iconSource = await readFile(
    new URL("zenx-app-icon.svg", iconRoot),
    "utf8",
  );
  assert.match(iconSource, /viewBox="0 0 1024 1024"/u);
  assert.match(iconSource, /data-safe-area="80 80 864 864"/u);
  assert.match(iconSource, /data-geometry="zenx-board04-mechanical-v1"/u);
  assert.doesNotMatch(
    iconSource,
    /<(?:image|text|filter|linearGradient|radialGradient)\b|\bhref=|\burl\(|\bdata:/u,
  );

  const icon = await readFile(new URL("zenx.icns", iconRoot));
  assert.equal(icon.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icon.readUInt32BE(4), icon.length);
  for (const type of [
    "ic04",
    "ic05",
    "ic11",
    "ic12",
    "ic07",
    "ic13",
    "ic08",
    "ic14",
    "ic09",
    "ic10",
  ]) {
    assert.notEqual(icon.indexOf(Buffer.from(type, "ascii")), -1, type);
  }
});

test("the checked-in Windows icon is a complete multi-resolution ICO", async () => {
  const icon = await readFile(new URL("zenx.ico", iconRoot));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  const count = icon.readUInt16LE(4);
  assert.equal(count, 7);

  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = icon[entry] === 0 ? 256 : icon[entry];
    const height = icon[entry + 1] === 0 ? 256 : icon[entry + 1];
    assert.equal(height, width);
    assert.equal(icon[entry + 2], 0);
    assert.equal(icon[entry + 3], 0);
    assert.equal(icon.readUInt16LE(entry + 4), 1);
    assert.equal(icon.readUInt16LE(entry + 6), 32);
    const length = icon.readUInt32LE(entry + 8);
    const offset = icon.readUInt32LE(entry + 12);
    const png = icon.subarray(offset, offset + length);
    assert.deepEqual(
      png.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
    sizes.push(width);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
});

test("the user-created logo concept board remains byte-identical", async () => {
  const digest = createHash("sha256")
    .update(await readFile(conceptBoard))
    .digest("hex");
  assert.equal(
    digest,
    "ca1b2432a06da1142d7b223f24f0ead9264e2cd7a772a1800c19b0862c2dce63",
  );
});
