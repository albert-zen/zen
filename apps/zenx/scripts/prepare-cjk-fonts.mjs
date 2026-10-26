// CI-only prerequisite. APT's signed Release/Packages remain the authority;
// only the exact verified .deb is eligible for the disposable Actions cache.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "fonts-noto-cjk";
const HELPER = "/usr/lib/apt/apt-helper";
export const APT_OPTIONS = [
  "-o",
  "Acquire::http::Timeout=15",
  "-o",
  "Acquire::https::Timeout=15",
  "-o",
  "Acquire::Retries=0",
  "-o",
  "Acquire::AllowInsecureRepositories=false",
  "-o",
  "Acquire::AllowDowngradeToInsecureRepositories=false",
  "-o",
  "APT::Get::AllowUnauthenticated=false",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function command(program, args, seconds = 20, privileged = false) {
  // GNU timeout bounds even a mirror that continuously trickles bytes. Its
  // process group owns APT helpers; SIGKILL follows a non-cooperative SIGTERM.
  const bounded = ["--kill-after=5s", `${seconds}s`, program, ...args];
  return execFileSync(
    privileged ? "sudo" : "timeout",
    privileged ? ["-n", "timeout", ...bounded] : bounded,
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", DEBIAN_FRONTEND: "noninteractive" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
}

export function paragraphs(text) {
  return text
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const fields = {};
      let key;
      for (const line of block.split("\n")) {
        if (/^\s/.test(line) && key) {
          fields[key] += `\n${line}`;
          continue;
        }
        const match = /^([\w-]+):\s*(.*)$/.exec(line);
        assert.ok(match, "Malformed APT record");
        key = match[1].toLowerCase();
        assert.ok(!(key in fields), "Duplicate APT field");
        fields[key] = match[2];
      }
      return fields;
    });
}

export function officialArchive(value) {
  const url = new URL(value);
  assert.ok(
    ["http:", "https:"].includes(url.protocol),
    "Non-HTTP Ubuntu archive",
  );
  assert.ok(
    [
      "archive.ubuntu.com",
      "azure.archive.ubuntu.com",
      "security.ubuntu.com",
      "ports.ubuntu.com",
    ].includes(url.hostname),
    "Unconfigured or nonofficial Ubuntu host",
  );
  assert.ok(
    !url.username && !url.password && !url.port && !url.search && !url.hash,
    "Unexpected archive URL authority",
  );
  assert.ok(
    ["/ubuntu/", "/ubuntu-ports/"].includes(url.pathname),
    "Unexpected Ubuntu archive path",
  );
  assert.ok(
    value === url.href || `${value}/` === url.href,
    "Noncanonical archive URL",
  );
  return url.href;
}

export function sourceArchives(target, read = readFileSync) {
  const sourcePath = target.sourcesentry?.replace(/:\d+$/, "");
  assert.ok(
    /^\/etc\/apt\/(?:sources\.list|sources\.list\.d\/[\w.-]+\.(?:sources|list))$/.test(
      sourcePath,
    ),
    "Missing original APT source entry",
  );
  const source = read(sourcePath, "utf8");
  assert.ok(
    !/\b(?:trusted|allow-insecure|allow-weak|allow-downgrade-to-insecure)\s*[:=]\s*(?:yes|true|1)\b/i.test(
      source,
    ),
    "APT source disables signature verification",
  );
  const repo = target["repo-uri"];
  let mirrorList = "";
  let archives;
  if (repo === "mirror+file:/etc/apt/apt-mirrors.txt/") {
    mirrorList = read("/etc/apt/apt-mirrors.txt", "utf8");
    archives = mirrorList
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => officialArchive(line.split(/\s+/)[0]));
  } else {
    archives = [officialArchive(repo)];
  }
  assert.ok(
    archives.length > 0 && archives.length <= 3,
    "Unexpected Ubuntu mirror list",
  );
  // This changes only this .deb's transport preference, not sources, keys,
  // Release/Packages, or the runner's mirror configuration.
  archives = [...new Set(archives)].sort(
    (a, b) =>
      Number(new URL(b).hostname === "archive.ubuntu.com") -
      Number(new URL(a).hostname === "archive.ubuntu.com"),
  );
  return {
    archives,
    sourceHash: sha256(JSON.stringify([sourcePath, source, repo, mirrorList])),
  };
}

