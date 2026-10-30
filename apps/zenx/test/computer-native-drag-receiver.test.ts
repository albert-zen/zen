import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Compilation only. The owned receiver supports an explicitly authorized native
// desktop trial; this test never launches it or posts events to an OS desktop.
test(
  "owned native drag receiver fixture compiles without running desktop input",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  (t) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "zenx-drag-receiver-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const result = spawnSync(
      "/usr/bin/swiftc",
      [
        fileURLToPath(
          new URL(
            "../evals/browser-computer/macos-native-fixture.swift",
            import.meta.url,
          ),
        ),
        "-o",
        path.join(directory, "receiver"),
      ],
      { encoding: "utf8", timeout: 45_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  },
);
