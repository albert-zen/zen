import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appShotRuntimeDependencies,
  appShotRuntimePackages,
  stageAppShotRuntime,
} from "../scripts/stage-app-shot-runtime.mjs";
import { packageManifest } from "../scripts/package-zenx-portable.mjs";
import { writeAppShotRuntimeFixture } from "./fixtures/app-shot-runtime-fixture.mjs";

async function fixture(t, options) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-app-shot-stage-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "root");
  const paths = await writeAppShotRuntimeFixture(root, options);
  return { directory, root, paths, app: path.join(directory, "app") };
}

async function regularTree(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    const entry = await lstat(file);
    assert.equal(entry.isSymbolicLink(), false, file);
    if (entry.isDirectory()) await regularTree(file);
    else assert.equal(entry.isFile(), true, file);
  }
}

test("synthetic App Shot closure stages exactly the selected platform and architecture", async (t) => {
  const { root, directory } = await fixture(t);
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const arch of ["x64", "arm64"]) {
      const app = path.join(directory, `${platform}-${arch}`);
      const result = await stageAppShotRuntime(root, app, platform, arch, {
        libc: "glibc",
      });
      const expected = appShotRuntimePackages(platform, arch, {
        libc: "glibc",
      });
      assert.deepEqual(
        result.packages,
        expected.map((entry) => entry.name),
      );
      assert.equal(result.nativeFiles.length, platform === "win32" ? 2 : 1);
      for (const entry of expected) {
        const destination = path.join(app, "node_modules", entry.name);
        const manifest = JSON.parse(
          await readFile(path.join(destination, "package.json"), "utf8"),
        );
        assert.equal(manifest.version, entry.version);
        for (const file of entry.files)
          assert.equal(
            (await lstat(path.join(destination, file))).isFile(),
            true,
          );
        assert.match(
          await readFile(
            path.join(
              app,
              "licenses",
              `${entry.name.replaceAll("/", "-")}.txt`,
            ),
            "utf8",
          ),
          /Synthetic license/u,
        );
      }
      assert.equal(
        (await readdir(path.join(app, "node_modules", "@crowecawcaw"))).length,
        2,
      );
      if (platform !== "win32")
        await assert.rejects(lstat(path.join(app, "node_modules", "ffi-rs")), {
          code: "ENOENT",
        });
      await regularTree(app);
    }
  }
});

test("unsupported and musl targets fail before touching the destination", async (t) => {
  const { root, app } = await fixture(t);
  for (const [platform, arch, libc] of [
    ["freebsd", "x64", "glibc"],
    ["win32", "ia32", "glibc"],
    ["linux", "x64", "musl"],
    ["linux", "arm64", "unknown"],
  ]) {
    await assert.rejects(
      stageAppShotRuntime(root, app, platform, arch, { libc }),
      /Unsupported App Shot native target/u,
    );
  }
  await assert.rejects(lstat(app), { code: "ENOENT" });
});

test("nested native dependencies are resolved from their exact wrapper and detached on repeat", async (t) => {
  const { root, app, paths } = await fixture(t, { nested: true });
  const wrongRootNative = path.join(
    root,
    "node_modules",
    "@crowecawcaw",
    "xa11y-win32-x64-msvc",
  );
  await mkdir(wrongRootNative, { recursive: true });
  await writeFile(
    path.join(wrongRootNative, "package.json"),
    '{"version":"wrong"}',
  );
  const wrapper = paths.get("@crowecawcaw/xa11y");
  // An upstream loader prioritizes local binaries. Never copy this stray override.
  await writeFile(
    path.join(wrapper, "xa11y.win32-x64-msvc.node"),
    "unreviewed local build",
  );
  await stageAppShotRuntime(root, app, "win32", "x64");
  const staged = path.join(app, "node_modules", "@crowecawcaw", "xa11y");
  await assert.rejects(lstat(path.join(staged, "xa11y.win32-x64-msvc.node")), {
    code: "ENOENT",
  });
  await mkdir(path.join(staged, "node_modules"), { recursive: true });
  await writeFile(path.join(staged, "node_modules", "old-shim"), "old");
  await stageAppShotRuntime(root, app, "win32", "x64");
  await assert.rejects(lstat(path.join(staged, "node_modules")), {
    code: "ENOENT",
  });
  await rm(root, { recursive: true });
  await regularTree(app);
  assert.equal(
    JSON.parse(await readFile(path.join(staged, "package.json"), "utf8"))
      .version,
    "0.13.0",
  );
});

