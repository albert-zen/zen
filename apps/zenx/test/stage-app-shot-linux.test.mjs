import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LINUX_APP_SHOT_FILES,
  LINUX_APP_SHOT_SOURCE_FILES,
  linuxAppShotSourceDigest,
  copyLinuxAppShotResources,
  prepareLinuxAppShotResources,
} from "../scripts/stage-app-shot-linux.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function elf(glibc = "2.35") {
  const bytes = Buffer.alloc(128);
  bytes.write("\x7fELF", 0, "binary");
  bytes[4] = 2;
  bytes[5] = 1;
  bytes[6] = 1;
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.write(`GLIBC_${glibc}\0`, 64);
  return bytes;
}
async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "zenx-linux-resource-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nativeSourceDirectory = path.join(directory, "checkout", "native");
  for (const name of LINUX_APP_SHOT_SOURCE_FILES) {
    await mkdir(path.dirname(path.join(nativeSourceDirectory, name)), {
      recursive: true,
    });
    await writeFile(
      path.join(nativeSourceDirectory, name),
      `checkout fixture ${name}\n`,
    );
  }
  const sourceDirectory = path.join(directory, "dist");
  await mkdir(sourceDirectory);
  const files = {};
  for (const name of LINUX_APP_SHOT_FILES) {
    const bytes = name.includes("/zenx-")
      ? elf()
      : Buffer.from(`fixture ${name}\n`);
    await mkdir(path.dirname(path.join(sourceDirectory, name)), {
      recursive: true,
    });
    await writeFile(path.join(sourceDirectory, name), bytes);
    files[name] = hash(bytes);
  }
  const manifest = {
    schemaVersion: 1,
    platform: "linux",
    architecture: "x64",
    targetTriple: "x86_64-unknown-linux-gnu",
    rustc: "rustc 1.99.1 (fixture)",
    glibc: { kde: "2.35", hyprland: "2.35" },
    fullTestsRun: true,
    sourceSha256: await linuxAppShotSourceDigest(nativeSourceDirectory),
    files,
  };
  await writeFile(
    path.join(sourceDirectory, "manifest.json"),
    JSON.stringify(manifest),
  );
  return {
    directory,
    sourceDirectory,
    nativeSourceDirectory,
    buildPath: path.join(directory, "build", "resources", "app"),
    target: "app",
    platform: "linux",
    arch: "x64",
    manifest,
  };
}

test("full Linux app stages exact inert native distributions beside app, never in ASAR", async (t) => {
  const options = await fixture(t);
  const destination = await copyLinuxAppShotResources(options);
  assert.equal(
    destination,
    path.join(path.dirname(options.buildPath), "app-shot-linux"),
  );
  for (const name of [...LINUX_APP_SHOT_FILES, "manifest.json"]) {
    assert.deepEqual(
      await readFile(path.join(destination, name)),
      await readFile(path.join(options.sourceDirectory, name)),
    );
    const entry = await lstat(path.join(destination, name));
    assert.ok(entry.isFile());
    if (process.platform !== "win32") assert.equal(entry.mode & 0o111, 0);
  }
  await assert.rejects(access(options.buildPath), { code: "ENOENT" });
});

test("smoke and non-Linux preparation and staging skip before path access or build", async () => {
  for (const platform of ["linux", "darwin", "win32"])
    for (const target of ["app", "smoke"]) {
      if (target === "app" && platform === "linux") continue;
      const options = {
        platform,
        target,
        nativeSourceDirectory: "/must-not-read-checkout",
        build: () => assert.fail("must not build"),
      };
      assert.equal(await copyLinuxAppShotResources(options), undefined);
      assert.equal(await prepareLinuxAppShotResources(options), undefined);
    }
});

async function rewriteManifest(options, update) {
  update(options.manifest);
  await writeFile(
    path.join(options.sourceDirectory, "manifest.json"),
    JSON.stringify(options.manifest),
  );
}
async function noStage(options, pattern) {
  await assert.rejects(copyLinuxAppShotResources(options), pattern);
  await assert.rejects(access(path.dirname(options.buildPath)), {
    code: "ENOENT",
  });
}

