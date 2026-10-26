import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ComputerZenXCapabilityPackage,
  computerCapabilityManifest,
  type ZenXComputerBackend,
} from "../src/main/capabilities/computer-provider.js";
import { peekabooComputerManifest } from "../src/main/capabilities/provider-catalog.js";
import { ForegroundActivity } from "../src/main/foreground-activity.js";

const target = { pid: 42, windowTitle: "Synthetic fixture" };
const control = { observationId: "observation", targetId: "control" };
const invocation = (name: string) => ({
  callId: name,
  name,
  arguments: { target, control, value: "fixture" },
  cwd: "/fixture",
  signal: new AbortController().signal,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const name of ["computer_press", "computer_set_value"]) {
  test(`Peekaboo ${name} refuses without explicit foreground consent before any dispatch`, async () => {
    let calls = 0;
    const backend = {
      press: async () => {
        calls++;
      },
      setValue: async () => {
        calls++;
      },
    } as unknown as ZenXComputerBackend;
    const service = new ComputerZenXCapabilityPackage(
      backend,
      peekabooComputerManifest(),
    );
    await assert.rejects(
      service.invoke(name, invocation(name)),
      /foreground_required; enable Foreground computer control/,
    );
    assert.equal(calls, 0);
    assert.equal(
      computerCapabilityManifest.tools.find((t) => t.name === name)
        ?.interactionMode,
      "background_safe",
      "native AX must retain its independent contract",
    );
  });

  test(`Peekaboo ${name} with consent waits for indicator and retains stopping until real settlement`, async () => {
    let resolvePaint!: () => void;
    const paint = new Promise<void>((resolve) => {
      resolvePaint = resolve;
    });
    let resolveInput!: (value: unknown) => void;
    const input = new Promise((resolve) => {
      resolveInput = resolve;
    });
    let calls = 0;
    let notifyStopping: (() => void) | undefined;
    const owner = new ForegroundActivity({
      presenter: {
        update: async (state) => {
          if (state.activities.length) await paint;
        },
        close() {},
      },
      agentName: () => "Synthetic fixture",
      report() {},
    });
    const backend = {
      press: async (
        _target: unknown,
        _control: unknown,
        _signal: AbortSignal,
        onStopping?: () => void,
      ) => {
        calls++;
        notifyStopping = onStopping;
        return input;
      },
      setValue: async (
        _target: unknown,
        _control: unknown,
        _value: string,
        _signal: AbortSignal,
        onStopping?: () => void,
      ) => {
        calls++;
        notifyStopping = onStopping;
        return input;
      },
    } as unknown as ZenXComputerBackend;
    const service = new ComputerZenXCapabilityPackage(
      backend,
      peekabooComputerManifest(),
      true,
      owner,
    );
    const pending = service.invoke(name, invocation(name));
    await tick();
    assert.equal(calls, 0);
    assert.equal(owner.snapshot.activities.length, 1);
    resolvePaint();
    // Existing production cancellation notice is intentionally exercised.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(calls, 1);
    notifyStopping?.();
    assert.equal(owner.snapshot.activities[0]?.stopping, true);
    await tick();
    assert.equal(owner.snapshot.activities.length, 1);
    resolveInput({ target, control, characterCount: 7 });
    const result = (await pending) as Record<string, unknown>;
    assert.equal(result.applicationEffect, "unverified");
    assert.equal(result.dispatch, "completed");
    assert.equal(result.impact, "foreground_takeover");
    assert.equal(calls, 1, "unverified must not trigger replay");
    assert.equal(owner.snapshot.activities.length, 0);
    owner.close();
  });

  test(`Peekaboo ${name} consent revoked during notice sends no input`, async () => {
    let calls = 0;
    const backend = {
      press: async () => {
        calls++;
      },
      setValue: async () => {
        calls++;
      },
    } as unknown as ZenXComputerBackend;
    const service = new ComputerZenXCapabilityPackage(
      backend,
      peekabooComputerManifest(),
      true,
    );
    const pending = service.invoke(name, invocation(name));
    service.setForegroundControlAllowed(false);
    await assert.rejects(pending, /revoked/);
    assert.equal(calls, 0);
  });
}

test("Peekaboo static profile and selected service agree on mutation admission", async () => {
  const profile = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-computer-plugin/variants/peekaboo.zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const manifest = peekabooComputerManifest();
  assert.equal(profile.version, manifest.version);
  for (const name of ["computer_press", "computer_set_value"]) {
    const actual = manifest.tools.find((t) => t.name === name)!;
    const published = profile.tools.find(
      (t: { name: string }) => t.name === name,
    );
    for (const key of [
      "interactionMode",
      "permissions",
      "capabilities",
      "description",
    ] as const)
      assert.deepEqual(published[key], actual[key]);
    assert.equal(actual.interactionMode, "foreground_required");
    assert.ok(actual.permissions.includes("computer.foreground.control"));
    assert.equal(actual.capabilities.includes("no_global_input"), false);
  }
});
