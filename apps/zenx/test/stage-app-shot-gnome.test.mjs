import assert from "node:assert/strict";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyGnomeAppShotResource } from "../scripts/stage-app-shot-gnome.mjs";

const runtimeFiles = [
  "metadata.json",
  "extension.js",
  "captureService.js",
  "captureFeedback.js",
  "feedbackGeometry.js",
];
const bundleFiles = [
  ...runtimeFiles,
  "bundle.json",
  "LICENSE",
  "README.md",
  "upstream.json",
];
const uuid = "app-shot@zenx.local";

async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "zenx-gnome-resource-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceDirectory = path.join(directory, "source", "app-shot-gnome");
  await mkdir(sourceDirectory, { recursive: true });
  for (const file of bundleFiles) {
    await writeFile(path.join(sourceDirectory, file), `fixture ${file}\n`);
  }
  await writeJson(sourceDirectory, "bundle.json", {
    uuid,
    files: runtimeFiles,
  });
  await writeJson(sourceDirectory, "metadata.json", {
    uuid,
    version: 3,
    "shell-version": ["45", "46", "47", "48", "49", "50", "51"],
  });
  await writeJson(sourceDirectory, "upstream.json", {
    upstream: "https://github.com/pingdotgg/t3code",
    commit: "fixture",
  });
  const buildPath = path.join(directory, "build", "resources", "app");
  return {
    directory,
    sourceDirectory,
    buildPath,
    target: "app",
    platform: "linux",
  };
}

async function writeJson(directory, file, value) {
  await writeFile(path.join(directory, file), JSON.stringify(value) + "\n");
}

test("stages the inert GNOME bundle and notices beside app, byte for byte", async (t) => {
  const options = await fixture(t);
  const destination = await copyGnomeAppShotResource(options);
  assert.equal(
    destination,
    path.join(path.dirname(options.buildPath), "app-shot-gnome"),
  );
  assert.deepEqual(
    (await readdir(destination)).sort(),
    [...bundleFiles].sort(),
  );
  for (const file of bundleFiles) {
    assert.ok((await lstat(path.join(destination, file))).isFile());
    assert.deepEqual(
      await readFile(path.join(destination, file)),
      await readFile(path.join(options.sourceDirectory, file)),
    );
  }
  await assert.rejects(access(options.buildPath), { code: "ENOENT" });
});

test("skips every non-Linux or smoke target without touching the filesystem", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const target of ["app", "smoke"]) {
      if (platform === "linux" && target === "app") continue;
      assert.equal(
        await copyGnomeAppShotResource({ platform, target }),
        undefined,
      );
    }
  }
});

test("requires every runtime, manifest, license, setup and provenance file before staging", async (t) => {
  for (const name of bundleFiles) {
    await t.test(name, async (t) => {
      const options = await fixture(t);
      await rm(path.join(options.sourceDirectory, name));
      await assert.rejects(
        copyGnomeAppShotResource(options),
        /fixed distribution files/u,
      );
      await assert.rejects(access(path.dirname(options.buildPath)), {
        code: "ENOENT",
      });
    });
  }
});

test("rejects malformed or extensible bundle manifests and never follows manifest paths", async (t) => {
  const cases = [
    null,
    [],
    { uuid, files: runtimeFiles, install: "anything" },
    { uuid: "another@extension.local", files: runtimeFiles },
    { uuid, files: runtimeFiles.slice(1) },
    { uuid, files: [...runtimeFiles, "LICENSE"] },
    { uuid, files: [...runtimeFiles.slice(0, -1), runtimeFiles[0]] },
    { uuid, files: [...runtimeFiles.slice(0, -1), "../outside.js"] },
    { uuid, files: [...runtimeFiles.slice(0, -1), "/outside.js"] },
    { uuid, files: [...runtimeFiles.slice(0, -1), "..\\outside.js"] },
    { uuid, files: { ...runtimeFiles } },
  ];
  for (const [index, manifest] of cases.entries()) {
    await t.test(`invalid manifest ${index}`, async (t) => {
      const options = await fixture(t);
      await writeJson(options.sourceDirectory, "bundle.json", manifest);
      await assert.rejects(
        copyGnomeAppShotResource(options),
        /bundle manifest/u,
      );
      await assert.rejects(access(path.dirname(options.buildPath)), {
        code: "ENOENT",
      });
    });
  }
  const options = await fixture(t);
  await writeFile(
    path.join(options.sourceDirectory, "bundle.json"),
    "invalid json",
  );
  await assert.rejects(copyGnomeAppShotResource(options), SyntaxError);
});

test("requires the reviewed metadata UUID and integer version", async (t) => {
  for (const metadata of [
    null,
    {},
    { uuid: "other", version: 3 },
    ...[2, 4, "3", 3.5].map((version) => ({ uuid, version })),
  ]) {
    await t.test(JSON.stringify(metadata), async (t) => {
      const options = await fixture(t);
      await writeJson(options.sourceDirectory, "metadata.json", metadata);
      await assert.rejects(
        copyGnomeAppShotResource(options),
        /metadata requires/u,
      );
      await assert.rejects(access(path.dirname(options.buildPath)), {
        code: "ENOENT",
      });
    });
  }
});

