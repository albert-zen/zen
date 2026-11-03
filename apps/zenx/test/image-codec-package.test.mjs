import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stageImageCodec } from "../scripts/package-zenx-portable.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));

test("sharp portable staging loads and resizes without checkout modules", async (t) => {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    !process.report.getReport().header.glibcVersionRuntime
  ) {
    t.skip(
      "This execution smoke requires Linux x64 glibc; fixture checks remain cross-platform",
    );
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-sharp-stage-"));
  try {
    await stageImageCodec(root, directory);
    for (const name of [
      "sharp",
      "@img/colour",
      "detect-libc",
      "semver",
      "@img/sharp-linux-x64",
      "@img/sharp-libvips-linux-x64",
    ]) {
      const staged = path.join(directory, "node_modules", name);
      assert.equal((await lstat(staged)).isSymbolicLink(), false, name);
      await stat(path.join(staged, "package.json"));
      assert.ok(
        (
          await readFile(
            path.join(
              directory,
              "licenses",
              `${name.replaceAll("/", "-")}.txt`,
            ),
          )
        ).length > 0,
      );
    }
    assert.match(
      JSON.parse(
        await readFile(
          path.join(directory, "node_modules", "semver", "package.json"),
          "utf8",
        ),
      ).version,
      /^7\./u,
    );
    const script = `
      import sharp from ${JSON.stringify(pathToFileURL(path.join(directory, "node_modules", "sharp", "dist", "index.mjs")).href)};
      const input = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ff0000' } }).png().toBuffer();
      const output = await sharp(input).resize(3, 2).png().toBuffer();
      const metadata = await sharp(output).metadata();
      if (metadata.width !== 3 || metadata.height !== 2) process.exit(9);
    `;
    await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sharp staging rejects incomplete native runtime", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-sharp-missing-"),
  );
  try {
    // Use an isolated dependency closure with no native packages, so this test
    // remains valid when the executing host actually is Windows or Darwin.
    const fixtureRoot = path.join(directory, "fixture");
    const modules = path.join(fixtureRoot, "node_modules");
    await writeNestedSharpFixture(fixtureRoot);
    const app = path.join(directory, "app");
    await assert.rejects(
      () => stageImageCodec(fixtureRoot, app, "win32", "x64"),
      /sharp runtime dependency is missing: @img\/sharp-win32-x64/,
    );
    await assert.rejects(
      () => stageImageCodec(fixtureRoot, app, "darwin", "arm64"),
      /sharp runtime dependency is missing: @img\/sharp-darwin-arm64/,
    );
    assert.match(
      JSON.parse(
        await readFile(
          path.join(app, "node_modules", "semver", "package.json"),
          "utf8",
        ),
      ).version,
      /^7\./u,
    );
    // Fixing the fixture's nested resolution must not weaken version rejection.
    const semverManifest = path.join(
      modules,
      "sharp",
      "node_modules",
      "semver",
      "package.json",
    );
    const invalid = JSON.parse(await readFile(semverManifest, "utf8"));
    invalid.version = "6.3.1";
    await writeFile(semverManifest, JSON.stringify(invalid));
    await assert.rejects(
      () => stageImageCodec(fixtureRoot, app, "win32", "x64"),
      /Unexpected sharp dependency version for semver: 6\.3\.1/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function assertRegularTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const info = await lstat(filename);
    assert.equal(
      info.isSymbolicLink(),
      false,
      `External dependency link: ${filename}`,
    );
    if (info.isDirectory()) await assertRegularTree(filename);
    else assert(info.isFile(), `Non-regular runtime entry: ${filename}`);
  }
}

async function writeNestedSharpFixture(fixtureRoot, includeNative = false) {
  const modules = path.join(fixtureRoot, "node_modules");
  const sharpSource = await realpath(path.join(root, "node_modules", "sharp"));
  const manifest = JSON.parse(
    await readFile(path.join(sharpSource, "package.json"), "utf8"),
  );
  const sourceFor = async (name) => {
    for (const base of [
      path.join(sharpSource, "node_modules"),
      path.dirname(sharpSource),
      path.join(root, "node_modules"),
    ]) {
      try {
        return await realpath(path.join(base, name));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw Error(`Missing installed fixture dependency: ${name}`);
  };
  const names = ["sharp", ...Object.keys(manifest.dependencies)];
  if (includeNative) {
    const target =
      process.platform === "linux" &&
      !process.report.getReport().header.glibcVersionRuntime
        ? `linuxmusl-${process.arch}`
        : `${process.platform}-${process.arch}`;
    names.push(`@img/sharp-${target}`);
    if (manifest.optionalDependencies[`@img/sharp-libvips-${target}`])
      names.push(`@img/sharp-libvips-${target}`);
  }
  for (const name of names) {
    const source = name === "sharp" ? sharpSource : await sourceFor(name);
    const destination =
      name === "semver"
        ? path.join(modules, "sharp", "node_modules", "semver")
        : path.join(modules, name);
    await mkdir(path.dirname(destination), { recursive: true });
    // Control the fixture's npm-ci layout instead of inheriting the executing
    // machine's flat, nested, or package-manager transport links.
    await cp(source, destination, {
      recursive: true,
      filter: (filename) =>
        !path
          .relative(source, filename)
          .split(path.sep)
          .includes("node_modules"),
    });
  }
  const bin = path.join(modules, "sharp", "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  if (process.platform === "win32")
    await writeFile(
      path.join(bin, "semver.cmd"),
      "@node ..\\semver\\bin\\semver.js %*\r\n",
    );
  else await symlink("../semver/bin/semver.js", path.join(bin, "semver"));
  await mkdir(path.join(modules, "semver"), { recursive: true });
  await writeFile(
    path.join(modules, "semver", "package.json"),
    JSON.stringify({ name: "semver", version: "6.3.1" }),
  );
}

test("npm-ci nested sharp staging is regular, repeatable and detached from its unrelated root semver", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-sharp-npm-ci-"));
  const fixtureRoot = path.join(directory, "fixture");
  const app = path.join(directory, "app");
  try {
    await writeNestedSharpFixture(fixtureRoot, true);
    await stageImageCodec(fixtureRoot, app);
    await assertRegularTree(app);
    await assert.rejects(
      stat(path.join(app, "node_modules", "sharp", "node_modules")),
      { code: "ENOENT" },
    );
    // A repeated stage must discard nested modules left by an older partial
    // stage rather than following its checkout-targeting .bin link.
    const legacy = path.join(
      app,
      "node_modules",
      "sharp",
      "node_modules",
      ".bin",
    );
    await mkdir(legacy, { recursive: true });
    if (process.platform !== "win32")
      await symlink(
        path.join(
          fixtureRoot,
          "node_modules",
          "sharp",
          "node_modules",
          "semver",
          "bin",
          "semver.js",
        ),
        path.join(legacy, "semver"),
      );
    else await writeFile(path.join(legacy, "semver.cmd"), "old npm shim");
    await stageImageCodec(fixtureRoot, app);
    await assertRegularTree(app);
    assert.match(
      JSON.parse(
        await readFile(
          path.join(app, "node_modules", "semver", "package.json"),
          "utf8",
        ),
      ).version,
      /^7\./u,
    );
    await rm(fixtureRoot, { recursive: true, force: true });
    await writeFile(
      path.join(app, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      path.join(app, "check.mjs"),
      `import sharp from 'sharp'; import {createRequire} from 'node:module';const require=createRequire(import.meta.url); const cjs=require('sharp');if(!require('semver').satisfies('7.8.2','^7.8.0'))throw Error('wrong semver'); const bytes=await sharp({create:{width:10,height:10,channels:3,background:'red'}}).resize(3,2).png().toBuffer();const info=await cjs(bytes).metadata();if(info.width!==3||info.height!==2)throw Error('resize failed');console.log('NESTED_SHARP_DETACHED_OK');`,
    );
    const { stdout } = await run(
      process.execPath,
      [path.join(app, "check.mjs")],
      {
        cwd: app,
        env: { PATH: process.env.PATH, HOME: app, TMPDIR: app, NODE_PATH: "" },
      },
    );
    assert.match(stdout, /NESTED_SHARP_DETACHED_OK/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sharp staging rejects unexpected package links without following them", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-sharp-source-link-"),
  );
  try {
    const fixture = path.join(directory, "fixture");
    const outside = path.join(directory, "outside");
    await writeNestedSharpFixture(fixture);
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel"), "untouched");
    await symlink(
      outside,
      path.join(fixture, "node_modules", "sharp", "unexpected-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const app = path.join(directory, "app");
    await assert.rejects(
      () => stageImageCodec(fixture, app),
      /Non-regular sharp runtime source/u,
    );
    assert.equal(
      await readFile(path.join(outside, "sentinel"), "utf8"),
      "untouched",
    );
    assert.deepEqual(await readdir(outside), ["sentinel"]);
    await assert.rejects(
      lstat(path.join(app, "node_modules", "sharp", "unexpected-link")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sharp staging rejects linked destination parents before cleanup", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-sharp-parent-link-"),
  );
  try {
    const fixture = path.join(directory, "fixture");
    await writeNestedSharpFixture(fixture);
    for (const target of ["app", "node_modules", "@img"]) {
      const app = path.join(directory, `app-${target}`);
      const outside = path.join(directory, `outside-${target}`);
      const link =
        target === "app"
          ? app
          : path.join(
              app,
              "node_modules",
              ...(target === "@img" ? ["@img"] : []),
            );
      await mkdir(outside);
      await writeFile(path.join(outside, "sentinel"), "untouched");
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      await assert.rejects(
        () => stageImageCodec(fixture, app),
        /Unsafe sharp runtime directory/u,
        target,
      );
      assert.equal(
        await readFile(path.join(outside, "sentinel"), "utf8"),
        "untouched",
        target,
      );
      assert.deepEqual(await readdir(outside), ["sentinel"], target);
      assert.equal((await lstat(link)).isSymbolicLink(), true, target);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sharp staging replaces only the named destination link, never its target", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-sharp-target-link-"),
  );
  try {
    const fixture = path.join(directory, "fixture");
    const app = path.join(directory, "app");
    const outside = path.join(directory, "outside");
    await writeNestedSharpFixture(fixture, true);
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel"), "untouched");
    const link = path.join(app, "node_modules", "semver");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await stageImageCodec(fixture, app);
    await assertRegularTree(app);
    assert.match(
      JSON.parse(await readFile(path.join(link, "package.json"), "utf8"))
        .version,
      /^7\./u,
    );
    assert.equal(
      await readFile(path.join(outside, "sentinel"), "utf8"),
      "untouched",
    );
    assert.deepEqual(await readdir(outside), ["sentinel"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
