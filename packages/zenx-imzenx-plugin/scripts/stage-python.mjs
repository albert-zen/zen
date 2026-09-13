import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("../../../apps/imzen/", import.meta.url));
const target = fileURLToPath(new URL("../python/", import.meta.url));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const name of ["src", "pyproject.toml", "uv.lock", "README.md"]) {
  await cp(`${source}/${name}`, `${target}/${name}`, {
    recursive: true,
    filter: (name) => !name.includes("__pycache__"),
  });
}
