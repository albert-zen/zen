import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveBundledProvider } from "../src/main/capabilities/provider-provisioning.js";

test("packaged provider provisioning requires a pinned version and matching hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-provider-bundle-"));
  try {
    const providers = path.join(root, "providers");
    const executable = path.join(providers, "playwright-cli.exe");
    const bytes = Buffer.from("official fixture provider", "utf8");
    await mkdir(providers, { recursive: true });
    await writeFile(executable, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(
      path.join(providers, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          "playwright-cli": {
            executable: "playwright-cli.exe",
            version: "0.1.2",
            sha256,
            platforms: ["win32"],
          },
        },
      }),
    );

    const resolved = await resolveBundledProvider("playwright-cli", {
      resourcesDirectory: root,
      platform: "win32",
    });
    assert.equal(resolved.provider?.version, "0.1.2");
    assert.equal(resolved.provider?.sha256, sha256);

    await writeFile(executable, Buffer.from("tampered", "utf8"));
    const tampered = await resolveBundledProvider("playwright-cli", {
      resourcesDirectory: root,
      platform: "win32",
    });
    assert.match(tampered.reason ?? "", /integrity mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged provider provisioning reports offline or missing assets explicitly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-provider-empty-"));
  try {
    const result = await resolveBundledProvider("microsoft-winapp-cli", {
      resourcesDirectory: root,
      platform: "win32",
    });
    assert.match(result.reason ?? "", /manifest is unavailable/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
