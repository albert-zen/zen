import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
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
    const installed = path.dirname(
      await realpath(path.join(root, "node_modules", "sharp")),
    );
    for (const name of ["sharp", "@img/colour", "detect-libc", "semver"]) {
      const destination =
        name === "semver"
          ? path.join(modules, "sharp", "node_modules", "semver")
          : path.join(modules, name);
      await mkdir(path.dirname(destination), { recursive: true });
      const source =
        name === "semver"
          ? path.dirname(
              createRequire(
                path.join(installed, "sharp", "package.json"),
              ).resolve("semver/package.json"),
            )
          : path.join(installed, name);
      await cp(source, destination, { recursive: true });
    }
    // The application's unrelated semver v6 must not shadow sharp's nested v7.
    await mkdir(path.join(modules, "semver"), { recursive: true });
    await writeFile(
      path.join(modules, "semver", "package.json"),
      JSON.stringify({ name: "semver", version: "6.3.1" }),
    );
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
