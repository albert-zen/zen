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
  type ResolvedAppearance,
} from "../src/renderer/src/appearance.js";

const desiredPreference = {
  mode: "system",
  lightPreset: "cobalt",
  darkPreset: "ember",
  accent: "jade",
  contrast: "high",
  translucentSidebar: true,
} as const;

const defaultPreference = {
  mode: "system",
  lightPreset: "graphite",
  darkPreset: "graphite",
  accent: "azure",
  contrast: "standard",
  translucentSidebar: false,
} as const;

test("resolves explicit and system appearance preferences", () => {
  assert.equal(
    resolveAppearance({ ...defaultPreference, mode: "light" }, true).mode,
    "light",
  );
  assert.equal(
    resolveAppearance({ ...defaultPreference, mode: "dark" }, false).mode,
    "dark",
  );
  assert.equal(resolveAppearance(defaultPreference, true).mode, "dark");
  assert.equal(resolveAppearance(defaultPreference, false).mode, "light");
  assert.deepEqual(
    readAppearancePreference(storageWith("unexpected")),
    defaultPreference,
  );
});

test("reads the versioned Appearance v1 profile and preserves legacy mode values", () => {
  assert.deepEqual(
    readAppearancePreference(storageWith(JSON.stringify(desiredPreference))),
    desiredPreference,
  );
  assert.deepEqual(readAppearancePreference(storageWith("light")), {
    mode: "light",
    lightPreset: "graphite",
    darkPreset: "graphite",
    accent: "azure",
    contrast: "standard",
    translucentSidebar: false,
  });
  assert.deepEqual(readAppearancePreference(storageWith("unexpected")), {
    mode: "system",
    lightPreset: "graphite",
    darkPreset: "graphite",
    accent: "azure",
    contrast: "standard",
    translucentSidebar: false,
  });
});

test("applies the root attribute, CSS color-scheme, and native-control meta", () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="color-scheme" content="dark light"></head></html>',
  );
  applyResolvedAppearance(dom.window.document, {
    mode: "light",
    preset: "graphite",
    accent: "azure",
    contrast: "standard",
    translucentSidebar: false,
  } as unknown as ResolvedAppearance);
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

test("applies the resolved preset, accent, contrast, and sidebar material before components render", () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="color-scheme" content="dark light"></head></html>',
  );
  applyResolvedAppearance(dom.window.document, {
    mode: "dark",
    preset: "ember",
    accent: "jade",
    contrast: "high",
    translucentSidebar: true,
  } as unknown as ResolvedAppearance);
  const root = dom.window.document.documentElement;
  assert.equal(root.dataset.appearance, "dark");
  assert.equal(root.dataset.themePreset, "ember");
  assert.equal(root.dataset.accent, "jade");
  assert.equal(root.dataset.contrast, "high");
  assert.equal(root.dataset.sidebarTranslucency, "on");
  assert.equal(root.style.colorScheme, "dark");
  dom.window.close();
});

test("resolves the independently saved Light and Dark presets", () => {
  assert.deepEqual(resolveAppearance(desiredPreference, false), {
    mode: "light",
    preset: "cobalt",
    accent: "jade",
    contrast: "high",
    translucentSidebar: true,
  });
  assert.deepEqual(resolveAppearance(desiredPreference, true), {
    mode: "dark",
    preset: "ember",
    accent: "jade",
    contrast: "high",
    translucentSidebar: true,
  });
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

  controller.setPreference({ ...defaultPreference, mode: "light" });
  assert.equal(
    storage.getItem(APPEARANCE_STORAGE_KEY),
    JSON.stringify({ ...defaultPreference, mode: "light" }),
  );
  assert.equal(dom.window.document.documentElement.dataset.appearance, "light");
  system.setDark(false);
  system.setDark(true);
  assert.equal(dom.window.document.documentElement.dataset.appearance, "light");

  controller.setPreference(defaultPreference);
  assert.equal(dom.window.document.documentElement.dataset.appearance, "dark");
  controller.dispose();
  system.setDark(false);
  assert.equal(dom.window.document.documentElement.dataset.appearance, "dark");
  dom.window.close();
});

test("persists one complete Appearance v1 profile and reapplies it on controller creation", () => {
  const firstDom = new JSDOM("<!doctype html><html></html>");
  const storage = storageWith("system");
  const system = new FakeSystemPreference(true);
  const first = createAppearanceController({
    document: firstDom.window.document,
    storage,
    systemPreference: system,
  });
  first.setPreference(desiredPreference);
  assert.equal(
    storage.getItem(APPEARANCE_STORAGE_KEY),
    JSON.stringify(desiredPreference),
  );
  assert.equal(
    firstDom.window.document.documentElement.dataset.themePreset,
    "ember",
  );
  first.dispose();
  firstDom.window.close();

  const secondDom = new JSDOM("<!doctype html><html></html>");
  const second = createAppearanceController({
    document: secondDom.window.document,
    storage,
    systemPreference: new FakeSystemPreference(false),
  });
  assert.deepEqual(second.getPreference(), desiredPreference);
  assert.equal(
    secondDom.window.document.documentElement.dataset.appearance,
    "light",
  );
  assert.equal(
    secondDom.window.document.documentElement.dataset.themePreset,
    "cobalt",
  );
  second.dispose();
  secondDom.window.close();
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

test("every preset, accent, and contrast combination preserves readable semantic states", async () => {
  const theme = await readFile(
    new URL("../src/renderer/src/theme.css", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM("<!doctype html><html><head></head></html>");
  const style = dom.window.document.createElement("style");
  style.textContent = theme;
  dom.window.document.head.append(style);
  const root = dom.window.document.documentElement;

  for (const mode of ["light", "dark"] as const) {
    root.dataset.appearance = mode;
    for (const preset of ["graphite", "cobalt", "ember"] as const) {
      root.dataset.themePreset = preset;
      for (const accent of ["azure", "iris", "jade"] as const) {
        root.dataset.accent = accent;
        for (const contrast of ["standard", "high"] as const) {
          root.dataset.contrast = contrast;
          const computed = dom.window.getComputedStyle(root);
          const value = (tokenName: string) => {
            const tokenValue = computed.getPropertyValue(tokenName).trim();
            assert.match(tokenValue, /^#[0-9a-f]{6}$/iu, tokenName);
            return tokenValue;
          };
          const state = `${mode}/${preset}/${accent}/${contrast}`;
          for (const surface of [
            "--color-surface-sidebar",
            "--color-surface-main",
            "--color-surface",
          ]) {
            assert.ok(
              contrastRatio(value("--color-text-muted"), value(surface)) >= 4.5,
              `${state} muted text must meet 4.5:1 on ${surface}`,
            );
          }
          assert.ok(
            contrastRatio(
              value("--color-text-on-accent"),
              value("--color-accent"),
            ) >= 4.5,
            `${state} accent text must meet 4.5:1`,
          );
          assert.ok(
            contrastRatio(
              value("--color-border-control"),
              value("--color-surface-inset"),
            ) >= 3,
            `${state} control boundary must meet 3:1`,
          );
          assert.ok(
            contrastRatio(
              value("--color-focus-ring"),
              value("--color-surface"),
            ) >= 3,
            `${state} focus ring must meet 3:1`,
          );
        }
      }
    }
  }
  dom.window.close();
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
