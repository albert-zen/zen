import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Offline staging of the exact pinned Node-API primitive and its locked JS closure. */
export async function stageStorageWriter(
  rootDirectory,
  appDirectory,
  platform = process.platform,
  arch = process.arch,
) {
  const lock = JSON.parse(
    await readFile(path.join(rootDirectory, "package-lock.json"), "utf8"),
  );
  const nativeName = "fs-native-extensions";
  const source = path.join(rootDirectory, "node_modules", nativeName);
  const manifest = JSON.parse(
    await readFile(path.join(source, "package.json"), "utf8"),
  );
  if (
    manifest.version !== "1.4.5" ||
    lock.packages[`node_modules/${nativeName}`]?.version !== "1.4.5"
  )
    throw new Error(
      "Storage writer requires the reviewed fs-native-extensions 1.4.5",
    );
  const prebuild = `prebuilds/${platform}-${arch}/fs-native-extensions.node`;
  if (!(await stat(path.join(source, prebuild))).isFile())
    throw new Error(`Storage writer prebuild unavailable: ${platform}-${arch}`);
  const staged = new Set();
  async function stage(name) {
    if (staged.has(name)) return;
    const directory = path.join(rootDirectory, "node_modules", name);
    const packageJson = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    const locked = lock.packages[`node_modules/${name}`];
    if (
      locked?.version !== packageJson.version ||
      !locked.integrity ||
      !locked.resolved?.startsWith("https://registry.npmjs.org/")
    )
      throw new Error(`Unverified storage writer dependency: ${name}`);
    staged.add(name);
    const destination = path.join(appDirectory, "node_modules", name);
    await mkdir(destination, { recursive: true });
    if (name === nativeName) {
      for (const entry of [
        "index.js",
        "binding.js",
        "package.json",
        "LICENSE",
        prebuild,
      ]) {
        await mkdir(path.dirname(path.join(destination, entry)), {
          recursive: true,
        });
        await cp(path.join(directory, entry), path.join(destination, entry));
      }
    } else {
      for (const entry of await readdir(directory)) {
        if (["node_modules", "prebuilds", "test", "tests"].includes(entry))
          continue;
        await cp(path.join(directory, entry), path.join(destination, entry), {
          recursive: true,
        });
      }
    }
    const licenseDirectory = path.join(appDirectory, "licenses");
    await mkdir(licenseDirectory, { recursive: true });
    await cp(
      path.join(directory, "LICENSE"),
      path.join(licenseDirectory, `${name.replaceAll("/", "-")}.txt`),
    );
    for (const dependency of Object.keys(packageJson.dependencies ?? {}))
      await stage(dependency);
  }
  await stage(nativeName);
  return {
    version: manifest.version,
    platform,
    arch,
    packages: [...staged].sort(),
    prebuild,
  };
}
