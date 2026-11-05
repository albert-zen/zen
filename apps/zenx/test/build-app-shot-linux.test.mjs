import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectCargoNotices,
  withLinuxAppShotSourceDigest,
} from "../scripts/build-app-shot-linux.mjs";
import {
  LINUX_APP_SHOT_SOURCE_FILES,
  linuxAppShotSourceDigest,
} from "../scripts/stage-app-shot-linux.mjs";

async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "zenx-cargo-notices-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pkg = {
    name: "wayland-fixture",
    version: "1.0.0",
    source: "registry+https://github.com/rust-lang/crates.io-index",
    license: "MIT AND BSD-3-Clause",
    manifest_path: path.join(directory, "Cargo.toml"),
    license_file: null,
  };
  await writeFile(path.join(directory, "Cargo.toml"), "fixture");
  await writeFile(
    path.join(directory, "LICENSE-MIT"),
    "MIT holder permission warranty",
  );
  await mkdir(path.join(directory, "protocols"));
  await writeFile(
    path.join(directory, "protocols", "fixture.xml"),
    "<protocol><copyright>Separate protocol holder and terms</copyright></protocol>",
  );
  return { directory, pkg, metadata: { packages: [pkg] } };
}

test("retains crate licenses plus embedded protocol copyrights with locked package identity", async (t) => {
  const { metadata } = await fixture(t);
  const text = (await collectCargoNotices(metadata)).toString();
  assert.match(text, /wayland-fixture 1.0.0/u);
  assert.match(text, /MIT AND BSD-3-Clause/u);
  assert.match(text, /MIT holder permission warranty/u);
  assert.match(text, /Separate protocol holder and terms/u);
  assert.match(text, /RUST-COPYRIGHT-library.html/u);
});

test("fails closed for missing license text, missing XML copyright and unreviewed source", async (t) => {
  for (const kind of ["license", "xml", "source", "expression", "path"])
    await t.test(kind, async (t) => {
      const { directory, metadata, pkg } = await fixture(t);
      if (kind === "license") {
        await rm(path.join(directory, "LICENSE-MIT"));
        await rm(path.join(directory, "protocols"), { recursive: true });
      }
      if (kind === "xml")
        await writeFile(
          path.join(directory, "protocols", "fixture.xml"),
          "<protocol/>",
        );
      if (kind === "source") pkg.source = "git+https://example.invalid/unknown";
      if (kind === "expression") pkg.license = null;
      if (kind === "path") pkg.license_file = "../outside";
      await assert.rejects(
        collectCargoNotices(metadata),
        /license|copyright|source/u,
      );
    });
});

test("retains a license-file from a nested crate directory", async (t) => {
  const { directory, metadata, pkg } = await fixture(t);
  await mkdir(path.join(directory, "legal"));
  await writeFile(
    path.join(directory, "legal", "custom.txt"),
    "Custom crate notice",
  );
  pkg.license_file = "legal/custom.txt";
  assert.match(
    (await collectCargoNotices(metadata)).toString(),
    /Custom crate notice/u,
  );
});

test("rejects symlinked crate notices without reading through them", async (t) => {
  const { directory, metadata } = await fixture(t);
  const target = path.join(directory, "outside");
  await writeFile(target, "private sentinel");
  await rm(path.join(directory, "LICENSE-MIT"));
  try {
    await symlink(target, path.join(directory, "LICENSE-MIT"));
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    t.skip("Windows symlink privilege unavailable");
    return;
  }
  await assert.rejects(
    collectCargoNotices(metadata),
    /Invalid Linux App Shot resource file/u,
  );
});

async function sourceFixture(t) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "zenx-source-snapshot-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of LINUX_APP_SHOT_SOURCE_FILES) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), `fixed build input ${name}\n`);
  }
  return directory;
}

test("build receipt retains the source digest only when the full build leaves inputs unchanged", async (t) => {
  const directory = await sourceFixture(t);
  const expected = await linuxAppShotSourceDigest(directory);
  let builds = 0;
  const digest = await withLinuxAppShotSourceDigest(directory, async () => {
    builds++;
  });
  assert.equal(builds, 1);
  assert.equal(digest, expected);
});

test("synthetic mutation during tests/build prevents a misleading source receipt", async (t) => {
  for (const name of [
    "kde-snap-shot/Cargo.lock",
    "hyprland-app-shot/src/capture.rs",
    "hyprland-app-shot/protocols/hyprland-toplevel-export-v1.xml",
    "kde-snap-shot/src/transport_tests.rs",
  ])
    await t.test(name, async (t) => {
      const directory = await sourceFixture(t);
      await assert.rejects(
        withLinuxAppShotSourceDigest(directory, async () => {
          await writeFile(
            path.join(directory, name),
            "modified while synthetic build was running",
          );
        }),
        /source changed during tests\/build/u,
      );
    });
});

test("missing source input prevents the build callback from starting", async (t) => {
  const directory = await sourceFixture(t);
  await rm(path.join(directory, "kde-snap-shot/Cargo.toml"));
  await assert.rejects(
    withLinuxAppShotSourceDigest(directory, () =>
      assert.fail("must not build"),
    ),
    { code: "ENOENT" },
  );
});