test("rejects empty, oversized and non-regular bundle files before staging", async (t) => {
  for (const kind of ["empty", "oversized", "directory"]) {
    await t.test(kind, async (t) => {
      const options = await fixture(t);
      const file = path.join(options.sourceDirectory, "captureService.js");
      if (kind === "directory") {
        await rm(file);
        await mkdir(file);
      } else {
        await writeFile(
          file,
          kind === "empty" ? "" : Buffer.alloc(1024 * 1024 + 1),
        );
      }
      await assert.rejects(
        copyGnomeAppShotResource(options),
        /Invalid GNOME App Shot resource file/u,
      );
      await assert.rejects(access(path.dirname(options.buildPath)), {
        code: "ENOENT",
      });
    });
  }
});

test("rejects unlisted source entries instead of distributing extra code", async (t) => {
  const options = await fixture(t);
  await writeFile(path.join(options.sourceDirectory, "extra.js"), "unexpected");
  await assert.rejects(
    copyGnomeAppShotResource(options),
    /fixed distribution files/u,
  );
});

async function link(t, source, destination, type) {
  try {
    await symlink(source, destination, type);
    return true;
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    t.skip("Symlink creation requires unavailable Windows privileges");
    return false;
  }
}

test("rejects symlinked runtime and notice files without reading or changing their targets", async (t) => {
  for (const name of [
    "extension.js",
    "bundle.json",
    "LICENSE",
    "README.md",
    "upstream.json",
  ]) {
    await t.test(name, async (t) => {
      const options = await fixture(t);
      const outside = path.join(options.directory, "outside");
      const sentinel = "keep this outside data";
      await writeFile(outside, sentinel);
      const sourceFile = path.join(options.sourceDirectory, name);
      await rm(sourceFile);
      if (!(await link(t, outside, sourceFile, "file"))) return;
      await assert.rejects(
        copyGnomeAppShotResource(options),
        /Invalid GNOME App Shot resource file/u,
      );
      assert.equal(await readFile(outside, "utf8"), sentinel);
      await assert.rejects(access(path.dirname(options.buildPath)), {
        code: "ENOENT",
      });
    });
  }
});

test("rejects symlinked source directories and parents", async (t) => {
  for (const parent of [false, true]) {
    await t.test(parent ? "source parent" : "source directory", async (t) => {
      const options = await fixture(t);
      const linked = path.join(options.directory, "linked");
      if (
        !(await link(
          t,
          parent
            ? path.dirname(options.sourceDirectory)
            : options.sourceDirectory,
          linked,
          "junction",
        ))
      )
        return;
      await assert.rejects(
        copyGnomeAppShotResource({
          ...options,
          sourceDirectory: parent
            ? path.join(linked, "app-shot-gnome")
            : linked,
        }),
        /Unsafe GNOME App Shot source directory/u,
      );
    });
  }
});

test("refuses existing destinations without overwriting or merging files", async (t) => {
  const options = await fixture(t);
  const destination = path.join(
    path.dirname(options.buildPath),
    "app-shot-gnome",
  );
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "sentinel"), "original");
  await assert.rejects(copyGnomeAppShotResource(options), { code: "EEXIST" });
  assert.deepEqual(await readdir(destination), ["sentinel"]);
  assert.equal(
    await readFile(path.join(destination, "sentinel"), "utf8"),
    "original",
  );
});

test("rejects symlinked destination bundles, resources and ancestors without writing through them", async (t) => {
  for (const location of ["bundle", "resources", "parent"]) {
    await t.test(location, async (t) => {
      const options = await fixture(t);
      const outside = path.join(options.directory, "outside");
      await mkdir(outside);
      const resources = path.dirname(options.buildPath);
      const destination =
        location === "bundle"
          ? path.join(resources, "app-shot-gnome")
          : location === "resources"
            ? resources
            : path.dirname(resources);
      await mkdir(path.dirname(destination), { recursive: true });
      if (!(await link(t, outside, destination, "junction"))) return;
      await assert.rejects(copyGnomeAppShotResource(options));
      assert.deepEqual(await readdir(outside), []);
    });
  }
});

test("cannot stage into or over its own source", async (t) => {
  const options = await fixture(t);
  for (const buildPath of [
    path.join(path.dirname(options.sourceDirectory), "app"),
    path.join(options.sourceDirectory, "nested", "app"),
  ]) {
    await assert.rejects(
      copyGnomeAppShotResource({ ...options, buildPath }),
      /must not overlap/u,
    );
  }
  assert.deepEqual(
    (await readdir(options.sourceDirectory)).sort(),
    [...bundleFiles].sort(),
  );
});