test("preparation validates prebuilt input without invoking build", async (t) => {
  const options = await fixture(t);
  assert.equal(
    await prepareLinuxAppShotResources({
      ...options,
      build: () => assert.fail("prebuilt must not build"),
    }),
    options.sourceDirectory,
  );
});

test("preparation runs one build into private staging and validates its output", async (t) => {
  const options = await fixture(t);
  let calls = 0;
  const source = await prepareLinuxAppShotResources({
    ...options,
    sourceDirectory: "",
    stagingDirectory: path.join(options.directory, "private"),
    build: async ({ outputDirectory }) => {
      calls++;
      assert.equal(
        outputDirectory,
        path.join(options.directory, "private", "app-shot-linux"),
      );
      const { cp } = await import("node:fs/promises");
      await mkdir(path.dirname(outputDirectory));
      await cp(options.sourceDirectory, outputDirectory, { recursive: true });
    },
  });
  assert.equal(calls, 1);
  assert.equal(
    source,
    path.join(options.directory, "private", "app-shot-linux"),
  );
});

test("unsupported native architectures skip automatic preparation and staging without I/O", async () => {
  for (const arch of ["arm64", "arm", "ia32"]) {
    const options = {
      target: "app",
      platform: "linux",
      arch,
      sourceDirectory: "",
      nativeSourceDirectory: "/must-not-read-checkout",
      build: () => assert.fail("must not build"),
    };
    assert.equal(await prepareLinuxAppShotResources(options), undefined);
    assert.equal(await copyLinuxAppShotResources(options), undefined);
  }
});

test("explicit unsupported-architecture helper artifacts fail before filesystem access", async () => {
  for (const operation of [
    prepareLinuxAppShotResources,
    copyLinuxAppShotResources,
  ])
    await assert.rejects(
      operation({
        target: "app",
        platform: "linux",
        arch: "arm64",
        sourceDirectory: "/must-not-be-read",
        build: () => assert.fail("must not build"),
      }),
      /artifacts require x64/u,
    );
});

test("requires all fixed executables, notices, manifests and manual guides before staging", async (t) => {
  for (const name of [...LINUX_APP_SHOT_FILES, "manifest.json"])
    await t.test(name, async (t) => {
      const options = await fixture(t);
      await rm(path.join(options.sourceDirectory, name));
      await noStage(options, /fixed distribution files/u);
    });
});

test("rejects any extra file, including an executable hidden under protocols", async (t) => {
  for (const name of [
    "extra",
    "kde/install.sh",
    "hyprland/protocols/unexpected.xml",
  ])
    await t.test(name, async (t) => {
      const options = await fixture(t);
      await writeFile(path.join(options.sourceDirectory, name), "extra");
      await noStage(options, /fixed distribution files/u);
    });
});

test("strict manifest schema never supplies copy paths or alternate architecture", async (t) => {
  const changes = [
    (m) => {
      m.install = "anything";
    },
    (m) => {
      m.schemaVersion = 2;
    },
    (m) => {
      m.platform = "darwin";
    },
    (m) => {
      m.architecture = "arm64";
    },
    (m) => {
      m.targetTriple = "aarch64-unknown-linux-gnu";
    },
    (m) => {
      m.rustc = "";
    },
    (m) => {
      m.fullTestsRun = "true";
    },
    (m) => {
      m.files["../outside"] = "a".repeat(64);
    },
    (m) => {
      m.files["/outside"] = "a".repeat(64);
    },
    (m) => {
      delete m.files[LINUX_APP_SHOT_FILES[0]];
    },
    (m) => {
      m.glibc = { ...m.glibc, arm64: "2.35" };
    },
  ];
  for (const [index, change] of changes.entries())
    await t.test(String(index), async (t) => {
      const options = await fixture(t);
      await rewriteManifest(options, change);
      await noStage(options, /distribution manifest/u);
    });
  for (const value of ["null", "[]", "not JSON"])
    await t.test(value, async (t) => {
      const options = await fixture(t);
      await writeFile(
        path.join(options.sourceDirectory, "manifest.json"),
        value,
      );
      await noStage(options);
    });
});

