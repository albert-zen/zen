/** Explicit developer/packager build. Never installs helpers or desktop permissions. */
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LINUX_APP_SHOT_HELPERS,
  nativeExecutableGlibc,
  linuxAppShotSourceDigest,
  nativeResourceDirectory,
  readLinuxAppShotDistribution,
  readNativeResource,
  sha256,
} from "./stage-app-shot-linux.mjs";

const zenx = fileURLToPath(new URL("..", import.meta.url));
const triple = "x86_64-unknown-linux-gnu";
function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: zenx,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status ?? result.signal}); no native distribution is ready`,
    );
  return result.stdout?.trim();
}

/** Keep the actual locked crate notices, including embedded Wayland XML copyrights.
 * This is a conservative superset (build and test crates included), not an SPDX
 * license chooser or a claim that the upstream helper's license covers crates.
 */
export async function collectCargoNotices(metadata) {
  if (!Array.isArray(metadata.packages) || metadata.packages.length > 512)
    throw new Error("Invalid Cargo license metadata");
  const sections = [
    "ZenX Linux App Shot: locked Cargo dependency notices\n\nThis includes the resolved target, build and test dependency set, a conservative superset of the compiled release. License expressions are the crates' declarations; original notices follow. Cargo.lock identifies registry checksums. Rust standard-library notices are in RUST-COPYRIGHT-library.html in the distribution root.\n",
  ];
  const packages = metadata.packages
    .filter((pkg) => pkg.source)
    .sort((a, b) =>
      `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"),
    );
  for (const pkg of packages) {
    if (
      pkg.source !== "registry+https://github.com/rust-lang/crates.io-index" ||
      typeof pkg.license !== "string" ||
      !pkg.license.trim()
    )
      throw new Error(
        `Unreviewed Cargo source or missing license: ${pkg.name}`,
      );
    const root = path.dirname(pkg.manifest_path);
    await nativeResourceDirectory(root);
    const notices = new Map();
    let entries = 0;
    async function visit(directory, depth) {
      if (depth > 16)
        throw new Error(`Cargo notice tree too deep: ${pkg.name}`);
      const names = (await readdir(directory)).sort();
      for (const name of names) {
        if (++entries > 20000)
          throw new Error(`Cargo notice tree too large: ${pkg.name}`);
        const filename = path.join(directory, name);
        const entry = await lstat(filename);
        const relative = path.relative(root, filename);
        if (entry.isDirectory()) {
          await visit(filename, depth + 1);
        } else if (
          /^(?:licen[sc]e|copying|copyright|notice|unlicense)(?:[._-]|$)/iu.test(
            name,
          )
        ) {
          notices.set(
            relative,
            (await readNativeResource(filename)).toString("utf8"),
          );
        } else if (
          /\.xml$/iu.test(name) &&
          pkg.name.startsWith("wayland-") &&
          !["tests", "examples", "benches"].includes(
            relative.split(path.sep)[0],
          )
        ) {
          const xml = (await readNativeResource(filename)).toString("utf8");
          const blocks = [
            ...xml.matchAll(/<copyright(?:\s[^>]*)?>[\s\S]*?<\/copyright>/giu),
          ].map((match) => match[0]);
          if (blocks.length) notices.set(relative, blocks.join("\n\n"));
          else
            throw new Error(
              `Missing protocol copyright: ${pkg.name}/${relative}`,
            );
        } else if (entry.isSymbolicLink()) {
          throw new Error(
            `Symlink in Cargo source tree: ${pkg.name}/${relative}`,
          );
        }
      }
    }
    await visit(root, 0);
    if (pkg.license_file) {
      const filename = path.resolve(root, pkg.license_file);
      if (!filename.startsWith(root + path.sep))
        throw new Error(`Cargo license path outside crate: ${pkg.name}`);
      const directory = path.dirname(filename);
      await nativeResourceDirectory(directory);
      notices.set(
        path.relative(root, filename),
        (await readNativeResource(filename)).toString("utf8"),
      );
    }
    if (!notices.size)
      throw new Error(
        `No distributable license text found for ${pkg.name}@${pkg.version}`,
      );
    sections.push(
      `\n================================================================\n${pkg.name} ${pkg.version}\nDeclared license: ${pkg.license}\nSource: ${pkg.source}\n`,
    );
    for (const [filename, text] of [...notices].sort(([a], [b]) =>
      a.localeCompare(b, "en"),
    ))
      sections.push(`\n--- ${filename} ---\n${text}\n`);
  }
  const bytes = Buffer.from(sections.join(""));
  if (bytes.length > 4 * 1024 * 1024)
    throw new Error("Cargo license notices exceed distribution bound");
  return bytes;
}

/** A receipt must describe the inputs used throughout its tests and compilation. */
export async function withLinuxAppShotSourceDigest(
  nativeSourceDirectory,
  build,
) {
  const before = await linuxAppShotSourceDigest(nativeSourceDirectory);
  await build();
  if (before !== (await linuxAppShotSourceDigest(nativeSourceDirectory)))
    throw new Error(
      "Linux App Shot source changed during tests/build; no distribution receipt is ready",
    );
  return before;
}

