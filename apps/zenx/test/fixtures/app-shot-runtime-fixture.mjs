import { fileURLToPath } from "node:url";
import { stageAppShotDbus } from "../../scripts/stage-app-shot-dbus.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appShotRuntimePackages } from "../../scripts/stage-app-shot-runtime.mjs";

/** Synthetic package layout only. The .node bytes are deliberately not executable. */
export async function writeAppShotRuntimeFixture(
  rootDirectory,
  { nested = false, licenses = true } = {},
) {
  const plans = new Map();
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const arch of ["x64", "arm64"]) {
      for (const entry of appShotRuntimePackages(platform, arch, {
        libc: "glibc",
      })) {
        if (!plans.has(entry.name)) {
          plans.set(entry.name, {
            ...entry,
            platform,
            arch,
            optionalDependencies: {},
          });
        }
        if (entry.native)
          plans.get(entry.name).optionalDependencies[entry.native] =
            entry.version;
      }
    }
  }
  const modules = path.join(rootDirectory, "node_modules");
  const paths = new Map();
  for (const entry of plans.values()) {
    const directory =
      nested && entry.parent
        ? path.join(modules, entry.parent, "node_modules", entry.name)
        : path.join(modules, entry.name);
    paths.set(entry.name, directory);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: entry.name,
        version: entry.version,
        main: entry.main,
        license: "MIT",
        ...(entry.parent
          ? { os: [entry.platform], cpu: [entry.arch] }
          : { optionalDependencies: entry.optionalDependencies }),
      }),
    );
    for (const file of entry.files)
      await writeFile(
        path.join(directory, file),
        "synthetic fixture; not native code",
      );
    if (licenses)
      await writeFile(
        path.join(directory, "LICENSE"),
        `Synthetic license for ${entry.name}\n`,
      );
  }
  if (process.platform === "linux") {
    const repository = fileURLToPath(new URL("../../../../", import.meta.url));
    await stageAppShotDbus(repository, rootDirectory);
  }
  return paths;
}
