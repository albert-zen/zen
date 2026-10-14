import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hashBundledDirectoryAsset,
  resolveBundledProvider,
  verifyBundledProvider,
} from "../src/main/capabilities/provider-provisioning.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function bundle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-strict-uia-"));
  const prefix = "zenx-winapp-uia";
  const directory = path.join(root, "providers", prefix);
  await mkdir(path.join(directory, "bin"), { recursive: true });
  const files = {
    "bin/winapp.exe": "native fixture",
    "bin/libSkiaSharp.dll": "library",
    "source.lock.json": "source",
    "packages.lock.json": "closure",
    "downstream.patch": "patch",
    "provenance.json": "provenance",
    "UPSTREAM-LICENSE.txt": "license",
  };
  const assets: {
    path: string;
    sha256: string;
    kind?: "directory";
    ignoredPaths?: string[];
  }[] = [];
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(directory, name), content);
    assets.push({ path: `${prefix}/${name}`, sha256: sha(content) });
  }
  assets.push({
    path: `${prefix}/bin`,
    sha256: await hashBundledDirectoryAsset(path.join(directory, "bin")),
    kind: "directory",
  });
  const entry = {
    executable: `${prefix}/bin/winapp.exe`,
    version: "0.3.1-zenx.af0.2",
    sha256: sha(files["bin/winapp.exe"]),
    platforms: ["win32"],
    assets,
    downstream: {
      schemaVersion: 1,
      providerBuild: "zenx-winapp-0.3.1-af0.2",
      upstreamCommit: "c8ada4a403c43b96780b87abc454cba51f649c60",
      patchSha256: sha(files["downstream.patch"]),
      sourceLockSha256: sha(files["source.lock.json"]),
      dependencyLockSha256: sha(files["packages.lock.json"]),
      contractVersion: 1,
    },
  };
  const extraProviders: Record<string, unknown> = {};
  const save = async () => {
    const bytes = JSON.stringify({
      schemaVersion: 1,
      providers: { "zenx-winapp-uia": entry, ...extraProviders },
    });
    await writeFile(path.join(root, "providers", "manifest.json"), bytes);
    return sha(bytes);
  };
  return {
    root,
    directory,
    entry,
    extraProviders,
    save,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("strict native provider requires compiled anchor and explicit downstream contract", async () => {
  const f = await bundle();
  try {
    const digest = await f.save();
    assert.equal(
      (
        await resolveBundledProvider("zenx-winapp-uia", {
          resourcesDirectory: f.root,
          platform: "win32",
        })
      ).provider,
      undefined,
      "unanchored manifest cannot grant background actions",
    );
    const selected = await resolveBundledProvider("zenx-winapp-uia", {
      resourcesDirectory: f.root,
      platform: "win32",
      expectedManifestSha256: digest,
    });
    assert.equal(
      selected.provider?.downstream?.providerBuild,
      "zenx-winapp-0.3.1-af0.2",
    );
    assert.equal(selected.provider?.runtime, undefined);
    Reflect.deleteProperty(f.entry, "downstream");
    assert.equal(
      (
        await resolveBundledProvider("zenx-winapp-uia", {
          resourcesDirectory: f.root,
          platform: "win32",
          expectedManifestSha256: await f.save(),
        })
      ).provider,
      undefined,
    );
  } finally {
    await f.cleanup();
  }
});
test("strict native provider requires source pins and whole native closure", async () => {
  for (const mutation of [
    "patch",
    "directory",
    "dll",
    "ignored",
    "runtime",
  ] as const) {
    const f = await bundle();
    try {
      if (mutation === "patch") f.entry.downstream.patchSha256 = "0".repeat(64);
      if (mutation === "directory")
        f.entry.assets = f.entry.assets.filter((a) => a.kind !== "directory");
      if (mutation === "dll")
        f.entry.assets = f.entry.assets.filter(
          (a) => !a.path.endsWith("libSkiaSharp.dll"),
        );
      if (mutation === "ignored")
        f.entry.assets.find((a) => a.kind === "directory")!.ignoredPaths = [
          "injected.dll",
        ];
      if (mutation === "runtime")
        Object.assign(f.entry, {
          runtime: { path: "node.exe", sha256: "0".repeat(64) },
        });
      assert.equal(
        (
          await resolveBundledProvider("zenx-winapp-uia", {
            resourcesDirectory: f.root,
            platform: "win32",
            expectedManifestSha256: await f.save(),
          })
        ).provider,
        undefined,
        mutation,
      );
    } finally {
      await f.cleanup();
    }
  }
});
test("strict launch always verifies whole native tree, including added files", async () => {
  const f = await bundle();
  try {
    const selected = await resolveBundledProvider("zenx-winapp-uia", {
      resourcesDirectory: f.root,
      platform: "win32",
      expectedManifestSha256: await f.save(),
    });
    assert.ok(selected.provider, selected.reason);
    await writeFile(
      path.join(f.directory, "bin", "injected.dll"),
      "unlisted native code",
    );
    await assert.rejects(
      verifyBundledProvider(selected.provider, {
        resourcesDirectory: f.root,
        platform: "win32",
        verifyDirectoryAssets: false,
      }),
      /integrity|changed/iu,
    );
  } finally {
    await f.cleanup();
  }
});

test("packaged catalog selects only the explicit strict identity and never falls back on contract failure", async () => {
  const { selectComputerProvider } =
    await import("../src/main/capabilities/provider-catalog.js");
  for (const autoSetFocus of [false, true]) {
    const f = await bundle();
    const calls: readonly string[][] = [];
    try {
      const selection = await selectComputerProvider({
        userDataDirectory: path.join(f.root, "user"),
        resourcesDirectory: f.root,
        bundledProvidersOnly: true,
        bundledManifestSha256: await f.save(),
        platform: "win32",
        winAppRunner: {
          async run(_exe, args) {
            (calls as string[][]).push([...args]);
            return {
              stdout: JSON.stringify({
                schemaVersion: 1,
                contractVersion: 1,
                providerBuild: "zenx-winapp-0.3.1-af0.2",
                upstreamCommit: "c8ada4a403c43b96780b87abc454cba51f649c60",
                autoSetFocus,
              }),
              stderr: "",
            };
          },
        },
      });
      assert.equal(selection.manifest.provider.id, "zenx-winapp-uia");
      assert.equal(
        selection.backend !== undefined,
        !autoSetFocus,
        JSON.stringify(selection.diagnostics),
      );
      assert.deepEqual(calls, [["--zenx-uia-contract"]]);
      await selection.backend?.close();
    } finally {
      await f.cleanup();
    }
  }
});

test("cold Computer upgrade retains committed stock backend until the existing profile transaction commits", async () => {
  const { ZenXCapabilityService } =
    await import("../src/main/capability-service.js");
  const { MemoryZenXPluginCatalogStore } =
    await import("../src/main/capabilities/plugin-catalog-store.js");
  const { windowsComputerCapabilityManifest } =
    await import("../src/main/capabilities/windows-computer-provider.js");
  const f = await bundle();
  const stockSource = {
    mode: "bundled" as const,
    packageSpec:
      "/previous/resources/plugins/zenx-computer-plugin-win32-1.1.5.tgz",
    resolvedSpec:
      "/previous/resources/plugins/zenx-computer-plugin-win32-1.1.5.tgz",
    packageName: "@zenx/computer-plugin",
    packageVersion: "1.1.5",
  };
  const initial = {
    profileGeneration: "12345678-1234-1234-1234-123456789abc",
    disabled: ["computer"],
    uninstalled: [],
    packages: {
      computer: {
        manifest: structuredClone(windowsComputerCapabilityManifest),
        source: "bundled" as const,
        profilePackageName: "@zenx/computer-plugin",
        profileSource: stockSource,
      },
    },
  };
  const store = new MemoryZenXPluginCatalogStore(initial);
  for (const file of ["stock.js", "node.exe"])
    await writeFile(path.join(f.root, "providers", file), file);
  f.extraProviders["microsoft-winapp-cli"] = {
    executable: "stock.js",
    version: "0.3.1",
    sha256: sha("stock.js"),
    platforms: ["win32"],
    runtime: { path: "node.exe", sha256: sha("node.exe"), version: "22.23.3" },
  };
  const service = new ZenXCapabilityService({
    userDataDirectory: path.join(f.root, "user"),
    catalogStore: store,
    resourcesDirectory: f.root,
    bundledProvidersOnly: true,
    bundledManifestSha256: await f.save(),
    allowForegroundRequired: false,
    providerCatalogOptions: {
      platform: "win32",
      winAppRunner: {
        async run(_exe, args) {
          if (args[0] === "--zenx-uia-contract")
            return {
              stdout: JSON.stringify({
                schemaVersion: 1,
                contractVersion: 1,
                providerBuild: "zenx-winapp-0.3.1-af0.2",
                upstreamCommit: "c8ada4a403c43b96780b87abc454cba51f649c60",
                autoSetFocus: false,
              }),
              stderr: "",
            };
          if (args[0] === "--version")
            return { stdout: "winapp 0.3.1", stderr: "" };
          if (args[0] === "--cli-schema")
            return {
              stdout: JSON.stringify({
                name: "winapp",
                version: "0.3.1",
                schemaVersion: "1.0",
                subcommands: {
                  ui: {
                    subcommands: Object.fromEntries(
                      [
                        "inspect",
                        "invoke",
                        "list-windows",
                        "screenshot",
                        "set-value",
                        "wait-for",
                      ].map((name) => [name, {}]),
                    ),
                  },
                },
              }),
              stderr: "",
            };
          return { stdout: "[]", stderr: "" };
        },
      },
    },
  });
  try {
    await service.initialize();
    assert.equal(
      service.computerProfilePackage().manifest.provider.id,
      "microsoft-winapp-cli",
      "old manifest cannot execute through the new background backend",
    );
    await assert.rejects(
      service.computerProfilePackage().invoke("computer_press", {
        callId: "legacy",
        name: "computer_press",
        cwd: process.cwd(),
        signal: new AbortController().signal,
        arguments: {
          target: { pid: 71, windowTitle: "Target" },
          control: { observationId: "old", targetId: "old" },
        },
      }),
      /foreground_required/iu,
    );
    await assert.rejects(
      service.syncProfileManagedProviderVariants(),
      /ENOENT/iu,
    );
    assert.equal(
      service.computerProfilePackage().manifest.provider.id,
      "microsoft-winapp-cli",
    );
    assert.deepEqual(
      await store.load(),
      initial,
      "failed upgrade preserves disablement, source and authorization facts",
    );
  } finally {
    await service.close();
    await f.cleanup();
  }
});
