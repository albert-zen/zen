import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export async function sourceIdentity(root) {
  const git = async (...args) =>
    (await run("git", ["-C", root, ...args])).stdout.trim();
  assert.equal(
    await git("status", "--porcelain", "--untracked-files=no"),
    "",
    "Distribution requires clean tracked source",
  );
  assert.equal(
    await git(
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ".",
      ":!node_modules",
      ":!.native-sources/winappcli",
    ),
    "",
    "Distribution requires source files to be committed",
  );
  const commit = await git("rev-parse", "HEAD");
  const tree = await git("rev-parse", "HEAD^{tree}");
  assert.match(commit, /^[a-f0-9]{40}$/u);
  assert.match(tree, /^[a-f0-9]{40}$/u);
  const lockfiles = [];
  for (const file of [
    "package-lock.json",
    "apps/zenx/resources/providers/provider-lock.json",
    "apps/imzen/uv.lock",
  ]) {
    lockfiles.push({
      path: file,
      sha256: await fileSha256(path.join(root, file)),
    });
  }
  return { commit, tree, lockfiles };
}

export function artifactPaths(directory, platform) {
  const resources =
    platform === "darwin" ? "ZenX.app/Contents/Resources" : "resources";
  return {
    resources: path.join(directory, resources),
    executable: path.join(
      directory,
      platform === "darwin"
        ? "ZenX.app/Contents/MacOS/ZenX"
        : platform === "win32"
          ? "ZenX.exe"
          : "ZenX",
    ),
  };
}

export function executableTarget(header) {
  if (header.length >= 8 && header.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = header.readUInt32LE(4);
    assert.ok(
      cpu === 0x01000007 || cpu === 0x0100000c,
      "Unsupported Mach-O CPU",
    );
    return { platform: "darwin", arch: cpu === 0x0100000c ? "arm64" : "x64" };
  }
  if (header.length >= 64 && header.toString("ascii", 0, 2) === "MZ") {
    const offset = header.readUInt32LE(0x3c);
    assert.ok(offset + 6 <= header.length, "Invalid PE header offset");
    assert.equal(
      header.readUInt32LE(offset),
      0x00004550,
      "Invalid PE signature",
    );
    const cpu = header.readUInt16LE(offset + 4);
    assert.ok(cpu === 0x8664 || cpu === 0xaa64, "Unsupported PE CPU");
    return { platform: "win32", arch: cpu === 0xaa64 ? "arm64" : "x64" };
  }
  if (header.length >= 20 && header.toString("hex", 0, 4) === "7f454c46") {
    assert.equal(header[4], 2, "Expected 64-bit ELF");
    assert.equal(header[5], 1, "Expected little-endian ELF");
    const cpu = header.readUInt16LE(18);
    assert.ok(cpu === 62 || cpu === 183, "Unsupported ELF CPU");
    return { platform: "linux", arch: cpu === 183 ? "arm64" : "x64" };
  }
  throw new Error("Unrecognized executable architecture");
}

export function assertPublicArtifactPath(relative) {
  const parts = relative.toLowerCase().split("/");
  const forbidden = new Set([
    ".git",
    ".ssh",
    ".aws",
    ".env",
    ".venv",
    "site-packages",
    "im_agent_sdk",
    "im-agent-sdk",
    "host-profile.json",
    "signing.json",
    "credentials.json",
    "credentials.vault",
    "app-server.json",
    "trace",
    "threads",
  ]);
  assert.ok(
    !parts.some(
      (part) =>
        forbidden.has(part) ||
        part.startsWith(".env.") ||
        /\.(?:p12|pfx|key)$/u.test(part),
    ),
    `Non-distribution content: ${relative}`,
  );
}

