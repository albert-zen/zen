/** CI-only adapter to the same owned native input path as Computer acceptance. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";
import {
  MAC_BOUND_TARGET_SOURCE,
  runProcess,
} from "../src/main/capabilities/computer-provider.js";
import { NativeComputerTargetTransport } from "../src/main/capabilities/computer-target-transport.js";
export async function prepareOwnedSidebarInput(directory: string) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.platform, "darwin");
  const executable = path.join(directory, "owned-sidebar-computer");
  await writeFile(executable + ".swift", MAC_BOUND_TARGET_SOURCE);
  await runProcess(
    "/usr/bin/swiftc",
    ["-O", executable + ".swift", "-o", executable],
    60_000,
  );
  const transport = new NativeComputerTargetTransport(async () => executable);
  return {
    close: () => transport.close(),
    async click(window: BrowserWindow, point: { x: number; y: number }) {
      assert.ok(
        !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
      );
      const content = window.getContentBounds();
      assert.ok(
        point.x >= 0 &&
          point.x < content.width &&
          point.y >= 0 &&
          point.y < content.height,
      );
      const owner = "synthetic-owned-sidebar";
      const selected = (await transport.request(
        {
          operation: "select",
          owner,
          target: { pid: process.pid, windowTitle: window.getTitle() },
        },
        AbortSignal.timeout(10_000),
      )) as { bindingId: string; windowId: number; target: { pid: number } };
      assert.equal(selected.target.pid, process.pid);
      const posted = await transport.request(
        {
          operation: "click",
          owner,
          bindingId: selected.bindingId,
          x: content.x + point.x,
          y: content.y + point.y,
          button: "left",
        },
        AbortSignal.timeout(10_000),
      );
      const verified = (await transport.request(
        { operation: "verify", owner, bindingId: selected.bindingId },
        AbortSignal.timeout(10_000),
      )) as { windowId: number };
      assert.equal(verified.windowId, selected.windowId);
      return { pid: selected.target.pid, windowId: selected.windowId, posted };
    },
  };
}
