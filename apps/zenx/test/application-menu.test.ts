import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const menuSource = new URL("../src/main/application-menu.ts", import.meta.url);

test("macOS application menu exposes Electron-native page zoom roles", async () => {
  const source = await readFile(menuSource, "utf8");

  for (const [role, accelerator] of [
    ["resetZoom", "CommandOrControl+0"],
    ["zoomIn", "CommandOrControl+Plus"],
    ["zoomOut", "CommandOrControl+-"],
  ]) {
    const entry = source.match(
      new RegExp(`\\{[^{}]*role: "${role}"[^{}]*\\}`, "su"),
    )?.[0];
    assert.ok(entry, `${role} remains an Electron native role`);
    assert.ok(entry.includes(`accelerator: "${accelerator}"`));
  }
});

test("non-macOS application menu policy remains absent", async () => {
  const source = await readFile(menuSource, "utf8");

  assert.match(
    source,
    /if \(platform !== "darwin"\) \{\s*Menu\.setApplicationMenu\(null\);\s*return;\s*\}/su,
  );
});