export function resolvePackage({
  os,
  arch,
  candidate,
  targets,
  readIndex,
  readSource = readFileSync,
}) {
  assert.equal(os.ID, "ubuntu", "CJK prerequisite supports Ubuntu CI only");
  assert.ok(
    /^\d+\.\d+$/.test(os.VERSION_ID) && /^[a-z]+$/.test(os.VERSION_CODENAME),
    "Invalid Ubuntu release",
  );
  assert.ok(/^[a-z0-9]+$/.test(arch), "Invalid dpkg architecture");
  assert.ok(
    /^[0-9][A-Za-z0-9.+:~\-]*$/.test(candidate),
    "No exact APT font candidate",
  );
  const matches = [];
  for (const target of paragraphs(targets)) {
    if (
      target.identifier !== "Packages" ||
      target.origin !== "Ubuntu" ||
      target.label !== "Ubuntu" ||
      target.component !== "main" ||
      target.architecture !== arch ||
      target.codename !== os.VERSION_CODENAME
    )
      continue;
    assert.equal(
      target.trusted,
      "yes",
      "Ubuntu Packages index is not authenticated",
    );
    assert.ok(
      [
        os.VERSION_CODENAME,
        `${os.VERSION_CODENAME}-updates`,
        `${os.VERSION_CODENAME}-security`,
        `${os.VERSION_CODENAME}-backports`,
      ].includes(target.release),
      "Ubuntu index release mismatch",
    );
    const source = sourceArchives(target, readSource);
    const records = paragraphs(readIndex(target.filename)).filter(
      (record) => record.package === PACKAGE && record.version === candidate,
    );
    for (const record of records) {
      assert.ok(
        ["all", arch].includes(record.architecture),
        "Font package architecture mismatch",
      );
      assert.ok(
        /^[a-f0-9]{64}$/.test(record.sha256),
        "Font Packages record lacks SHA256",
      );
      assert.ok(
        /^[1-9][0-9]*$/.test(record.size) &&
          Number(record.size) < 200 * 1024 * 1024,
        "Invalid font package size",
      );
      assert.ok(
        /^pool\/main\/[a-z0-9][a-z0-9+.-]*\/[a-z0-9][a-z0-9+.-]*\/[A-Za-z0-9_+.:~%-]+\.deb$/.test(
          record.filename,
        ) &&
          !record.filename.includes("%") &&
          !record.filename.includes(".."),
        "Unsafe font package path",
      );
      matches.push({
        os: os.ID,
        release: os.VERSION_ID,
        codename: os.VERSION_CODENAME,
        arch,
        version: candidate,
        packageArch: record.architecture,
        sha256: record.sha256,
        size: Number(record.size),
        filename: record.filename,
        ...source,
      });
    }
  }
  assert.ok(
    matches.length > 0,
    "No exact font candidate in authenticated current Ubuntu Packages",
  );
  const selected = matches[0];
  assert.ok(
    matches.every(
      (entry) =>
        entry.sha256 === selected.sha256 &&
        entry.size === selected.size &&
        entry.packageArch === selected.packageArch,
    ),
    "Conflicting official font package hashes",
  );
  selected.cacheKey = `zenx-cjk-deb-v1-${selected.os}-${selected.release}-${selected.codename}-${selected.arch}-${selected.version}-${selected.sha256}`;
  return selected;
}

export function systemPackage(run = command) {
  const os = Object.fromEntries(
    readFileSync("/etc/os-release", "utf8")
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const at = line.indexOf("=");
        return [
          line.slice(0, at),
          line.slice(at + 1).replace(/^"(.*)"$/, "$1"),
        ];
      }),
  );
  const arch = run("dpkg", ["--print-architecture"]).trim();
  const policy = run("apt-cache", ["policy", PACKAGE]);
  const candidate = /^\s*Candidate:\s*(\S+)$/m.exec(policy)?.[1];
  return resolvePackage({
    os,
    arch,
    candidate,
    targets: run("apt-get", ["indextargets"]),
    readIndex: (filename) => run(HELPER, ["cat-file", filename]),
  });
}

export function verifyDeb(file, metadata) {
  const stat = lstatSync(file);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    "Cached font must be a regular file",
  );
  assert.equal(stat.size, metadata.size, "Cached font size mismatch");
  assert.equal(
    sha256(readFileSync(file)),
    metadata.sha256,
    "Cached font SHA256 mismatch",
  );
}

