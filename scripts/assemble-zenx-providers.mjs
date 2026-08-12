import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  cp,
  readdir,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const zenx = path.resolve(here, "..", "apps", "zenx");
const lockPath = path.join(
  zenx,
  "resources",
  "providers",
  "provider-lock.json",
);
const lock = JSON.parse(await readFile(lockPath, "utf8"));
const output = path.resolve(
  process.argv[process.argv.indexOf("--output") + 1] ??
    path.join(zenx, ".packaged", "resources"),
);
const providers = path.join(output, "providers");
const work = await mkdtemp(path.join(os.tmpdir(), "zenx-provider-assembly-"));
const maxAssetBytes = 512 * 1024 * 1024;

try {
  await rm(providers, { recursive: true, force: true });
  await mkdir(providers, { recursive: true, mode: 0o700 });
  const platform = process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const nodeKey = `${platform}-${arch}`;
  const nodeArchive = lock.node.platformArchives[nodeKey];
  if (nodeArchive === undefined)
    throw new Error(`No pinned Node runtime for ${nodeKey}`);
  const nodeBytes = await fetchVerified(
    `${lock.node.releaseBase}${nodeArchive.file}`,
    nodeArchive.sha256,
  );
  const nodeArchivePath = path.join(work, nodeArchive.file);
  await writeFile(nodeArchivePath, nodeBytes);
  const nodeExtract = path.join(work, "node");
  await mkdir(nodeExtract);
  await extract(nodeArchivePath, nodeExtract);
  const nodeExecutable = await findFile(
    nodeExtract,
    platform === "win32" ? "node.exe" : "node",
  );
  const runtimePath = path.join(
    providers,
    "runtime",
    path.basename(nodeExecutable),
  );
  await mkdir(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
  await cp(nodeExecutable, runtimePath);
  const nodeLicense = await findFile(nodeExtract, "LICENSE");
  await cp(nodeLicense, path.join(path.dirname(runtimePath), "LICENSE"));
  await writeFile(
    path.join(path.dirname(runtimePath), "THIRD_PARTY_NOTICES.txt"),
    `Node.js ${lock.node.version} — bundled official runtime\n\n${await readFile(nodeLicense, "utf8")}`,
    { mode: 0o600 },
  );
  const runtimeSha256 = sha256(await readFile(runtimePath));

  const playwright = await assembleNpmProvider(
    "playwright-cli",
    platform,
    runtimePath,
  );
  const winapp = await assembleNpmProvider(
    "microsoft-winapp-cli",
    platform,
    runtimePath,
  );
  const browsersPath = path.join(providers, "playwright-browsers");
  await mkdir(browsersPath, { recursive: true, mode: 0o700 });
  await run(
    runtimePath,
    [
      path.join(providers, "playwright-cli", "playwright-cli.js"),
      "install-browser",
    ],
    {
      cwd: path.join(providers, "playwright-cli"),
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const manifest = {
    schemaVersion: 1,
    providers: {
      "playwright-cli": {
        executable: playwright.executable,
        version: lock.providers["playwright-cli"].version,
        sha256: playwright.sha256,
        platforms: [platform],
        runtime: {
          path: path.relative(providers, runtimePath),
          sha256: runtimeSha256,
          version: lock.node.version,
        },
      },
      "microsoft-winapp-cli": {
        executable: winapp.executable,
        version: lock.providers["microsoft-winapp-cli"].version,
        sha256: winapp.sha256,
        platforms: ["win32"],
        runtime: {
          path: path.relative(providers, runtimePath),
          sha256: runtimeSha256,
          version: lock.node.version,
        },
        assets: winapp.assets,
      },
    },
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(providers, "manifest.json"), manifestBytes, {
    mode: 0o600,
  });
  await writeFile(
    path.join(providers, "THIRD_PARTY_NOTICES.txt"),
    `ZenX bundled provider notices\n\n@playwright/cli ${lock.providers["playwright-cli"].version} — Apache-2.0\n@microsoft/winappcli ${lock.providers["microsoft-winapp-cli"].version} — MIT\nNode.js ${lock.node.version} — bundled official runtime; see nodejs.org/dist/${lock.node.version}/README.md\n\nArchive SHA-256:\n@playwright/cli ${lock.providers["playwright-cli"].sha256}\n@microsoft/winappcli ${lock.providers["microsoft-winapp-cli"].sha256}\nNode ${nodeArchive.sha256}\n\nThe complete upstream license texts are copied beside each assembled provider payload.\n`,
    { mode: 0o600 },
  );
  const result = {
    resourcesDirectory: output,
    manifestSha256: sha256(manifestBytes),
    platform,
    arch,
    runtimeVersion: lock.node.version,
    releaseSizeBytes: await directorySize(output),
  };
  await writeFile(
    path.join(output, "provider-assembly.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}

async function assembleNpmProvider(id, platform, runtimePath) {
  const pin = lock.providers[id];
  const archive = await fetchVerified(pin.tarball, pin.sha256);
  const archivePath = path.join(work, `${id}.tgz`);
  await writeFile(archivePath, archive);
  const extracted = path.join(work, id);
  await mkdir(extracted);
  await extract(archivePath, extracted);
  const packageDir = path.join(extracted, "package");
  const destination = path.join(providers, id);
  await cp(packageDir, destination, { recursive: true, force: true });
  if (id === "playwright-cli") {
    await runNpm(
      [
        "install",
        "--prefix",
        destination,
        "--ignore-scripts",
        "--no-save",
        "--package-lock=true",
        "--omit=dev",
        "--omit=optional",
      ],
      { cwd: destination },
    );
  }
  const executable =
    id === "playwright-cli"
      ? path.join(destination, "playwright-cli.js")
      : path.join(destination, "dist", "cli.js");
  const relative = path.relative(providers, executable);
  const bytes = await readFile(executable);
  if (bytes.byteLength > maxAssetBytes)
    throw new Error(`${id} executable exceeds the release bound`);
  await writeFile(
    path.join(destination, "ARCHIVE-SHA256"),
    `${pin.sha256}\n${pin.integrity}\n`,
    { mode: 0o600 },
  );
  const license = path.join(destination, "LICENSE");
  if (!(await exists(license)))
    await writeFile(license, `${id} — ${pin.license}\n`, { mode: 0o600 });
  await appendLicenseNotice(destination, id, pin.license);
  const assets = [];
  if (id === "playwright-cli") {
    const generatedLock = path.join(
      destination,
      "node_modules",
      ".package-lock.json",
    );
    const dependencyLock = Buffer.from(
      (await readFile(generatedLock, "utf8")).replaceAll("\r\n", "\n"),
      "utf8",
    );
    const dependencyLockSha256 = sha256(dependencyLock);
    if (
      pin.dependencyLockSha256 !== undefined &&
      dependencyLockSha256 !== pin.dependencyLockSha256
    ) {
      throw new Error(
        `playwright-cli transitive dependency lock mismatch: expected ${pin.dependencyLockSha256}, got ${dependencyLockSha256}`,
      );
    }
    const dependencyLockPath = path.join(destination, "DEPENDENCY-LOCK.json");
    await writeFile(dependencyLockPath, dependencyLock, { mode: 0o600 });
    assets.push({
      path: path.relative(providers, dependencyLockPath),
      sha256: dependencyLockSha256,
    });
  }
  if (id === "microsoft-winapp-cli") {
    const nativeRoot = path.join(
      destination,
      "bin",
      platform === "win32" ? "win-x64" : "unsupported",
    );
    if (platform === "win32") {
      const nativeExecutable = path.join(nativeRoot, "winapp.exe");
      if (!(await exists(nativeExecutable)))
        throw new Error(
          "WinApp native companion is missing from the official archive",
        );
      const nativeBytes = await readFile(nativeExecutable);
      assets.push({
        path: path.relative(providers, nativeExecutable),
        sha256: sha256(nativeBytes),
      });
    }
  }
  return { executable: relative, sha256: sha256(bytes), runtimePath, assets };
}

async function appendLicenseNotice(destination, id, license) {
  const notices = [];
  for (const file of await walkFiles(destination)) {
    if (!/\/(?:LICENSE|NOTICE)(?:\.[^/]*)?$/iu.test(file.replaceAll("\\", "/")))
      continue;
    notices.push(
      `\n--- ${path.relative(destination, file)} ---\n${await readFile(file, "utf8")}`,
    );
  }
  await writeFile(
    path.join(destination, "THIRD_PARTY_NOTICES.txt"),
    `${id} declared license: ${license}\n${notices.join("\n")}`,
    { mode: 0o600 },
  );
}

async function walkFiles(rootDir) {
  const files = [];
  for (const entry of await readdir(rootDir, { withFileTypes: true })) {
    const candidate = path.join(rootDir, entry.name);
    if (entry.isFile()) files.push(candidate);
    else if (entry.isDirectory()) files.push(...(await walkFiles(candidate)));
  }
  return files;
}

async function fetchVerified(url, expected) {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok)
    throw new Error(`Provider archive fetch failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected)
    throw new Error(`Provider archive integrity mismatch for ${url}`);
  return bytes;
}

async function extract(archive, destination) {
  await run("tar", ["-xf", archive, "-C", destination]);
}

async function runNpm(args, options) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath !== undefined && npmExecPath.length > 0) {
    return await run(process.execPath, [npmExecPath, ...args], options);
  }
  return await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    options,
  );
}

async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const found = await findFile(candidate, name);
      if (found !== undefined) return found;
    }
  }
  throw new Error(`Bundled runtime ${name} was not found`);
}

async function directorySize(root) {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile()) total += (await stat(candidate)).size;
    else if (entry.isDirectory()) total += await directorySize(candidate);
  }
  return total;
}

async function exists(candidate) {
  try {
    await readFile(candidate);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
