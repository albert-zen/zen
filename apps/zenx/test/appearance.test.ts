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

test("light and dark semantic text, actions, boundaries, and focus meet contrast targets", async () => {
  const theme = await readFile(
    new URL("../src/renderer/src/theme.css", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const darkTokens = theme.match(/:root\s*\{([\s\S]*?)\n\}/u)?.[1];
  const lightTokens = theme.match(
    /:root\[data-appearance="light"\]\s*\{([\s\S]*?)\n\}/u,
  )?.[1];
  assert.ok(darkTokens);
  assert.ok(lightTokens);
  const token = (tokens: string, name: string) => {
    const value = tokens.match(
      new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu"),
    )?.[1];
    assert.ok(value, `missing --${name}`);
    return value;
  };

  for (const [name, tokens] of [
    ["dark", darkTokens],
    ["light", lightTokens],
  ] as const) {
    for (const surface of [
      "color-surface-inset",
      "color-surface-sidebar",
      "color-surface-main",
      "color-surface",
      "color-surface-hover",
    ]) {
      assert.ok(
        contrastRatio(
          token(tokens, "color-text-muted"),
          token(tokens, surface),
        ) >= 4.5,
        `${name} muted text must meet 4.5:1 against --${surface}`,
      );
    }
    assert.ok(
      contrastRatio(
        token(tokens, "color-text-on-accent"),
        token(tokens, "color-accent"),
      ) >= 4.5,
      `${name} primary action text must meet 4.5:1`,
    );
    assert.ok(
      contrastRatio(
        token(tokens, "color-border-control"),
        token(tokens, "color-surface-inset"),
      ) >= 3,
      `${name} control boundaries must meet 3:1`,
    );
    assert.ok(
      contrastRatio(
        token(tokens, "color-border-accent"),
        token(tokens, "color-surface-inset"),
      ) >= 3,
      `${name} selected boundaries must meet 3:1`,
    );
    for (const surface of ["color-surface", "color-surface-main"]) {
      assert.ok(
        contrastRatio(
          token(tokens, "color-focus-ring"),
          token(tokens, surface),
        ) >= 3,
        `${name} focus ring must meet 3:1 against --${surface}`,
      );
    }
  }
  assert.match(
    styles,
    /\.primary-button\s*\{[^}]*color:\s*var\(--color-text-on-accent\)/u,
  );
  assert.match(
    styles,
    /button:focus-visible,[\s\S]*?outline:\s*2px solid var\(--color-focus-ring\)/u,
  );
  assert.match(
    styles,
    /\.composer:focus-within\s*\{[^}]*border-color:\s*var\(--color-border-focus\);[^}]*outline:\s*2px solid var\(--color-focus-ring\);[^}]*outline-offset:\s*1px;[^}]*box-shadow:[^}]*var\(--color-shadow-low\)/u,
  );
  assert.match(
    styles,
    /\.composer > textarea::placeholder\s*\{[^}]*color:\s*var\(--color-text-muted\)[^}]*opacity:\s*1/u,
  );
  assert.match(
    styles,
    /\.field small\s*\{[^}]*color:\s*var\(--color-text-muted\)/u,
  );
  assert.match(
    styles,
    /\.thread-row\.selected\s*\{[^}]*background:\s*var\(--color-surface-hover\)/u,
  );
  assert.match(
    styles,
    /\.thread-project,\s*\.model-line\s*\{[^}]*color:\s*var\(--color-text-muted\)/u,
  );
  assert.doesNotMatch(
    styles,
    /\.thread-row\.system-error\s*\{[^}]*opacity:/u,
    "system-error must not fade the entire Thread row",
  );
  for (const [name, tokens] of [
    ["dark", darkTokens],
    ["light", lightTokens],
  ] as const) {
    for (const surface of ["sidebar", "surface-hover"]) {
      assert.ok(
        effectiveContrastRatio(
          token(tokens, "color-text-muted"),
          token(
            tokens,
            surface === "sidebar"
              ? "color-surface-sidebar"
              : "color-surface-hover",
          ),
          1,
        ) >= 4.5,
        `${name} unavailable Thread metadata must remain readable over --${surface}`,
      );
    }
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
