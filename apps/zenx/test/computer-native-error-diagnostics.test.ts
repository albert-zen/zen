import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAC_BOUND_TARGET_SOURCE,
  runProcess,
} from "../src/main/capabilities/computer-provider.js";

test(
  "native target error keeps bounded stage/domain/code without private NSError content",
  { skip: process.platform !== "darwin", timeout: 90_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-native-error-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, "helper.swift"),
      binary = path.join(directory, "helper");
    await writeFile(source, MAC_BOUND_TARGET_SOURCE);
    await runProcess(
      "/usr/bin/swiftc",
      [
        "-O",
        "-target",
        `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos12.0`,
        source,
        "-o",
        binary,
      ],
      60_000,
    );
    // Invalid JSON fails before target lookup/TCC or any capture/input API.
    const output = await runProcess(
      binary,
      [],
      10_000,
      '{"private":"fixture_private_content", invalid}',
    );
    const response = JSON.parse(output) as { error: string };
    assert.match(response.error, /request-decode/);
    assert.match(
      response.error,
      /NSError domain=NSCocoaErrorDomain, code=3840/,
    );
    assert.match(response.error, /no input dispatched/);
    assert.equal(response.error.length < 256, true);
    assert.doesNotMatch(
      response.error,
      /fixture_private_content|NSDebugDescription|userInfo|localizedDescription/,
    );
  },
);
