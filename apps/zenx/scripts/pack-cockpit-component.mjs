import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { npmInvocation } from "../../../packages/zenx-plugin-sdk/src/npm-invocation.mjs";

// Produce a self-contained standard tarball before the public SDK is published.
// All staging stays in the caller's artifact directory for inspection.
const output = process.argv[2];
if (!output)
  throw new Error(
    "Usage: node apps/zenx/scripts/pack-cockpit-component.mjs <artifact-directory>",
  );
const root = fileURLToPath(new URL("../../../", import.meta.url));
const destination = path.resolve(output);
await mkdir(destination, { recursive: true });
const staging = await mkdtemp(path.join(destination, "cockpit-plugin-source-"));
await cp(path.join(root, "examples/cockpit-component"), staging, {
  recursive: true,
  filter: (source) => path.basename(source) !== "node_modules",
});
await cp(
  path.join(root, "packages/zenx-plugin-sdk/dist"),
  path.join(staging, "sdk"),
  { recursive: true },
);
const packagePath = path.join(staging, "package.json");
const metadata = JSON.parse(await readFile(packagePath, "utf8"));
delete metadata.dependencies;
metadata.files.push("sdk");
await writeFile(packagePath, JSON.stringify(metadata, null, 2) + "\n");
const runtimePath = path.join(staging, "runtime.mjs");
await writeFile(
  runtimePath,
  (await readFile(runtimePath, "utf8")).replace(
    '"@zenx/plugin-sdk"',
    '"./sdk/runtime.js"',
  ),
);
const run = promisify(execFile);
await run(process.execPath, [
  path.join(root, "packages/zenx-plugin-sdk/dist/cli.js"),
  "validate",
  staging,
]);
const npm = npmInvocation(["pack", "--json"]);
const result = await run(npm.executable, npm.args, { cwd: staging });
const filename = JSON.parse(result.stdout)[0].filename;
const tarball = path.join(destination, filename);
await rename(path.join(staging, filename), tarball);
console.log(JSON.stringify({ tarball, source: staging }));
