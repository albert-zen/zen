/** Source-build helper only. Never installs or registers desktop permissions. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== "--build-only"))
  throw new Error(
    "Usage: node scripts/build-app-shot-kde-helper.mjs [--build-only]",
  );
if (process.platform !== "linux")
  throw new Error(
    "The KDE helper must be built on Linux for its target architecture.",
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const native = path.join(root, "native", "kde-snap-shot");
const manifest = path.join(native, "Cargo.toml");
const target = path.resolve(
  process.env.CARGO_TARGET_DIR ?? path.join(native, "target"),
);
function cargo(args) {
  const result = spawnSync("cargo", args, {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Full tests need dbus-daemon and permission for a private Unix socket, not KDE.
if (!flags.includes("--build-only"))
  cargo([
    "test",
    "--locked",
    "--manifest-path",
    manifest,
    "--target-dir",
    target,
  ]);
cargo([
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  manifest,
  "--target-dir",
  target,
]);
const executable = path.join(target, "release", "zenx-kde-snap-shot");
const bytes = await readFile(executable);
console.log(
  JSON.stringify(
    {
      executable,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      platform: process.platform,
      arch: process.arch,
      protocolVersion: 1,
      fullTestsRun: !flags.includes("--build-only"),
      installed: false,
    },
    null,
    2,
  ),
);