export function installPackage(
  directory,
  metadata,
  { run = command, current = systemPackage } = {},
) {
  assert.deepEqual(
    current(),
    metadata,
    "Ubuntu source/package metadata changed after cache resolution",
  );
  const file = path.join(directory, "cache", "fonts-noto-cjk.deb");
  mkdirSync(path.dirname(file), { recursive: true });
  if (lstatSync(file, { throwIfNoEntry: false })) {
    // Corruption is a hard failure, never an implicit cache miss/refetch.
    verifyDeb(file, metadata);
    console.log(`CJK cache hit verified: ${metadata.cacheKey}`);
  } else {
    const partial = `${file}.partial`;
    let downloaded = false;
    for (const archive of metadata.archives) {
      rmSync(partial, { force: true });
      const uri = new URL(metadata.filename, officialArchive(archive)).href;
      console.log(`CJK cold download: ${uri}`);
      try {
        console.log(
          run(
            HELPER,
            [
              ...APT_OPTIONS,
              "-o",
              "Acquire::http::AllowRedirect=false",
              "-o",
              "Acquire::https::AllowRedirect=false",
              "download-file",
              uri,
              partial,
              `SHA256:${metadata.sha256}`,
            ],
            45,
          ),
        );
        downloaded = true;
      } catch (error) {
        console.error(
          `CJK official mirror unavailable: ${new URL(archive).hostname} (${error.status ?? "timeout"})`,
        );
      }
      if (downloaded) {
        // A successful transport with wrong bytes is not eligible for fallback.
        verifyDeb(partial, metadata);
        renameSync(partial, file);
        break;
      }
    }
    rmSync(partial, { force: true });
    assert.ok(
      downloaded,
      "All configured official Ubuntu font mirrors unavailable within bounded attempts",
    );
  }
  verifyDeb(file, metadata);
  // APT may prefer the repository copy over an explicit local .deb of the
  // same version. Stage its normal archive filename and forbid any download;
  // missing dependencies fail closed instead of re-entering the slow mirror.
  const archives = mkdtempSync(path.join(directory, "apt-archives-"));
  const staged = path.join(
    archives,
    `${PACKAGE}_${metadata.version.replaceAll(":", "%3a")}_${metadata.packageArch}.deb`,
  );
  copyFileSync(file, staged);
  verifyDeb(staged, metadata);
  console.log(
    run(
      "apt-get",
      [
        ...APT_OPTIONS,
        "-o",
        `Dir::Cache::archives=${archives}`,
        "--no-download",
        "install",
        "-y",
        "--no-install-recommends",
        `${PACKAGE}=${metadata.version}`,
      ],
      90,
      true,
    ),
  );
  const installed = run("dpkg-query", [
    "-W",
    "-f=${Version}\n",
    PACKAGE,
  ]).trim();
  assert.equal(
    installed,
    metadata.version,
    "Installed CJK font version differs from signed candidate",
  );
  const fonts = run("fc-list", [":lang=zh", "family"]).trim();
  assert.ok(
    fonts.length > 0 && fonts.includes("Noto"),
    "No installed Noto CJK font; visual acceptance remains blocked",
  );
  console.log(`CJK fonts verified:\n${fonts}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, location] = process.argv.slice(2);
  assert.ok(
    ["resolve", "install"].includes(mode) && location,
    "Usage: prepare-cjk-fonts.mjs resolve|install <runner-temp-directory>",
  );
  const directory = path.resolve(location);
  const metadataFile = path.join(directory, "package.json");
  if (mode === "resolve") {
    console.log(
      command(
        "apt-get",
        [...APT_OPTIONS, "-o", "APT::Update::Error-Mode=any", "update", "-qq"],
        90,
        true,
      ),
    );
    const metadata = systemPackage();
    mkdirSync(directory, { recursive: true });
    writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
    assert.ok(process.env.GITHUB_OUTPUT, "Missing Actions step output path");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `cache-key=${metadata.cacheKey}\ndeb-path=${path.join(directory, "cache", "fonts-noto-cjk.deb")}\n`,
    );
    console.log(
      `CJK signed candidate: ${metadata.version} SHA256:${metadata.sha256}`,
    );
  } else {
    installPackage(directory, JSON.parse(readFileSync(metadataFile, "utf8")));
  }
}
