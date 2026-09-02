import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { npmInvocation } from "../../../packages/zenx-plugin-sdk/dist/npm-invocation.mjs";
import {
  verifyFirstPartyPluginTarball,
  verifyPortableProviders,
} from "../scripts/verify-portable-artifact.js";
import { hashBundledDirectoryAsset } from "../src/main/capabilities/provider-provisioning.js";

const run = promisify(execFile);

test("portable verification rejects a structurally valid first-party tarball with the wrong plugin id", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-portable-plugin-id-"),
  );
  try {
    const original = new URL(
      "../resources/plugins/zenx-browser-plugin-electron-1.0.0.tgz",
      import.meta.url,
    );
    const extracted = path.join(root, "extracted");
    await mkdir(extracted);
    await run("tar", ["-xzf", original.pathname, "-C", extracted]);
    const manifestFile = path.join(extracted, "package", "zenx.plugin.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
      id: string;
      tools: Array<{ name: string }>;
    };
    manifest.id = "wrong-plugin-id";
    for (const tool of manifest.tools) {
      tool.name = tool.name.replace(/^browser_/u, "wrong_plugin_id_");
    }
    const wrongIdentityManifest = JSON.parse(
      JSON.stringify(manifest)
        .replaceAll("/plugins/browser/", "/plugins/wrong-plugin-id/")
        .replaceAll('"browser_', '"wrong_plugin_id_'),
    ) as unknown;
    await writeFile(
      manifestFile,
      `${JSON.stringify(wrongIdentityManifest, null, 2)}\n`,
    );
    const invocation = npmInvocation([
      "pack",
      "--json",
      "--pack-destination",
      root,
      path.join(extracted, "package"),
    ]);
    const packed = await run(invocation.executable, invocation.args, {
      cwd: root,
    });
    const metadata = JSON.parse(packed.stdout) as Array<{
      filename: string;
    }>;
    assert.equal(metadata.length, 1);
    const filename = metadata[0]?.filename;
    assert.ok(filename);
    const replacement = path.join(root, filename);

    await assert.rejects(
      verifyFirstPartyPluginTarball(replacement, {
        packageIdentity: "@zenx/browser-plugin@1.0.0",
        pluginId: "browser",
      }),
      /unexpected plugin id/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable verification rejects provider executable mutation", async () => {
  const fixture = await createProviderFixture();
  try {
    await verifyPortableProviders(fixture.options);
    await writeFile(fixture.executable, "provider-mutated");
    await assert.rejects(
      verifyPortableProviders(fixture.options),
      /integrity mismatch/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("portable verification rejects provider directory asset mutation", async () => {
  const fixture = await createProviderFixture();
  try {
    await verifyPortableProviders(fixture.options);
    await writeFile(fixture.browserResource, "browser-resource-mutated");
    await assert.rejects(
      verifyPortableProviders(fixture.options),
      /asset integrity mismatch/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("portable verification rejects a packaged-main provider trust-anchor mismatch", async () => {
  const fixture = await createProviderFixture();
  try {
    await verifyPortableProviders(fixture.options);
    await writeFile(
      fixture.integrityChunk,
      `const PACKAGED_PROVIDER_MANIFEST_SHA256 = "${"0".repeat(64)}";\n`,
    );
    await assert.rejects(
      verifyPortableProviders(fixture.options),
      /trust anchor does not match/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createProviderFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-portable-provider-"));
  const resourcesDirectory = path.join(root, "resources");
  const providers = path.join(resourcesDirectory, "providers");
  const appMainDirectory = path.join(resourcesDirectory, "app", "out", "main");
  const chunks = path.join(appMainDirectory, "chunks");
  const executable = path.join(providers, "playwright-cli.js");
  const runtime = path.join(providers, "runtime", "node");
  const browser = path.join(
    providers,
    "playwright-browsers",
    "chromium-fixture",
  );
  const browserResource = path.join(browser, "resource.pak");
  await Promise.all([
    mkdir(path.dirname(runtime), { recursive: true }),
    mkdir(browser, { recursive: true }),
    mkdir(chunks, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(executable, "provider"),
    writeFile(runtime, "runtime"),
    writeFile(browserResource, "browser-resource"),
  ]);
  const sha256 = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const manifest = {
    schemaVersion: 1,
    providers: {
      "playwright-cli": {
        executable: "playwright-cli.js",
        version: "0.1.18",
        sha256: sha256("provider"),
        platforms: ["linux"],
        runtime: {
          path: "runtime/node",
          version: "22.23.2",
          sha256: sha256("runtime"),
        },
        assets: [
          {
            path: path.relative(providers, browser),
            sha256: await hashBundledDirectoryAsset(browser),
            kind: "directory",
          },
        ],
      },
    },
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(providers, "manifest.json"), manifestBytes);
  const manifestSha256 = sha256(manifestBytes);
  const integrityChunk = path.join(
    chunks,
    "packaged-provider-integrity-fixture.js",
  );
  await writeFile(
    integrityChunk,
    `const PACKAGED_PROVIDER_MANIFEST_SHA256 = "${manifestSha256}";\n`,
  );
  await writeFile(path.join(appMainDirectory, "index.js"), "main");
  return {
    root,
    executable,
    browserResource,
    integrityChunk,
    options: {
      resourcesDirectory,
      appMainDirectory,
      platform: "linux" as const,
    },
  };
}
