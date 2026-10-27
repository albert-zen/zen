import { readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const retainedNotice = {
  identity: "react-remove-scroll-bar@2.3.8",
  integrity:
    "sha512-9r+yi9+mgU33AKcj6IbT9oRCO78WriSj6t/cF8DWBZJ9aOGPOTEDvdUDz1FwKim7QXWwmHqtdHnRJfhAxEG46Q==",
  sha256: "a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84",
};
const noticeName = /^(?:licen[cs]e|copying|notice)(?:[.-].+)?$/iu;

/** Retain upstream notices for the npm modules actually rendered by Rollup. */
export function bundledLicenseNotices(options = {}) {
  return {
    name: "zenx-bundled-license-notices",
    async generateBundle(_output, bundle) {
      const modules = new Set();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, metadata] of Object.entries(output.modules)) {
          if (metadata.renderedLength > 0) modules.add(id);
        }
      }
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.txt",
        source: await collectBundledLicenseNotices([...modules], options),
      });
    },
  };
}

export async function collectBundledLicenseNotices(
  moduleIds,
  { rootDirectory = repositoryRoot } = {},
) {
  const directories = new Set();
  for (const id of moduleIds) {
    if (id.startsWith("\0")) continue;
    const filename = id.split("?")[0];
    if (!path.isAbsolute(filename)) continue;
    const components = filename.replaceAll("\\", "/").split("/");
    const index = components.lastIndexOf("node_modules");
    if (index < 0) continue;
    const packageName = components[index + 1];
    if (!packageName || packageName.startsWith(".")) {
      throw new Error("Bundled module has an unsupported npm package path");
    }
    const end = index + (packageName.startsWith("@") ? 3 : 2);
    if (components.length <= end) {
      throw new Error("Bundled module has an incomplete npm package path");
    }
    directories.add(await realpath(components.slice(0, end).join("/")));
  }
  const records = [];
  for (const directory of [...directories].sort()) {
    const manifest = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    if (
      typeof manifest.name !== "string" ||
      !manifest.name ||
      typeof manifest.version !== "string" ||
      !manifest.version
    ) {
      throw new Error("Bundled npm package lacks name/version metadata");
    }
    const identity = `${manifest.name}@${manifest.version}`;
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && noticeName.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const notices = [];
    for (const file of files) {
      const source = await readFile(path.join(directory, file), "utf8");
      if (!source.trim()) {
        throw new Error(`Bundled dependency ${identity} has an empty ${file}`);
      }
      notices.push(`--- ${file} ---\n${source.trimEnd()}`);
    }
    if (notices.length === 0 && identity === retainedNotice.identity) {
      const lock = JSON.parse(
        await readFile(path.join(rootDirectory, "package-lock.json"), "utf8"),
      );
      const entry = lock.packages?.[`node_modules/${manifest.name}`];
      if (
        manifest.license !== "MIT" ||
        entry?.version !== manifest.version ||
        entry?.integrity !== retainedNotice.integrity
      ) {
        throw new Error(
          `Retained license does not match locked dependency ${identity}`,
        );
      }
      const source = await readFile(
        path.join(
          rootDirectory,
          "apps",
          "zenx",
          "resources",
          "licenses",
          "react-remove-scroll-bar-2.3.8",
          "LICENSE",
        ),
      );
      if (
        createHash("sha256").update(source).digest("hex") !==
        retainedNotice.sha256
      ) {
        throw new Error(`Retained license digest mismatch for ${identity}`);
      }
      notices.push(
        `--- upstream LICENSE (retained for exact npm archive) ---\n${source.toString("utf8").trimEnd()}`,
      );
    }
    if (notices.length === 0) {
      const relative = path.relative(await realpath(rootDirectory), directory);
      const ownWorkspace =
        /^@zenx?\//u.test(manifest.name) &&
        relative.startsWith(`packages${path.sep}`) &&
        !relative.split(path.sep).includes("node_modules");
      if (!ownWorkspace) {
        throw new Error(
          `Bundled dependency ${identity} has no license/notice file`,
        );
      }
      const source = await readFile(
        path.join(rootDirectory, "LICENSE"),
        "utf8",
      );
      if (!source.trim()) throw new Error("Repository LICENSE is empty");
      notices.push(`--- repository LICENSE ---\n${source.trimEnd()}`);
    }
    records.push({
      identity,
      text: `${identity}\nDeclared license: ${JSON.stringify(manifest.license ?? null)}\n\n${notices.join("\n\n")}`,
    });
  }
  records.sort((a, b) =>
    a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0,
  );
  return `ZenX bundled npm dependency notices\n\nReproduced from the exact installed packages used by this build.\nPackage metadata is descriptive, not an additional license grant.\n\n${records.map((entry) => entry.text).join("\n\n========================================\n\n")}\n`;
}
