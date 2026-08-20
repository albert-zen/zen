import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  bindBundledProviderLaunch,
  hashBundledDirectoryAsset,
  resolveBundledProvider,
  verifyBundledProvider,
} from "../src/main/capabilities/provider-provisioning.js";

test("packaged provisioning verifies the complete browser payload directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-browser-payload-"));
  try {
    const providers = path.join(root, "providers");
    const browser = path.join(
      providers,
      "playwright-browsers",
      "chromium-1237",
    );
    const executable = path.join(browser, "chrome-fixture", "chrome");
    const provider = path.join(providers, "provider.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(provider, "provider");
    await writeFile(executable, "browser executable");
    await writeFile(path.join(browser, "resource.pak"), "browser resource");
    const sha = (value: Buffer) =>
      createHash("sha256").update(value).digest("hex");
    const manifest = {
      schemaVersion: 1,
      providers: {
        "playwright-cli": {
          executable: "provider.js",
          version: "0.1.18",
          sha256: sha(Buffer.from("provider")),
          platforms: ["linux"],
          assets: [
            {
              path: path.relative(providers, browser),
              sha256: await hashBundledDirectoryAsset(browser),
              kind: "directory",
              ignoredPaths: ["DEPENDENCIES_VALIDATED"],
            },
            {
              path: path.relative(providers, executable),
              sha256: sha(Buffer.from("browser executable")),
            },
          ],
        },
      },
    };
    await writeFile(
      path.join(providers, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
    );
    const resolved = await resolveBundledProvider("playwright-cli", {
      resourcesDirectory: root,
      platform: "linux",
    });
    assert.equal(resolved.provider?.assets?.[0]?.kind, "directory");
    assert.equal(resolved.provider?.assets?.length, 2);

    await writeFile(path.join(browser, "DEPENDENCIES_VALIDATED"), "");
    await verifyBundledProvider(resolved.provider!, {
      resourcesDirectory: root,
      platform: "linux",
    });

    await writeFile(path.join(browser, "resource.pak"), "tampered resource");
    await assert.rejects(
      verifyBundledProvider(resolved.provider!, {
        resourcesDirectory: root,
        platform: "linux",
      }),
      /asset integrity mismatch|changed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const manifestSha256 = createHash("sha256")
      .update(await readFile(path.join(providers, "manifest.json")))
      .digest("hex");
    const pinned = await resolveBundledProvider("playwright-cli", {
      resourcesDirectory: root,
      platform: "win32",
      expectedVersion: "0.1.2",
      expectedManifestSha256: manifestSha256,
    });
    assert.equal(pinned.provider?.manifestSha256, manifestSha256);
    const changedManifest = await resolveBundledProvider("playwright-cli", {
      resourcesDirectory: root,
      platform: "win32",
      expectedManifestSha256: "0".repeat(64),
    });
    assert.match(changedManifest.reason ?? "", /manifest integrity mismatch/u);

    const selected = resolved.provider!;
    await writeFile(executable, Buffer.from("replacement", "utf8"));
    await assert.rejects(
      verifyBundledProvider(selected, {
        resourcesDirectory: root,
        platform: "win32",
      }),
      /integrity mismatch|changed/u,
    );

    const tampered = await resolveBundledProvider("playwright-cli", {
      resourcesDirectory: root,
      platform: "win32",
    });
    assert.match(tampered.reason ?? "", /integrity mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged provider provisioning rejects traversal and symlink escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-provider-path-"));
  try {
    const providers = path.join(root, "providers");
    const outside = path.join(root, "outside.exe");
    await mkdir(providers, { recursive: true });
    await writeFile(outside, Buffer.from("outside", "utf8"));
    await writeFile(
      path.join(providers, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          "playwright-cli": {
            executable: "../outside.exe",
            version: "0.1.2",
            sha256: createHash("sha256").update("outside").digest("hex"),
            platforms: ["win32"],
          },
        },
      }),
    );
    const traversal = await resolveBundledProvider("playwright-cli", {
      resourcesDirectory: root,
      platform: "win32",
    });
    assert.match(traversal.reason ?? "", /escapes/u);

    try {
      await (
        await import("node:fs/promises")
      ).symlink(outside, path.join(providers, "linked.exe"));
    } catch {
      return;
    }
    const linkedManifest = JSON.stringify({
      schemaVersion: 1,
      providers: {
        "playwright-cli": {
          executable: "linked.exe",
          version: "0.1.2",
          sha256: createHash("sha256").update("outside").digest("hex"),
          platforms: ["win32"],
        },
      },
    });
    await writeFile(path.join(providers, "manifest.json"), linkedManifest);
    const linked = await resolveBundledProvider("playwright-cli", {
      resourcesDirectory: root,
      platform: "win32",
    });
    assert.match(linked.reason ?? "", /regular|symlink|escapes/u);
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

test("packaged provisioning pins runtime and native companion assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-provider-assets-"));
  try {
    const providers = path.join(root, "providers");
    await mkdir(path.join(providers, "runtime"), { recursive: true });
    const executable = path.join(providers, "provider.js");
    const runtime = path.join(providers, "runtime", "node");
    const companion = path.join(providers, "native.bin");
    await writeFile(executable, "provider");
    await writeFile(runtime, "runtime");
    await writeFile(companion, "native");
    const sha = (value: Buffer) =>
      createHash("sha256").update(value).digest("hex");
    const manifest = {
      schemaVersion: 1,
      providers: {
        "playwright-cli": {
          executable: "provider.js",
          version: "0.1.18",
          sha256: sha(Buffer.from("provider")),
          platforms: ["linux"],
          runtime: {
            path: "runtime/node",
            sha256: sha(Buffer.from("runtime")),
            version: "22.23.2",
          },
          assets: [{ path: "native.bin", sha256: sha(Buffer.from("native")) }],
        },
      },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(path.join(providers, "manifest.json"), manifestBytes);
    const manifestSha256 = sha(manifestBytes);
    const resolved = await resolveBundledProvider("playwright-cli", {
      resourcesDirectory: root,
      platform: "linux",
      expectedManifestSha256: manifestSha256,
    });
    assert.equal(resolved.provider?.runtime?.version, "22.23.2");
    assert.equal(resolved.provider?.assets?.length, 1);
    const release = await bindBundledProviderLaunch(resolved.provider!, {
      resourcesDirectory: root,
      platform: "linux",
    });
    await release();
    await writeFile(companion, "tampered");
    await assert.rejects(
      bindBundledProviderLaunch(resolved.provider!, {
        resourcesDirectory: root,
        platform: "linux",
      }),
      /integrity mismatch|changed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged provisioning pins a Windows shim companion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-provider-shim-"));
  try {
    const providers = path.join(root, "providers");
    await mkdir(providers, { recursive: true });
    const shim = Buffer.from('@echo off\r\n"%dp0%\\node.js" %*\r\n');
    const companion = Buffer.from("console.log('bundled')\n");
    await writeFile(path.join(providers, "provider.cmd"), shim);
    await writeFile(path.join(providers, "node.js"), companion);
    const sha = (value: Buffer) =>
      createHash("sha256").update(value).digest("hex");
    const manifest = {
      schemaVersion: 1,
      providers: {
        "playwright-cli": {
          executable: "provider.cmd",
          version: "0.1.18",
          sha256: sha(shim),
          platforms: ["win32"],
          companion: { path: "node.js", sha256: sha(companion) },
        },
      },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(path.join(providers, "manifest.json"), manifestBytes);
    const resolved = await resolveBundledProvider("playwright-cli", {
      resourcesDirectory: root,
      platform: "win32",
      expectedManifestSha256: sha(manifestBytes),
    });
    assert.equal(resolved.provider?.companion?.sha256, sha(companion));
    await writeFile(path.join(providers, "node.js"), "tampered");
    await assert.rejects(
      verifyBundledProvider(resolved.provider!, {
        resourcesDirectory: root,
        platform: "win32",
      }),
      /integrity mismatch|changed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