test("published notices are retained and omitted npm licenses get complete pinned MIT notices", async (t) => {
  const { root, app } = await fixture(t, { licenses: false });
  await stageAppShotRuntime(root, app, "win32", "arm64");
  for (const name of [
    "@crowecawcaw/xa11y",
    "@crowecawcaw/xa11y-win32-arm64-msvc",
    "ffi-rs",
    "@yuuang/ffi-rs-win32-arm64-msvc",
  ]) {
    const notice = await readFile(
      path.join(app, "node_modules", name, "LICENSE"),
      "utf8",
    );
    assert.match(notice, /Permission is hereby granted/u);
    assert.match(notice, /THE SOFTWARE IS PROVIDED "AS IS"/u);
    assert.match(
      notice,
      name.startsWith("@crowecawcaw/")
        ? /2025 Stephen Crowe/u
        : /2019 zhangyuang/u,
    );
  }
});

test("wrong versions, undeclared dependencies and missing binaries fail before staging", async (t) => {
  for (const mutation of [
    "wrapper-version",
    "native-version",
    "declared-version",
    "dependency",
    "binary",
    "target",
  ]) {
    const { root, app, paths } = await fixture(t);
    const name =
      mutation === "native-version" ||
      mutation === "binary" ||
      mutation === "target"
        ? "@crowecawcaw/xa11y-win32-x64-msvc"
        : "@crowecawcaw/xa11y";
    const source = paths.get(name);
    const filename = path.join(source, "package.json");
    const manifest = JSON.parse(await readFile(filename, "utf8"));
    if (mutation.endsWith("-version") && mutation !== "declared-version")
      manifest.version = "99.0.0";
    if (mutation === "declared-version")
      manifest.optionalDependencies["@crowecawcaw/xa11y-win32-x64-msvc"] =
        "^0.13.0";
    if (mutation === "dependency")
      manifest.dependencies = { unexpected: "1.0.0" };
    if (mutation === "target") manifest.cpu = ["arm64"];
    await writeFile(filename, JSON.stringify(manifest));
    if (mutation === "binary")
      await rm(path.join(source, "xa11y.win32-x64-msvc.node"));
    await assert.rejects(
      stageAppShotRuntime(root, app, "win32", "x64"),
      /App Shot/u,
      mutation,
    );
    await assert.rejects(lstat(app), { code: "ENOENT" });
  }
});

test("staging refuses linked source files without reading through them", async (t) => {
  const { root, app, directory, paths } = await fixture(t);
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel"), "untouched");
  const native = path.join(
    paths.get("@crowecawcaw/xa11y-win32-x64-msvc"),
    "xa11y.win32-x64-msvc.node",
  );
  await rm(native);
  await symlink(
    outside,
    native,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    stageAppShotRuntime(root, app, "win32", "x64"),
    /Non-regular/u,
  );
  assert.deepEqual(await readdir(outside), ["sentinel"]);
  await assert.rejects(lstat(app), { code: "ENOENT" });
});

test("linked destination parents are rejected and exact destination links never mutate their target", async (t) => {
  for (const target of ["app", "node_modules", "licenses", "@crowecawcaw"]) {
    const { root, app, directory } = await fixture(t);
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel"), "untouched");
    const link =
      target === "app"
        ? app
        : target === "@crowecawcaw"
          ? path.join(app, "node_modules", target)
          : path.join(app, target);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      stageAppShotRuntime(root, app, "win32", "x64"),
      /Unsafe App Shot runtime directory/u,
    );
    assert.deepEqual(await readdir(outside), ["sentinel"]);
  }
  const { root, app, directory } = await fixture(t);
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel"), "untouched");
  const link = path.join(app, "node_modules", "ffi-rs");
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(
    outside,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await stageAppShotRuntime(root, app, "win32", "x64");
  assert.deepEqual(await readdir(outside), ["sentinel"]);
  assert.equal((await lstat(link)).isSymbolicLink(), false);
});

test("app manifest matches staged dependencies and smoke remains independent", async () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const manifest = packageManifest(
      "app",
      { version: "0.1.0", dependencies: {} },
      platform,
    );
    for (const [name, version] of Object.entries(
      appShotRuntimeDependencies(platform),
    ))
      assert.equal(manifest.dependencies[name], version);
    assert.equal(
      manifest.dependencies["ffi-rs"],
      platform === "win32" ? "1.3.2" : undefined,
    );
    const smoke = packageManifest(
      "smoke",
      { version: "0.1.0", dependencies: {} },
      platform,
    );
    assert.equal(smoke.dependencies["@crowecawcaw/xa11y"], undefined);
    assert.equal(smoke.dependencies["ffi-rs"], undefined);
  }
  const config = await readFile(
    new URL("../electron.vite.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    config,
    /include: \["sharp", "ffi-rs", "@crowecawcaw\/xa11y", "dbus-next"\]/u,
  );
  for (const entry of ["app-shot-native-worker", "app-shot-shortcut-worker"])
    assert.ok(config.includes(`"src/main/${entry}.ts"`));
});
