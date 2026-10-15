import { execFile } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// This is diagnostic provenance, not a signed attestation or a source snapshot.
export async function readSourceProvenance(rootDirectory) {
  const unknown = { commit: null, tags: [], state: "unknown" };
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = async (...args) =>
    (
      await run("git", ["-C", rootDirectory, ...args], {
        env: { ...environment, GIT_OPTIONAL_LOCKS: "0" },
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout.trim();
  try {
    // An exported source directory inside another checkout must not inherit its HEAD.
    if (
      (await realpath(await git("rev-parse", "--show-toplevel"))) !==
      (await realpath(rootDirectory))
    )
      return unknown;
    const commit = await git("rev-parse", "--verify", "HEAD^{commit}");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) return unknown;
    const status = await git(
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    );
    const tags = (await git("tag", "--no-column", "--points-at", commit))
      .split("\n")
      .filter(Boolean)
      .sort();
    // HEAD can move even while the read itself is in progress.
    if ((await git("rev-parse", "--verify", "HEAD^{commit}")) !== commit)
      return unknown;
    return { commit, tags, state: status === "" ? "clean" : "dirty" };
  } catch {
    // Source archives, unavailable Git, unsafe repositories and failed reads are
    // usable for local packaging, but never masquerade as verified clean source.
    return unknown;
  }
}

export async function writeBuildInfo({
  appDirectory,
  version,
  target,
  platform,
  arch,
  manifestSha256,
  sourceBefore,
  sourceAfter,
}) {
  if (!/^[a-f0-9]{64}$/u.test(manifestSha256)) {
    throw new Error("Invalid packaged provider manifest digest");
  }
  const source =
    JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter)
      ? sourceBefore
      : { commit: null, tags: [], state: "changed-during-build" };
  const info = {
    schemaVersion: 1,
    version,
    target,
    platform,
    arch,
    source,
    providers: { manifestSha256 },
  };
  // No wall-clock time, machine path, branch label or environment is persisted.
  await writeFile(
    path.join(appDirectory, "build-info.json"),
    `${JSON.stringify(info, null, 2)}\n`,
  );
  return info;
}
