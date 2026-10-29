/// <reference path="../../src/renderer/src/env.d.ts" />
import type { ThreadTitleSnapshot } from "../../src/main/thread-title-types.js";

/** Synthetic title storage only; observing input never invokes a title model. */
export function createUiPolishTitleBridge(): typeof window.zenx.titles {
  const titles: ThreadTitleSnapshot = {};
  let version = 0;
  return {
    get: async () => ({ ...titles }),
    observe: async (threadId) => titles[threadId],
    rename: async (threadId, title) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const projection = {
        threadId,
        title,
        status: "manual" as const,
        source: "user" as const,
        version: ++version,
      };
      titles[threadId] = projection;
      return projection;
    },
    retry: async () => {
      throw new Error("Synthetic preview does not run title generation.");
    },
    onChange: () => () => undefined,
  };
}
