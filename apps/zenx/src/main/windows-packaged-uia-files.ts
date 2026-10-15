import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describeWindowsFixtureTextMismatch } from "./windows-packaged-uia-evidence.js";

export async function waitForFile(
  directory: string,
  name: string,
  signal: AbortSignal,
  fixtures: { assertRunning(): void; diagnostic(): string }[],
  deadline = Date.now() + 20_000,
): Promise<string> {
  while (true) {
    signal.throwIfAborted();
    fixtures.forEach((fixture) => fixture.assertRunning());
    try {
      return await fs.readFile(path.join(directory, name), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // File.Replace can briefly hold this owned Windows fixture file busy.
      // Retry observation only, within the same deadline; never replay UIA.
      if (code !== "ENOENT" && code !== "EBUSY") throw error;
    }
    assert.ok(
      Date.now() < deadline,
      `Native fixture did not produce ${name}: ${fixtures.map((fixture) => fixture.diagnostic()).join("\n")}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function waitForText(
  directory: string,
  name: string,
  expected: string,
  signal: AbortSignal,
  fixtures: { assertRunning(): void; diagnostic(): string }[],
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (true) {
    const value = await waitForFile(
      directory,
      name,
      signal,
      fixtures,
      deadline,
    );
    if (value === expected) return;
    assert.ok(
      Date.now() < deadline,
      `Native ${name} effect did not match complete expected text: ${JSON.stringify(describeWindowsFixtureTextMismatch(value, expected))}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
