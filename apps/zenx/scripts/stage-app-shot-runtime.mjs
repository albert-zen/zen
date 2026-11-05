import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export const APP_SHOT_XA11Y_VERSION = "0.13.0";
export const APP_SHOT_FFI_VERSION = "1.3.2";

export function appShotRuntimeDependencies(platform = process.platform) {
  return {
    "@crowecawcaw/xa11y": APP_SHOT_XA11Y_VERSION,
    ...(platform === "win32" ? { "ffi-rs": APP_SHOT_FFI_VERSION } : {}),
  };
}

export function appShotRuntimePackages(
  platform = process.platform,
  arch = process.arch,
  {
    libc = process.report?.getReport()?.header.glibcVersionRuntime
      ? "glibc"
      : "unknown",
  } = {},
) {
  if (
    !["darwin", "win32", "linux"].includes(platform) ||
    !["x64", "arm64"].includes(arch) ||
    (platform === "linux" && libc !== "glibc")
  ) {
    throw new Error(
      `Unsupported App Shot native target: ${platform}-${arch}-${libc}`,
    );
  }
  const target = `${platform}-${arch}${platform === "win32" ? "-msvc" : platform === "linux" ? "-gnu" : ""}`;
  const result = [];
  for (const [name, version, prefix, scope, files] of [
    [
      "@crowecawcaw/xa11y",
      APP_SHOT_XA11Y_VERSION,
      "xa11y",
      "@crowecawcaw",
      ["index.js", "native.js"],
    ],
    ...(platform === "win32"
      ? [["ffi-rs", APP_SHOT_FFI_VERSION, "ffi-rs", "@yuuang", ["index.js"]]]
      : []),
  ]) {
    const native = `${scope}/${prefix}-${target}`;
    result.push({ name, version, files, native, main: "index.js" });
    const binary = `${prefix}.${target}.node`;
    result.push({
      name: native,
      version,
      files: [binary],
      main: binary,
      parent: name,
    });
  }
  return result;
}

// Some upstream npm native packages omit LICENSE. Keep the complete verified
// upstream MIT notice, as T3 does, instead of dropping attribution.
// xa11y: https://github.com/xa11y/xa11y/blob/v0.13.0/LICENSE
// ffi-rs: https://github.com/zhangyuang/node-ffi-rs/blob/9c5ba3452d8cedbb0b30c7ce4dd0138135bd06ea/LICENSE
const MIT_NOTICE =
  'MIT License\n\n__COPYRIGHT__\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n';

function pinnedNotice(name) {
  return MIT_NOTICE.replace(
    "__COPYRIGHT__",
    name.startsWith("@crowecawcaw/")
      ? "Copyright (c) 2025 Stephen Crowe"
      : "Copyright (c) 2019 zhangyuang",
  );
}

async function packageSource(name, fromManifest) {
  const require = createRequire(fromManifest);
  for (const modules of require.resolve.paths(name) ?? []) {
    try {
      const source = await realpath(path.join(modules, name));
      if (!(await lstat(source)).isDirectory())
        throw new Error(`Invalid App Shot runtime package: ${name}`);
      return source;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`App Shot runtime dependency is missing: ${name}`);
}

async function regularFile(filename, required = true) {
  let entry;
  try {
    entry = await lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return false;
    throw new Error(`App Shot runtime file is missing: ${filename}`, {
      cause: error,
    });
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0)
    throw new Error(`Non-regular or empty App Shot runtime file: ${filename}`);
  return true;
}

async function safeDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error(`Unsafe App Shot runtime directory: ${directory}`);
}

/** Offline, exact-version staging. Never installs, compiles, loads native code or changes OS grants. */
export async function stageAppShotRuntime(
  rootDirectory,
  appDirectory,
  platform = process.platform,
  arch = process.arch,
  options = {},
) {
  const plans = appShotRuntimePackages(platform, arch, options);
  const sources = new Map();
  const prepared = [];
  // Validate the complete closure before changing the destination.
  for (const plan of plans) {
    const fromManifest = plan.parent
      ? path.join(sources.get(plan.parent), "package.json")
      : path.resolve(rootDirectory, "apps", "zenx", "package.json");
    const source = await packageSource(plan.name, fromManifest);
    await regularFile(path.join(source, "package.json"));
    const manifest = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    if (
      manifest.name !== plan.name ||
      manifest.version !== plan.version ||
      manifest.main !== plan.main ||
      manifest.license !== "MIT" ||
      Object.keys(manifest.dependencies ?? {}).length > 0
    ) {
      throw new Error(`Unaudited App Shot runtime package: ${plan.name}`);
    }
    if (
      plan.native &&
      manifest.optionalDependencies?.[plan.native] !== plan.version
    )
      throw new Error(`App Shot native version does not match: ${plan.native}`);
    if (
      plan.parent &&
      (!manifest.os?.includes(platform) ||
        !manifest.cpu?.includes(arch) ||
        (platform === "linux" &&
          manifest.libc !== undefined &&
          !manifest.libc.includes("glibc")))
    )
      throw new Error(`App Shot native target does not match: ${plan.name}`);
    const files = [...plan.files, "package.json"];
    for (const file of files) await regularFile(path.join(source, file));
    for (const file of ["index.d.ts", "native.d.ts", "README.md"]) {
      if (await regularFile(path.join(source, file), false)) files.push(file);
    }
    const licenses = (await readdir(source)).filter((file) =>
      /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/iu.test(file),
    );
    for (const file of licenses) {
      await regularFile(path.join(source, file));
      files.push(file);
    }
    sources.set(plan.name, source);
    prepared.push({ ...plan, source, files, licenses });
  }

  const appRoot = path.resolve(appDirectory);
  const modules = path.join(appRoot, "node_modules");
  const licenseDirectory = path.join(appRoot, "licenses");
  await safeDirectory(appRoot);
  await safeDirectory(modules);
  await safeDirectory(licenseDirectory);
  for (const entry of prepared) {
    const destination = path.join(modules, entry.name);
    await safeDirectory(path.dirname(destination));
    const relative = path.relative(destination, entry.source);
    if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative)))
      throw new Error("App Shot staging cannot replace its source package");
    // Remove only the exact package path. rm does not follow its symlink target.
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination);
    for (const file of entry.files)
      await cp(path.join(entry.source, file), path.join(destination, file));
    const notice = entry.licenses.length
      ? (
          await Promise.all(
            entry.licenses.map((file) =>
              readFile(path.join(entry.source, file), "utf8"),
            ),
          )
        ).join("\n")
      : pinnedNotice(entry.name);
    if (entry.licenses.length === 0)
      await writeFile(path.join(destination, "LICENSE"), notice);
    const noticePath = path.join(
      licenseDirectory,
      `${entry.name.replaceAll("/", "-")}.txt`,
    );
    await rm(noticePath, { force: true });
    await writeFile(noticePath, notice);
  }
  return {
    platform,
    arch,
    packages: plans.map((entry) => entry.name),
    nativeFiles: plans
      .filter((entry) => entry.parent)
      .map((entry) => `${entry.name}/${entry.main}`),
  };
}
