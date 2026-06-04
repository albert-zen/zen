import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadSnapshot } from "../src/app-server-protocol.js";

describe("FileThreadStore atomic replacement", () => {
  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  it("keeps the previous snapshot readable when fallback replacement fails", async () => {
    const actualFs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises"
      );
    const rename = vi.fn(actualFs.rename);

    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      rename
    }));

    const { FileThreadStore } = await import("../src/thread-store.js");
    const dir = mkdtempSync(join(tmpdir(), "zen-threads-atomic-"));
    const store = new FileThreadStore({ dir });

    await store.save(threadSnapshot("thread-1", "before"));

    rename
      .mockRejectedValueOnce(withCode("EPERM", "rename-over-existing failed"))
      .mockRejectedValueOnce(withCode("EACCES", "final replacement failed"));

    await expect(
      store.save(threadSnapshot("thread-1", "after"))
    ).rejects.toThrow("final replacement failed");
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        items: [
          expect.objectContaining({
            id: "item-before",
            payload: { content: "before" }
          })
        ]
      })
    ]);
  });
});

function threadSnapshot(id: string, content: string): ThreadSnapshot {
  return {
    id,
    status: "idle",
    turns: [],
    items: [
      {
        id: `item-${content}`,
        type: "user.message",
        createdAtMs: content === "before" ? 1000 : 2000,
        seq: 1,
        runId: "run-1",
        turnId: "turn-1",
        payload: { content }
      }
    ]
  };
}

function withCode(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
