/** Explicit developer build only. Never installs into XDG data or changes Hyprland. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { collectCargoNotices } from "./build-app-shot-linux.mjs";
import {
  nativeExecutableGlibc,
  nativeResourceDirectory,
  readNativeResource,
} from "./stage-app-shot-linux.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error(
    "Build the distributed Hyprland helper on Linux x64; arm64 is not verified.",
  );
const source = fileURLToPath(
  new URL("../native/hyprland-app-shot/", import.meta.url),
);
const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === "--out")) {
  throw new Error(
    "Usage: node build-app-shot-hyprland.mjs [--out <build-output-directory>]",
  );
}
const target = path.resolve(
  process.env.CARGO_TARGET_DIR ?? path.join(source, "target"),
);
const output = path.resolve(args[1] ?? path.join(target, "zenx-hyprland-dist"));
await nativeResourceDirectory(source.replace(/\/$/u, ""));
await nativeResourceDirectory(path.dirname(output), true);
try {
  await lstat(output);
  throw new Error("Choose a fresh Hyprland distribution output directory");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const result = spawnSync(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    path.join(source, "Cargo.toml"),
    "--target-dir",
    target,
  ],
  { stdio: "inherit", env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" } },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(
    `Hyprland helper build failed (${result.status ?? result.signal}).`,
  );
const files = [
  "zenx-hyprland-snap-shot",
  "LICENSE.t3code",
  "LICENSE.hyprland-protocols",
  "README.md",
  "Cargo.lock",
  "upstream.json",
  "protocols/hyprland-toplevel-export-v1.xml",
  "protocols/hyprland-toplevel-mapping-v1.xml",
];
const captured = new Map();
for (const file of files) {
  const from =
    file === "zenx-hyprland-snap-shot"
      ? path.join(target, "release", file)
      : path.join(source, file);
  await nativeResourceDirectory(path.dirname(from));
  captured.set(
    file,
    await readNativeResource(
      from,
      file === "zenx-hyprland-snap-shot" ? 64 * 1024 * 1024 : undefined,
      { allowBuildHardlinks: file === "zenx-hyprland-snap-shot" },
    ),
  );
}
function query(command, args) {
  const result = spawnSync(command, args, {
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} metadata failed`);
  return result.stdout.trim();
}
const metadata = JSON.parse(
  query("cargo", [
    "metadata",
    "--locked",
    "--offline",
    "--format-version",
    "1",
    "--filter-platform",
    "x86_64-unknown-linux-gnu",
    "--manifest-path",
    path.join(source, "Cargo.toml"),
  ]),
);
captured.set("THIRD-PARTY-NOTICES.txt", await collectCargoNotices(metadata));
const sysroot = await realpath(query("rustc", ["--print", "sysroot"]));
await nativeResourceDirectory(path.join(sysroot, "share", "doc", "rust"));
captured.set(
  "RUST-COPYRIGHT-library.html",
  await readNativeResource(
    path.join(sysroot, "share", "doc", "rust", "COPYRIGHT-library.html"),
  ),
);
const sha256 = {};
await mkdir(output, { mode: 0o700 });
await mkdir(path.join(output, "protocols"), { mode: 0o700 });
for (const [file, bytes] of captured) {
  await writeFile(path.join(output, file), bytes, { flag: "wx", mode: 0o644 });
  sha256[file] = createHash("sha256").update(bytes).digest("hex");
}
await writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      buildId: "zenx-hyprland-core-v1",
      applicationId: "io.github.albert_zen.ZenX",
      architecture: process.arch,
      rustc: query("rustc", ["--version"]),
      glibc: nativeExecutableGlibc(captured.get("zenx-hyprland-snap-shot")),
      sha256,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o644 },
);
console.log(
  `Built ${output}. This command did not install a helper, edit configuration, register shortcuts, or request capture permission.`,
);
