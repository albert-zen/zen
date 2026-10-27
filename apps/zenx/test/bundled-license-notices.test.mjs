import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bundledLicenseNotices,
  collectBundledLicenseNotices,
} from "../scripts/bundled-license-notices.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-license-notices-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "LICENSE"), "repository grant\n");
  async function add(name, files = { LICENSE: "synthetic upstream grant\n" }) {
    const directory = path.join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name, version: "1.2.3", license: "MIT" }),
    );
    for (const [filename, source] of Object.entries(files)) {
      await writeFile(path.join(directory, filename), source);
    }
    return path.join(directory, "index.js");
  }
  return { root, add };
}

test("emits complete notices only for actually rendered npm modules", async (t) => {
  const { root, add } = await fixture(t);
  const used = await add("@example/used", {
    "LICENSE-MIT": "full synthetic grant\n",
    "NOTICE.txt": "upstream attribution\n",
    "README.md": "not a notice",
  });
  const treeShaken = await add("unused", {});
  const plugin = bundledLicenseNotices({ rootDirectory: root });
  const emitted = [];
  await plugin.generateBundle.call(
    { emitFile: (asset) => emitted.push(asset) },
    {},
    {
      "main.js": {
        type: "chunk",
        modules: {
          [used]: { renderedLength: 3 },
          [`${used}?commonjs-proxy`]: { renderedLength: 1 },
          [treeShaken]: { renderedLength: 0 },
          [path.join(root, "src", "main.ts")]: { renderedLength: 20 },
          "\0virtual-module": { renderedLength: 1 },
        },
      },
      "image.png": { type: "asset" },
    },
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].fileName, "THIRD_PARTY_NOTICES.txt");
  assert.equal(emitted[0].source.split("@example/used@1.2.3").length, 2);
  assert.match(emitted[0].source, /full synthetic grant/);
  assert.match(emitted[0].source, /upstream attribution/);
  assert.equal(emitted[0].source.includes("unused"), false);
  assert.equal(emitted[0].source.includes(root), false);
  assert.equal(emitted[0].source.includes("not a notice"), false);
});

test("fails on missing or empty license text instead of inventing an SPDX grant", async (t) => {
  const { root, add } = await fixture(t);
  for (const [name, files, message] of [
    ["missing", {}, /no license\/notice file/],
    ["empty", { LICENSE: "\n" }, /empty LICENSE/],
  ]) {
    await assert.rejects(
      collectBundledLicenseNotices([await add(name, files)], {
        rootDirectory: root,
      }),
      message,
    );
  }
});

test("uses repository license only for an actual own workspace symlink", async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, "packages", "zenx-example");
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, "package.json"),
    JSON.stringify({ name: "@zenx/example", version: "1" }),
  );
  const link = path.join(root, "node_modules", "@zenx", "example");
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  const text = await collectBundledLicenseNotices(
    [path.join(link, "index.js")],
    { rootDirectory: root },
  );
  assert.match(text, /repository grant/);
  assert.match(text, /@zenx\/example@1/);
});

test("sorts and deduplicates package notices independently of module order", async (t) => {
  const { root, add } = await fixture(t);
  const a = await add("a");
  const b = await add("b");
  const options = { rootDirectory: root };
  assert.equal(
    await collectBundledLicenseNotices([b, a, b], options),
    await collectBundledLicenseNotices([a, b], options),
  );
});

test("retained upstream notice requires exact reviewed lock integrity and bytes", async (t) => {
  const { root, add } = await fixture(t);
  const module = await add("react-remove-scroll-bar", {});
  const packageFile = path.join(path.dirname(module), "package.json");
  await writeFile(
    packageFile,
    JSON.stringify({
      name: "react-remove-scroll-bar",
      version: "2.3.8",
      license: "MIT",
    }),
  );
  const lock = {
    packages: {
      "node_modules/react-remove-scroll-bar": {
        version: "2.3.8",
        integrity:
          "sha512-9r+yi9+mgU33AKcj6IbT9oRCO78WriSj6t/cF8DWBZJ9aOGPOTEDvdUDz1FwKim7QXWwmHqtdHnRJfhAxEG46Q==",
      },
    },
  };
  const lockFile = path.join(root, "package-lock.json");
  await writeFile(lockFile, JSON.stringify(lock));
  const notice = path.join(
    root,
    "apps/zenx/resources/licenses/react-remove-scroll-bar-2.3.8/LICENSE",
  );
  await mkdir(path.dirname(notice), { recursive: true });
  const { readFile } = await import("node:fs/promises");
  await writeFile(
    notice,
    await readFile(
      new URL(
        "../resources/licenses/react-remove-scroll-bar-2.3.8/LICENSE",
        import.meta.url,
      ),
    ),
  );
  const options = { rootDirectory: root };
  const output = await collectBundledLicenseNotices([module], options);
  assert.match(output, /Copyright \(c\) 2025 Anton Korzunov/);
  assert.match(output, /Permission is hereby granted/);
  lock.packages["node_modules/react-remove-scroll-bar"].integrity = "changed";
  await writeFile(lockFile, JSON.stringify(lock));
  await assert.rejects(
    collectBundledLicenseNotices([module], options),
    /does not match locked dependency/,
  );
  lock.packages["node_modules/react-remove-scroll-bar"].integrity =
    "sha512-9r+yi9+mgU33AKcj6IbT9oRCO78WriSj6t/cF8DWBZJ9aOGPOTEDvdUDz1FwKim7QXWwmHqtdHnRJfhAxEG46Q==";
  await writeFile(lockFile, JSON.stringify(lock));
  await writeFile(notice, "different license");
  await assert.rejects(
    collectBundledLicenseNotices([module], options),
    /digest mismatch/,
  );
});
