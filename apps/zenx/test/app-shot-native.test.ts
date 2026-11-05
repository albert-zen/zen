import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAC_ACTIVE_WINDOW_JXA,
  MAC_WINDOW_METADATA_JXA,
  readMacActiveWindow,
  readMacWindowMetadata,
} from "../src/main/app-shot-native.js";

describe("read-only Mac foreground metadata", () => {
  it("uses a bounded official OS command without input or permissions", async () => {
    const window = await readMacActiveWindow(async (file, args, options) => {
      assert.equal(file, "/usr/bin/osascript");
      assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
      assert.equal(args[3], MAC_ACTIVE_WINDOW_JXA);
      assert.equal(options.timeout, 2000);
      assert.equal(options.maxBuffer, 4096);
      assert.doesNotMatch(
        MAC_ACTIVE_WINDOW_JXA,
        /performAction|postEvent|setValue|System Events/,
      );
      return {
        stdout: JSON.stringify({
          windowId: 32,
          windowTitle: "Draft",
          pid: 123,
          applicationName: "Editor",
        }),
      };
    });
    assert.deepEqual(window, {
      windowId: 32,
      windowTitle: "Draft",
      pid: 123,
      applicationName: "Editor",
    });
  });

  it("rejects absent or malformed identity and hides OS command failures", async () => {
    await assert.rejects(
      readMacActiveWindow(async () => {
        throw new Error("private process detail");
      }),
      /choose a window instead/,
    );
    await assert.rejects(
      readMacActiveWindow(async () => ({ stdout: "{}" })),
      /exact identity/,
    );
    await assert.rejects(
      readMacActiveWindow(async () => ({ stdout: "not JSON" })),
      /invalid metadata/,
    );
  });
  it("looks up exact selected CG window metadata with bounded command output", async () => {
    const metadata = await readMacWindowMetadata(
      42,
      async (_file, args, options) => {
        assert.match(args[3] ?? "", /const wanted = 42/);
        assert.equal(options.timeout, 2000);
        assert.equal(options.maxBuffer, 4096);
        assert.match(MAC_WINDOW_METADATA_JXA, /CFArrayGetCount/);
        return {
          stdout: JSON.stringify({
            windowId: 42,
            windowTitle: "Report",
            pid: 777,
            applicationName: "Writer",
          }),
        };
      },
    );
    assert.equal(metadata.applicationName, "Writer");
    await assert.rejects(
      readMacWindowMetadata(42, async () => ({
        stdout: JSON.stringify({
          windowId: 43,
          windowTitle: "Wrong",
          pid: 777,
        }),
      })),
      /does not match/,
    );
    await assert.rejects(
      readMacWindowMetadata(NaN),
      /Invalid App Shot window identity/,
    );
  });
});
