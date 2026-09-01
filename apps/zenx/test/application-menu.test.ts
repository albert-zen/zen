import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const menuSource = new URL("../src/main/application-menu.ts", import.meta.url);

test("macOS application menu exposes Electron-native page zoom roles", async () => {
  const source = await readFile(menuSource, "utf8");

  assert.match(
    source,
    /label: "View",\s*submenu: \[\s*\{ role: "resetZoom", accelerator: "CommandOrControl\+0" \},\s*\{ role: "zoomIn", accelerator: "CommandOrControl\+Plus" \},\s*\{ role: "zoomOut", accelerator: "CommandOrControl\+-" \},\s*\],/su,
  );
});

test("non-macOS application menu policy remains absent", async () => {
  const source = await readFile(menuSource, "utf8");

  assert.match(
    source,
    /if \(platform !== "darwin"\) \{\s*Menu\.setApplicationMenu\(null\);\s*return;\s*\}/su,
  );
});