// Never follows directory links; their exact target is part of the manifest.
export async function inventoryArtifact(
  directory,
  { platform = process.platform } = {},
) {
  const root = await realpath(directory);
  assert.ok(
    (await lstat(directory)).isDirectory(),
    "Artifact root must be a real directory",
  );
  const entries = [];
  async function walk(relative) {
    const names = (await readdir(path.join(directory, relative))).sort();
    for (const name of names) {
      const entryPath = relative ? `${relative}/${name}` : name;
      assertPublicArtifactPath(entryPath);
      const file = path.join(directory, entryPath);
      const info = await lstat(file);
      // Windows archives do not preserve meaningful POSIX mode bits.
      const mode = platform === "win32" ? undefined : info.mode & 0o777;
      if (info.isSymbolicLink()) {
        const target = await readlink(file);
        assert.ok(!path.isAbsolute(target), "Absolute artifact link");
        const resolved = await realpath(file);
        assert.ok(
          resolved === root || resolved.startsWith(`${root}${path.sep}`),
          "Artifact link escapes package",
        );
        entries.push({
          path: entryPath,
          type: "symlink",
          target,
          ...(mode === undefined ? {} : { mode }),
        });
      } else if (info.isDirectory()) {
        entries.push({
          path: entryPath,
          type: "directory",
          ...(mode === undefined ? {} : { mode }),
        });
        await walk(entryPath);
      } else {
        assert.ok(info.isFile(), "Unsupported artifact filesystem entry");
        entries.push({
          path: entryPath,
          type: "file",
          size: info.size,
          sha256: await fileSha256(file),
          ...(mode === undefined ? {} : { mode }),
        });
        if (/\/plugins\/[^/]+\.tgz$/u.test(entryPath)) {
          const { stdout } = await run("tar", ["-tzf", file], {
            maxBuffer: 8 * 1024 * 1024,
          });
          for (const member of stdout.trim().split(/\r?\n/u)) {
            assert.ok(
              !member.startsWith("/") && !member.split("/").includes(".."),
              "Unsafe bundled plugin member",
            );
            assertPublicArtifactPath(member);
          }
        }
        if (/\/app\/out\/main\/.*\.js$/u.test(entryPath)) {
          const source = await readFile(file, "utf8");
          for (const marker of [
            "__zenxLaunchPathObserver",
            "./launch-path-observer.mjs",
          ]) {
            assert.ok(
              !source.includes(marker),
              `Instrumented application bundle: ${entryPath}`,
            );
          }
        }
      }
    }
  }
  await walk("");
  return entries;
}

export async function createArtifactManifest({
  directory,
  source,
  platform = process.platform,
  arch = process.arch,
}) {
  assert.equal(
    path.basename(directory),
    `ZenX-${platform}-${arch}`,
    "Artifact target name mismatch",
  );
  const paths = artifactPaths(directory, platform);
  const handle = await open(paths.executable, "r");
  let target;
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer);
    target = executableTarget(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  assert.deepEqual(
    target,
    { platform, arch },
    "Executable target does not match native build target",
  );
  const packageJson = JSON.parse(
    await readFile(path.join(paths.resources, "app/package.json"), "utf8"),
  );
  assert.equal(packageJson.name, "zenx");
  assert.equal(packageJson.main, "out/main/index.js");
  const entries = await inventoryArtifact(directory, { platform });
  return {
    schemaVersion: 1,
    source,
    target,
    artifactDirectory: path.basename(directory),
    applicationVersion: packageJson.version,
    providerManifestSha256: await fileSha256(
      path.join(paths.resources, "providers/manifest.json"),
    ),
    fileManifestSha256: sha256(JSON.stringify(entries)),
    entries,
  };
}

export async function verifyArtifact(directory, manifest) {
  const entries = await inventoryArtifact(directory, {
    platform: manifest.target.platform,
  });
  assert.equal(
    sha256(JSON.stringify(entries)),
    manifest.fileManifestSha256,
    "Full packaged content changed",
  );
  assert.deepEqual(
    entries,
    manifest.entries,
    "Full packaged file manifest mismatch",
  );
}

export async function verifyMacSignature(directory) {
  if (process.platform !== "darwin")
    return {
      verification: "not-run",
      reason: "No Windows signing identity is configured by this pipeline",
    };
  const bundle = path.join(directory, "ZenX.app");
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  const { stderr } = await run("/usr/bin/codesign", [
    "--display",
    "--verbose=2",
    bundle,
  ]);
  return {
    verification: "passed",
    mode: stderr.includes("Signature=adhoc") ? "ad-hoc" : "signed",
    notarization: "not-verified",
  };
}