test("rejects changed payloads and invalid checksums before staging", async (t) => {
  for (const change of [
    async (o) =>
      writeFile(
        path.join(o.sourceDirectory, "kde/LICENSE.upstream"),
        "modified",
      ),
    async (o) =>
      rewriteManifest(o, (m) => {
        m.files["README.md"] = "A".repeat(64);
      }),
  ])
    await t.test(async (t) => {
      const options = await fixture(t);
      await change(options);
      await noStage(options, /checksum mismatch/u);
    });
});

test("requires x64 ELF, conservative glibc <= 2.35 and full native tests", async (t) => {
  for (const kind of [
    "not ELF",
    "arm64 ELF",
    "new glibc",
    "glibc mismatch",
    "no glibc",
    "tests skipped",
  ])
    await t.test(kind, async (t) => {
      const options = await fixture(t);
      const name = "kde/zenx-kde-snap-shot";
      let bytes = elf();
      if (kind === "not ELF") bytes = Buffer.from("not executable");
      if (kind === "arm64 ELF") bytes.writeUInt16LE(183, 18);
      if (kind === "new glibc") bytes = elf("2.39");
      if (kind === "no glibc") bytes.fill(0, 64);
      await writeFile(path.join(options.sourceDirectory, name), bytes);
      await rewriteManifest(options, (m) => {
        m.files[name] = hash(bytes);
        if (kind === "new glibc") m.glibc.kde = "2.39";
        if (kind === "glibc mismatch") m.glibc.kde = "2.34";
        if (kind === "tests skipped") m.fullTestsRun = false;
      });
      await noStage(options, /ELF|glibc|native test evidence/u);
    });
});

test("rejects empty, oversized and non-regular files", async (t) => {
  for (const kind of [
    "empty",
    "oversized notice",
    "oversized binary",
    "directory",
  ])
    await t.test(kind, async (t) => {
      const options = await fixture(t);
      const name =
        kind === "oversized binary" ? "kde/zenx-kde-snap-shot" : "README.md";
      const file = path.join(options.sourceDirectory, name);
      if (kind === "directory") {
        await rm(file);
        await mkdir(file);
      } else if (kind === "empty") await writeFile(file, "");
      else {
        const { open } = await import("node:fs/promises");
        const handle = await open(file, "w");
        await handle.truncate(
          (kind === "oversized binary" ? 64 : 4) * 1024 * 1024 + 1,
        );
        await handle.close();
      }
      await noStage(options, /Invalid Linux App Shot resource file/u);
    });
});

async function link(t, source, destination, type) {
  try {
    await symlink(source, destination, type);
    return true;
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    t.skip("Windows symlink privilege unavailable");
    return false;
  }
}

test("rejects source symlinks at all directory levels and payload types", async (t) => {
  for (const location of [
    "parent",
    "root",
    "kde",
    "hyprland/protocols",
    "kde/zenx-kde-snap-shot",
    "README.md",
    "manifest.json",
    "hyprland/THIRD-PARTY-NOTICES.txt",
  ])
    await t.test(location, async (t) => {
      const options = await fixture(t);
      if (location === "parent" || location === "root") {
        const linked = path.join(options.directory, "linked");
        if (
          !(await link(
            t,
            location === "parent" ? options.directory : options.sourceDirectory,
            linked,
            "junction",
          ))
        )
          return;
        options.sourceDirectory =
          location === "parent" ? path.join(linked, "dist") : linked;
      } else {
        const file = path.join(options.sourceDirectory, location);
        const { rename } = await import("node:fs/promises");
        const outside = path.join(options.directory, "outside");
        await rename(file, outside);
        if (
          !(await link(
            t,
            outside,
            file,
            (await lstat(outside)).isDirectory() ? "junction" : "file",
          ))
        )
          return;
      }
      await noStage(options, /Unsafe|Invalid/u);
    });
});

