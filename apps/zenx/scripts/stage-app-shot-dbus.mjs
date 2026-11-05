import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  copyFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { patchAppShotDbus } from "./patch-app-shot-dbus.mjs";

export const APP_SHOT_DBUS_PACKAGES = [
  {
    path: "@nornagon/put",
    name: "@nornagon/put",
    version: "0.0.8",
  },
  {
    path: "dbus-next",
    name: "dbus-next",
    version: "0.10.2",
  },
  {
    path: "duplexer",
    name: "duplexer",
    version: "0.1.2",
  },
  {
    path: "event-stream",
    name: "event-stream",
    version: "3.3.4",
  },
  {
    path: "from",
    name: "from",
    version: "0.1.7",
  },
  {
    path: "hexy",
    name: "hexy",
    version: "0.2.11",
  },
  {
    path: "jsbi",
    name: "jsbi",
    version: "2.0.5",
  },
  {
    path: "long",
    name: "long",
    version: "4.0.0",
  },
  {
    path: "map-stream",
    name: "map-stream",
    version: "0.1.0",
  },
  {
    path: "pause-stream",
    name: "pause-stream",
    version: "0.0.11",
  },
  {
    path: "safe-buffer",
    name: "safe-buffer",
    version: "5.2.1",
  },
  {
    path: "sax",
    name: "sax",
    version: "1.6.1",
  },
  {
    path: "split",
    name: "split",
    version: "0.3.3",
  },
  {
    path: "stream-combiner",
    name: "stream-combiner",
    version: "0.0.4",
  },
  {
    path: "through",
    name: "through",
    version: "2.3.8",
  },
  {
    path: "xml2js",
    name: "xml2js",
    version: "0.4.23",
  },
  {
    path: "xml2js/node_modules/xmlbuilder",
    name: "xmlbuilder",
    version: "11.0.1",
  },
];

/** Copy only the pinned pure-JS runtime closure. Optional usocket is never staged. */
export async function stageAppShotDbus(rootDirectory, appDirectory) {
  const root = await realpath(rootDirectory);
  const app = path.resolve(appDirectory);
  if (
    app === root ||
    app.startsWith(path.join(root, "node_modules") + path.sep)
  )
    throw new Error("D-Bus staging cannot replace its installed source");
  async function directory(target) {
    await mkdir(target, { recursive: true });
    const stat = await lstat(target);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(target)) !== target
    )
      throw new Error("Unsafe D-Bus staging directory");
  }
  async function copyTree(source, target) {
    await directory(target);
    for (const item of await readdir(source, { withFileTypes: true })) {
      if (item.name === "node_modules") continue;
      const from = path.join(source, item.name);
      const to = path.join(target, item.name);
      if (item.isSymbolicLink())
        throw new Error("Symlinked D-Bus runtime file");
      if (item.isDirectory()) await copyTree(from, to);
      else if (item.isFile()) {
        if ((await lstat(from)).size > 32 * 1024 * 1024)
          throw new Error("Oversized D-Bus runtime file");
        await copyFile(from, to);
      } else throw new Error("Non-regular D-Bus runtime file");
    }
  }
  const sources = [];
  for (const entry of APP_SHOT_DBUS_PACKAGES) {
    const source = path.join(root, "node_modules", entry.path);
    if (
      (await lstat(source)).isSymbolicLink() ||
      (await realpath(source)) !== source
    )
      throw new Error("Symlinked D-Bus runtime package");
    const manifest = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    if (manifest.name !== entry.name || manifest.version !== entry.version)
      throw new Error("Unexpected D-Bus runtime dependency: " + entry.name);
    sources.push({ ...entry, source });
  }
  await directory(app);
  await directory(path.join(app, "node_modules"));
  for (const entry of sources) {
    const destination = path.join(app, "node_modules", entry.path);
    // Every segment is a reviewed package path, never renderer input.
    const relative = path
      .relative(app, path.dirname(destination))
      .split(path.sep);
    let parent = app;
    for (const segment of relative) {
      parent = path.join(parent, segment);
      await directory(parent);
    }
    await rm(destination, { recursive: true, force: true });
    await copyTree(entry.source, destination);
  }
  await patchAppShotDbus({ stagingRoot: app });
  await directory(path.join(app, "licenses"));
  const patchSource = await readFile(
    new URL("./patch-app-shot-dbus.mjs", import.meta.url),
    "utf8",
  );
  await writeFile(
    path.join(app, "licenses", "T3-App-Shot-D-Bus.txt"),
    patchSource.slice(0, patchSource.indexOf("*/") + 2) + "\n",
  );
  return APP_SHOT_DBUS_PACKAGES.map((entry) => entry.path);
}
