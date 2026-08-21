import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  APPEARANCE_STORAGE_KEY,
  applyResolvedAppearance,
  createAppearanceController,
  readAppearancePreference,
  resolveAppearance,
} from "../src/renderer/src/appearance.js";

test("resolves explicit and system appearance preferences", () => {
  assert.equal(resolveAppearance("light", true), "light");
  assert.equal(resolveAppearance("dark", false), "dark");
  assert.equal(resolveAppearance("system", true), "dark");
  assert.equal(resolveAppearance("system", false), "light");
  assert.equal(readAppearancePreference(storageWith("unexpected")), "system");
});

test("applies the root attribute, CSS color-scheme, and native-control meta", () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="color-scheme" content="dark light"></head></html>',
  );
  applyResolvedAppearance(dom.window.document, "light");
  assert.equal(dom.window.document.documentElement.dataset.appearance, "light");
  assert.equal(dom.window.document.documentElement.style.colorScheme, "light");
  assert.equal(
    dom.window.document
      .querySelector('meta[name="color-scheme"]')
      ?.getAttribute("content"),
    "light",
  );
  dom.window.close();
});

test("persists switches and follows live system changes only in System", () => {
  const dom = new JSDOM("<!doctype html><html></html>");
  const storage = storageWith("system");
  const system = new FakeSystemPreference(false);
  const controller = createAppearanceController({
    document: dom.window.document,
    storage,
    systemPreference: system,
  });
  assert.equal(dom.window.document.documentElement.dataset.appearance, "light");

  system.setDark(true);
  assert.equal(dom.window.document.documentElement.dataset.appearance, "dark");

  controller.setPreference("light");
  assert.equal(storage.getItem(APPEARANCE_STORAGE_KEY), "light");
  assert.equal(dom.window.document.documentElement.dataset.appearance, "light");
  system.setDark(false);
  system.setDark(true);
  assert.equal(dom.window.document.documentElement.dataset.appearance, "light");

  controller.setPreference("system");
  assert.equal(dom.window.document.documentElement.dataset.appearance, "dark");
  controller.dispose();
  system.setDark(false);
  assert.equal(dom.window.document.documentElement.dataset.appearance, "dark");
  dom.window.close();
});

test("light semantic text, primary actions, and control boundaries meet contrast targets", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const lightTokens = css.match(
    /:root\[data-appearance="light"\]\s*\{([\s\S]*?)\n\}/u,
  )?.[1];
  assert.ok(lightTokens);
  const token = (name: string) => {
    const value = lightTokens.match(
      new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu"),
    )?.[1];
    assert.ok(value, `missing light --${name}`);
    return value;
  };

  for (const surface of ["surface-inset", "sidebar", "main", "surface"]) {
    assert.ok(
      contrastRatio(token("text-3"), token(surface)) >= 4.5,
      `--text-3 must meet 4.5:1 against --${surface}`,
    );
  }
  assert.ok(
    contrastRatio(token("text-3"), token("surface-hover")) >= 4.5,
    "selected Thread metadata must meet 4.5:1",
  );
  assert.ok(
    contrastRatio(token("text-on-accent"), token("accent")) >= 4.5,
    "primary action text must meet 4.5:1",
  );
  assert.ok(
    contrastRatio(token("border-control"), token("surface-inset")) >= 3,
    "control boundaries must meet 3:1",
  );
  assert.ok(
    contrastRatio(token("border-accent"), token("surface-inset")) >= 3,
    "selected control boundaries must meet 3:1",
  );
  assert.match(
    css,
    /\.primary-button\s*\{[^}]*color:\s*var\(--text-on-accent\)/u,
  );
  assert.match(
    css,
    /\.appearance-options label > span\s*\{[^}]*border:\s*1px solid var\(--border-control\)/u,
  );
  assert.match(
    css,
    /\.composer > textarea::placeholder\s*\{[^}]*color:\s*var\(--text-3\)[^}]*opacity:\s*1/u,
  );
  assert.match(css, /\.field small\s*\{[^}]*color:\s*var\(--text-3\)/u);
  assert.match(
    css,
    /\.thread-row\.selected\s*\{[^}]*background:\s*var\(--surface-hover\)/u,
  );
  assert.match(
    css,
    /\.thread-project,\s*\.model-line\s*\{[^}]*color:\s*var\(--text-3\)/u,
  );
  for (const selector of ["thread-menu-rename", "thread-title-form"]) {
    const inputRule = css.match(
      new RegExp(`\\.${selector} input\\s*\\{([^}]*)\\}`, "u"),
    )?.[1];
    assert.ok(inputRule, `missing .${selector} input rule`);
    assert.match(inputRule, /border:\s*1px solid var\(--border-control\)/u);
    assert.match(inputRule, /background:\s*var\(--surface-inset\)/u);
  }

  const lightOpacity = (selector: string) => {
    const value = css.match(
      new RegExp(
        `:root\\[data-appearance="light"\\] \\.${selector}\\s*\\{[^}]*opacity:\\s*([0-9.]+)`,
        "u",
      ),
    )?.[1];
    assert.ok(value, `missing Light opacity override for .${selector}`);
    return Number(value);
  };
  const unavailableThreadOpacity = lightOpacity("thread-row\\.system-error");
  assert.equal(unavailableThreadOpacity, 1);
  for (const surface of ["sidebar", "surface-hover"]) {
    assert.ok(
      effectiveContrastRatio(
        token("text-3"),
        token(surface),
        unavailableThreadOpacity,
      ) >= 4.5,
      `unavailable Thread metadata must remain readable over --${surface}`,
    );
  }
});

class FakeSystemPreference {
  matches: boolean;
  readonly #listeners = new Set<() => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(_type: "change", listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: () => void): void {
    this.#listeners.delete(listener);
  }

  setDark(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.#listeners) listener();
  }
}

function storageWith(initial?: string): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(APPEARANCE_STORAGE_KEY, initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function effectiveContrastRatio(
  foreground: string,
  background: string,
  opacity: number,
): number {
  return contrastRatio(
    compositeHex(foreground, background, opacity),
    background,
  );
}

function compositeHex(
  foreground: string,
  background: string,
  opacity: number,
): string {
  const foregroundChannels = hexChannels(foreground);
  const backgroundChannels = hexChannels(background);
  return `#${foregroundChannels
    .map((channel, index) =>
      Math.round(
        channel * opacity + (backgroundChannels[index] ?? 0) * (1 - opacity),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function hexChannels(hex: string): number[] {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
}

function relativeLuminance(hex: string): number {
  const channels = hexChannels(hex);
  const [red = 0, green = 0, blue = 0] = channels.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