export async function buildLinuxAppShotDistribution({
  outputDirectory,
  buildOnly = false,
} = {}) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(
      "Build Linux App Shot on Linux x64; arm64 releases are not yet supported",
    );
  const output = path.resolve(
    outputDirectory ?? path.join(zenx, ".packaged", "app-shot-linux"),
  );
  // Require a fresh private build output. Never merge into user-installed helpers.
  const native = path.join(zenx, "native");
  if (output === native || output.startsWith(native + path.sep))
    throw new Error(
      "Use a separate build output, not the native source directory",
    );
  await nativeResourceDirectory(path.dirname(output), true);
  try {
    await lstat(output);
    throw new Error(
      "Native distribution output already exists; choose a fresh build directory",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const rustc = run("rustc", ["--version"], { capture: true });
  const sysroot = await realpath(
    run("rustc", ["--print", "sysroot"], { capture: true }),
  );
  await nativeResourceDirectory(path.join(sysroot, "share", "doc", "rust"));
  const files = new Map();
  const glibc = {};
  const sourceSha256 = await withLinuxAppShotSourceDigest(native, async () => {
    files.set(
      "README.md",
      await readNativeResource(path.join(native, "LINUX-DISTRIBUTION.md")),
    );
    files.set(
      "RUST-COPYRIGHT-library.html",
      await readNativeResource(
        path.join(sysroot, "share", "doc", "rust", "COPYRIGHT-library.html"),
      ),
    );
    for (const [name, helper] of Object.entries(LINUX_APP_SHOT_HELPERS)) {
      const source = path.join(native, helper.directory);
      await nativeResourceDirectory(source);
      const manifest = path.join(source, "Cargo.toml");
      // Explicit per-helper target dir avoids cross-worktree stale binaries.
      const target = path.resolve(
        process.env.CARGO_TARGET_DIR ?? path.join(source, "target"),
        `linux-dist-${name}`,
      );
      const common = [
        "--locked",
        "--manifest-path",
        manifest,
        "--target",
        triple,
        "--target-dir",
        target,
      ];
      if (!buildOnly) run("cargo", ["test", ...common]);
      run("cargo", ["build", "--release", ...common]);
      const executablePath = path.join(
        target,
        triple,
        "release",
        helper.executable,
      );
      await nativeResourceDirectory(path.dirname(executablePath));
      // Cargo hardlinks release binaries to target/deps. Distribution files are fresh copies.
      const executable = await readNativeResource(
        executablePath,
        64 * 1024 * 1024,
        { allowBuildHardlinks: true },
      );
      glibc[name] = nativeExecutableGlibc(executable);
      files.set(`${name}/${helper.executable}`, executable);
      for (const file of helper.sources) {
        await nativeResourceDirectory(path.dirname(path.join(source, file)));
        files.set(
          `${name}/${file}`,
          await readNativeResource(path.join(source, file)),
        );
      }
      const metadata = JSON.parse(
        run(
          "cargo",
          [
            "metadata",
            "--locked",
            "--offline",
            "--format-version",
            "1",
            "--filter-platform",
            triple,
            "--manifest-path",
            manifest,
          ],
          { capture: true },
        ),
      );
      files.set(
        `${name}/THIRD-PARTY-NOTICES.txt`,
        await collectCargoNotices(metadata),
      );
    }
  });
  const manifest = {
    schemaVersion: 1,
    platform: "linux",
    architecture: "x64",
    targetTriple: triple,
    rustc,
    glibc,
    fullTestsRun: !buildOnly,
    sourceSha256,
    files: Object.fromEntries(
      [...files].map(([name, bytes]) => [name, sha256(bytes)]),
    ),
  };
  files.set(
    "manifest.json",
    Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
  );
  await mkdir(output, { mode: 0o700 });
  for (const [name, bytes] of files) {
    await nativeResourceDirectory(path.dirname(path.join(output, name)), true);
    await writeFile(path.join(output, name), bytes, {
      flag: "wx",
      mode: 0o644,
    });
  }
  await readLinuxAppShotDistribution(output, { requirePortable: false });
  console.log(
    JSON.stringify({
      outputDirectory: output,
      architecture: "x64",
      glibc,
      fullTestsRun: !buildOnly,
      installed: false,
    }),
  );
  return output;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  let outputDirectory,
    buildOnly = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--out" && args[0] && !outputDirectory)
      outputDirectory = args.shift();
    else if (arg === "--build-only" && !buildOnly) buildOnly = true;
    else
      throw new Error(
        "Usage: node build-app-shot-linux.mjs [--out <fresh-build-directory>] [--build-only]",
      );
  }
  await buildLinuxAppShotDistribution({ outputDirectory, buildOnly });
}
