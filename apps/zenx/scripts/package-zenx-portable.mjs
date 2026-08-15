import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const zenx = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = path.resolve(zenx, "..", "..");
const out = path.join(zenx, "out");
const resources = path.join(zenx, ".packaged", "resources");
const target = process.argv.includes("--app") ? "app" : "smoke";
const staging = await mkdtemp(path.join(os.tmpdir(), "zenx-packaged-smoke-"));
const appDir = path.join(staging, "app");

try {
  const assembly = JSON.parse(
    (
      await run(process.execPath, [
        path.join(root, "scripts", "assemble-zenx-providers.mjs"),
        "--output",
        resources,
      ])
    ).stdout,
  );
  const mainOut = path.join(out, "main");
  for (const file of await walk(mainOut)) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(file, "utf8");
    if (source.includes("__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__")) {
      await writeFile(
        file,
        source.replaceAll(
          "__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__",
          assembly.manifestSha256,
        ),
      );
    }
  }
  if (target === "app") {
    await cp(out, path.join(appDir, "out"), { recursive: true });
    await cp(
      path.join(root, "node_modules", "ws"),
      path.join(appDir, "node_modules", "ws"),
      { recursive: true },
    );
  } else {
    await cp(mainOut, path.join(appDir, "main"), { recursive: true });
  }
  const zenxPackage = JSON.parse(
    await readFile(path.join(zenx, "package.json"), "utf8"),
  );
  await writeFile(
    path.join(appDir, "package.json"),
    `${JSON.stringify(
      target === "app"
        ? {
            name: "zenx",
            version: zenxPackage.version,
            private: true,
            type: "module",
            main: "out/main/index.js",
            dependencies: { ws: zenxPackage.dependencies.ws },
          }
        : {
            name: "zenx-packaged-provider-smoke",
            version: zenxPackage.version,
            private: true,
            type: "module",
            main: "main/packaged-provider-smoke.js",
          },
      null,
    )}\n`,
  );
  const { packager } = await import("@electron/packager");
  const packaged = await packager({
    dir: appDir,
    out: path.join(zenx, ".packaged", "artifact"),
    overwrite: true,
    platform: process.platform,
    arch: process.arch,
    name: target === "app" ? "ZenX" : "ZenXProviderSmoke",
    electronVersion: "43.2.0",
    extraResource: [path.join(resources, "providers")],
    asar: false,
  });
  const executable = executablePath(packaged[0], target);
  console.log(
    JSON.stringify(
      {
        packagedArtifact: packaged[0],
        executable,
        target,
        version: zenxPackage.version,
        manifestDigest: assembly.manifestSha256,
        releaseSizeBytes: assembly.releaseSizeBytes,
      },
      null,
      2,
    ),
  );
  if (target === "smoke") await runExecutable(executable);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function walk(rootDir) {
  const result = [];
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(rootDir, { withFileTypes: true })) {
    const candidate = path.join(rootDir, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(candidate)));
    else result.push(candidate);
  }
  return result;
}

function executablePath(appPath, packageTarget) {
  const executableName = packageTarget === "app" ? "ZenX" : "ZenXProviderSmoke";
  if (process.platform === "win32")
    return path.join(appPath, `${executableName}.exe`);
  if (process.platform === "darwin") {
    return path.join(
      appPath,
      `${executableName}.app`,
      "Contents",
      "MacOS",
      executableName,
    );
  }
  return path.join(appPath, executableName);
}

async function runExecutable(executable) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, ZENX_PACKAGED_SMOKE: "1" },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `packaged provider smoke exited ${String(code)} ${signal ?? ""}`,
            ),
          ),
    );
  });
}