test("refuses existing and symlinked output without changing it", async (t) => {
  for (const location of ["existing", "bundle", "resources", "parent"])
    await t.test(location, async (t) => {
      const options = await fixture(t);
      const resources = path.dirname(options.buildPath);
      const destination = path.join(resources, "app-shot-linux");
      const outside = path.join(options.directory, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "sentinel"), "original");
      if (location === "existing") {
        await mkdir(destination, { recursive: true });
        await writeFile(path.join(destination, "sentinel"), "original");
      } else {
        const linked =
          location === "bundle"
            ? destination
            : location === "resources"
              ? resources
              : path.dirname(resources);
        await mkdir(path.dirname(linked), { recursive: true });
        if (!(await link(t, outside, linked, "junction"))) return;
      }
      await assert.rejects(copyLinuxAppShotResources(options));
      assert.deepEqual(await readdir(outside), ["sentinel"]);
      assert.equal(
        await readFile(path.join(outside, "sentinel"), "utf8"),
        "original",
      );
      if (location === "existing")
        assert.deepEqual(await readdir(destination), ["sentinel"]);
    });
});

test("never stages over or inside the source distribution", async (t) => {
  const options = await fixture(t);
  options.sourceDirectory = path.join(options.directory, "app-shot-linux");
  const { rename } = await import("node:fs/promises");
  await rename(path.join(options.directory, "dist"), options.sourceDirectory);
  for (const buildPath of [
    path.join(options.directory, "app"),
    path.join(options.sourceDirectory, "nested", "app"),
  ])
    await assert.rejects(
      copyLinuxAppShotResources({ ...options, buildPath }),
      /must not overlap/u,
    );
});

test("rejects a self-consistent artifact from older source, Cargo inputs or compiled XML", async (t) => {
  for (const name of [
    "kde-snap-shot/src/main.rs",
    "hyprland-app-shot/src/capture.rs",
    "kde-snap-shot/Cargo.toml",
    "kde-snap-shot/Cargo.lock",
    "hyprland-app-shot/Cargo.lock",
    "hyprland-app-shot/protocols/hyprland-toplevel-export-v1.xml",
    "hyprland-app-shot/protocols/hyprland-toplevel-mapping-v1.xml",
    "kde-snap-shot/src/transport_tests.rs",
  ])
    await t.test(name, async (t) => {
      const options = await fixture(t);
      // The old artifact and all its hashes stay internally consistent. Only the
      // trusted checkout has advanced, which must make reuse fail before writes.
      await writeFile(
        path.join(options.nativeSourceDirectory, name),
        "new checkout input",
      );
      await noStage(options, /stale.*source digest/iu);
      await assert.rejects(
        prepareLinuxAppShotResources(options),
        /stale.*source digest/iu,
      );
    });
});

test("requires the fixed source digest field rather than a self-reported revision", async (t) => {
  for (const kind of ["missing", "invalid", "old", "revision"])
    await t.test(kind, async (t) => {
      const options = await fixture(t);
      await rewriteManifest(options, (manifest) => {
        if (kind === "missing" || kind === "revision")
          delete manifest.sourceSha256;
        if (kind === "invalid") manifest.sourceSha256 = "not-a-sha256";
        if (kind === "old") manifest.sourceSha256 = "a".repeat(64);
        if (kind === "revision") manifest.gitCommit = "a".repeat(40);
      });
      await noStage(options, /manifest|source digest/iu);
    });
});

test("source digest is deterministic, path-independent and covers fixed native inputs", async (t) => {
  const first = await fixture(t),
    second = await fixture(t);
  const digest = await linuxAppShotSourceDigest(first.nativeSourceDirectory);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(
    digest,
    await linuxAppShotSourceDigest(first.nativeSourceDirectory),
  );
  assert.equal(
    digest,
    await linuxAppShotSourceDigest(second.nativeSourceDirectory),
  );
  await writeFile(
    path.join(first.nativeSourceDirectory, "unrelated-build-log"),
    "ignored",
  );
  assert.equal(
    digest,
    await linuxAppShotSourceDigest(first.nativeSourceDirectory),
  );
  await rm(path.join(first.nativeSourceDirectory, "kde-snap-shot/Cargo.toml"));
  await assert.rejects(linuxAppShotSourceDigest(first.nativeSourceDirectory), {
    code: "ENOENT",
  });
});
