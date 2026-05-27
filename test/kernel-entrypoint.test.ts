import { describe, expect, it } from "vitest";

describe("kernel public entry point", () => {
  it("loads through the source entry point", async () => {
    const kernel = await import("../src/index.js");

    expect(kernel.kernelEntrypoint).toBe("zen-kernel");
  });
});
