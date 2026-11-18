import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const theme = await readFile(
  new URL("../src/renderer/src/theme.css", import.meta.url),
  "utf8",
);

function declarations(block) {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

function preset(mode) {
  const block = theme.match(
    new RegExp(`@media \\(min-width: 961px\\) \\{([\\s\\S]*?)\\n\\}\\n`, "u"),
  )?.[1];
  assert.ok(
    block,
    "the desktop change must stay behind the existing breakpoint",
  );
  assert.deepEqual(
    [...block.matchAll(/data-theme-preset="([^"]+)"/gu)].map((m) => m[1]),
    ["graphite", "graphite"],
    "optional palettes must not inherit this desktop override",
  );
  const body = block.match(
    new RegExp(
      `:root\\[data-appearance="${mode}"\\]\\[data-theme-preset="graphite"\\] \\{([^}]+)\\}`,
      "u",
    ),
  )?.[1];
  assert.ok(body);
  return declarations(body);
}

test("desktop Graphite changes only the three shell backgrounds", () => {
  assert.deepEqual(preset("light"), {
    "--color-canvas": "#f9fafb",
    "--color-surface-sidebar": "#f9fafb",
    "--color-surface-main": "#ffffff",
  });
  assert.deepEqual(preset("dark"), {
    "--color-canvas": "#000000",
    "--color-surface-sidebar": "#000000",
    "--color-surface-main": "#000000",
  });
});

function luminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../gu)
    .map((channel) => {
      const v = parseInt(channel, 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test("existing primary, secondary and muted text retain readable shell contrast", () => {
  for (const mode of ["light", "dark"]) {
    const root =
      mode === "dark"
        ? theme.match(/:root \{([^}]+)\}/u)?.[1]
        : theme.match(/:root\[data-appearance="light"\] \{([^}]+)\}/u)?.[1];
    assert.ok(root);
    const tokens = declarations(root);
    for (const role of ["primary", "secondary", "muted"]) {
      const text = luminance(tokens[`--color-text-${role}`]);
      for (const [surface, hex] of Object.entries(preset(mode))) {
        const background = luminance(hex);
        const ratio =
          (Math.max(text, background) + 0.05) /
          (Math.min(text, background) + 0.05);
        assert.ok(ratio >= 4.5, `${mode} ${role} on ${surface}: ${ratio}`);
      }
    }
  }
});
