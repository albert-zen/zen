import { describe, expect, it } from "vitest";

describe("kernel public entry point", () => {
  it("loads through the source entry point", async () => {
    const kernel = await import("../src/kernel/index.js");

    expect(kernel.kernelEntrypoint).toBe("zen-kernel");
    expect("ThreadManager" in kernel).toBe(false);
    expect("ApprovalBroker" in kernel).toBe(false);
    expect("PolicyToolRuntime" in kernel).toBe(false);
    expect("createWebUiState" in kernel).toBe(false);
  });
});
