import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExternalProviderProcessResult,
  ExternalProviderProcessRunner,
} from "../src/main/capabilities/external-provider.js";
import { PeekabooComputerBackend } from "../src/main/capabilities/peekaboo-computer-provider.js";

const target = {
  pid: 42,
  bundleId: "dev.zen.fixture",
  windowTitle: "Fixture",
};

test("Peekaboo provider keeps semantic actions background-first and opaque", async () => {
  const runner = new FakePeekabooRunner();
  const backend = new PeekabooComputerBackend({
    executable: "/opt/peekaboo",
    runner,
  });
  const inspection = await backend.inspect(target);
  assert.equal(inspection.controls.length, 3);
  assert.equal(inspection.controls[2]?.secure, true);
  assert.deepEqual(inspection.controls[2]?.actions, ["press"]);
  const button = inspection.controls[0];
  assert.ok(button);
  await backend.press(target, button.selector);
  const click = runner.calls.find((args) => args[0] === "click");
  assert.ok(click);
  assert.equal(click.includes("--foreground"), false);
  assert.ok(click.includes("--snapshot"));
  assert.equal(click.at(-1), "--json");
  await assert.rejects(
    backend.press(target, button.selector),
    /stale, unknown/u,
  );
});

test("Peekaboo foreground baseline is explicit in the invoked command", async () => {
  const runner = new FakePeekabooRunner();
  const backend = new PeekabooComputerBackend({
    executable: "/opt/peekaboo",
    runner,
  });
  await backend.foregroundClick(100, 200, "left", new AbortController().signal);
  assert.deepEqual(runner.calls[0], [
    "click",
    "--coords",
    "100,200",
    "--global-coords",
    "--foreground",
    "--json",
  ]);
});

test("Peekaboo provider re-observes and rejects changed element identity", async () => {
  const runner = new FakePeekabooRunner();
  const backend = new PeekabooComputerBackend({
    executable: "/opt/peekaboo",
    runner,
  });
  const inspection = await backend.inspect(target);
  const button = inspection.controls[0];
  assert.ok(button);
  runner.changeIdentity = true;
  await assert.rejects(
    backend.press(target, button.selector),
    /identity changed/u,
  );
  assert.equal(runner.calls.filter((args) => args[0] === "click").length, 0);
});

test("Peekaboo accepts an applicationId-only target without an undefined CLI argument", async () => {
  const runner = new FakePeekabooRunner();
  const backend = new PeekabooComputerBackend({
    executable: "/opt/peekaboo",
    runner,
  });
  const applicationTarget = {
    applicationId: "Fixture Application",
    windowTitle: "Fixture",
  };
  const inspection = await backend.inspect(applicationTarget);
  assert.equal(inspection.target.applicationId, "Fixture Application");
  assert.equal(inspection.target.applicationName, "Fixture");
  const see = runner.calls.find((args) => args[0] === "see");
  assert.ok(see);
  const appIndex = see.indexOf("--app");
  assert.notEqual(appIndex, -1);
  assert.equal(see[appIndex + 1], "Fixture Application");
  assert.equal(
    see.some((argument) => argument === undefined),
    false,
  );
});

class FakePeekabooRunner implements ExternalProviderProcessRunner {
  readonly calls: string[][] = [];
  changeIdentity = false;
  #seeCount = 0;

  async run(
    _executable: string,
    args: readonly string[],
    _options: { timeoutMs: number },
  ): Promise<ExternalProviderProcessResult> {
    this.calls.push([...args]);
    if (args[0] === "see") this.#seeCount += 1;
    const data =
      args[0] === "see"
        ? {
            snapshot_id: "snapshot-1",
            application_name: "Fixture",
            window_title: "Fixture",
            ui_elements: [
              {
                id: "B1",
                role: "AXButton",
                label:
                  this.changeIdentity && this.#seeCount > 1 ? "Changed" : "Run",
                is_actionable: true,
              },
              {
                id: "T1",
                role: "AXTextField",
                label: "Name",
                is_actionable: true,
              },
              {
                id: "S1",
                role: "AXSecureTextField",
                label: "Password",
                is_actionable: true,
              },
            ],
          }
        : {};
    return {
      stdout: JSON.stringify({ success: true, data }),
      stderr: "",
    };
  }
}
