import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExternalProviderProcessResult,
  ExternalProviderProcessRunner,
} from "../src/main/capabilities/external-provider.js";
import {
  probePeekabooCli,
  probePlaywrightCli,
} from "../src/main/capabilities/provider-catalog.js";

test("pins and validates the Playwright CLI machine-readable contract", async () => {
  const runner = new ScriptedRunner([
    {
      args: ["--json", "--version"],
      stdout: JSON.stringify({ version: "0.1.18" }),
    },
    {
      args: ["--json", "list"],
      stdout: JSON.stringify({
        browsers: [
          {
            name: "default",
            status: "closed",
            version: "1.63.0-alpha-2026-08-05",
          },
        ],
      }),
    },
  ]);
  assert.equal(
    await probePlaywrightCli("/opt/playwright-cli", runner),
    "0.1.18",
  );
  runner.assertComplete();
});

test("rejects incompatible Playwright versions and JSON schema", async () => {
  await assert.rejects(
    probePlaywrightCli(
      "/opt/playwright-cli",
      new ScriptedRunner([
        {
          args: ["--json", "--version"],
          stdout: JSON.stringify({ version: "0.0.9" }),
        },
      ]),
    ),
    /expected >=0\.1\.0/u,
  );
  await assert.rejects(
    probePlaywrightCli(
      "/opt/playwright-cli",
      new ScriptedRunner([
        {
          args: ["--json", "--version"],
          stdout: JSON.stringify({ version: "0.2.0" }),
        },
      ]),
    ),
    /and <0\.2\.0/u,
  );
  await assert.rejects(
    probePlaywrightCli(
      "/opt/playwright-cli",
      new ScriptedRunner([
        {
          args: ["--json", "--version"],
          stdout: JSON.stringify({ version: "0.1.18" }),
        },
        {
          args: ["--json", "list"],
          stdout: JSON.stringify({ browsers: "not-an-array" }),
        },
      ]),
    ),
    /list\.browsers is invalid/u,
  );
});

test("pins Peekaboo 3.x and reports explicit permission diagnostics", async () => {
  const runner = new ScriptedRunner([
    {
      args: ["--version"],
      stdout: "Peekaboo 3.1.2 (release)\n",
    },
    {
      args: ["tools", "--json"],
      stdout: JSON.stringify({
        success: true,
        data: {
          tools: ["see", "click", "set_value", "image"].map((name) => ({
            name,
            description: `${name} tool`,
          })),
        },
      }),
    },
    {
      args: ["permissions", "status", "--json"],
      stdout: JSON.stringify({
        success: true,
        data: {
          permissions: [
            {
              name: "Screen Recording",
              isRequired: true,
              isGranted: true,
            },
            {
              name: "Accessibility",
              isRequired: true,
              isGranted: false,
            },
          ],
        },
      }),
    },
  ]);
  assert.deepEqual(await probePeekabooCli("/opt/peekaboo", runner), {
    version: "3.1.2",
    permissionSummary: "Screen Recording=granted, Accessibility=missing",
  });
  runner.assertComplete();
});

class ScriptedRunner implements ExternalProviderProcessRunner {
  readonly #steps: Array<{
    args: string[];
    stdout: string;
    stderr?: string;
  }>;

  constructor(
    steps: Array<{ args: string[]; stdout: string; stderr?: string }>,
  ) {
    this.#steps = [...steps];
  }

  async run(
    _executable: string,
    args: readonly string[],
    _options: { timeoutMs: number },
  ): Promise<ExternalProviderProcessResult> {
    const step = this.#steps.shift();
    assert.ok(step, `Unexpected provider call: ${args.join(" ")}`);
    assert.deepEqual(args, step.args);
    return { stdout: step.stdout, stderr: step.stderr ?? "" };
  }

  assertComplete(): void {
    assert.equal(this.#steps.length, 0);
  }
}
