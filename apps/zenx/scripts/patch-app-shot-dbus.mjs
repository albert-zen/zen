/*
 * AppShot's transport-only patch follows T3 Code, without Unix FD passing.
 * dbus-next 0.10.2 source (tag v0.10.2, commit pinned below):
 * https://github.com/dbusjs/node-dbus-next/tree/3d8856c3cd15b7726d9cdea4c100874b99af972a
 * T3 Code patch (comments retained so the reviewed Git blob matches exactly):
 * https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/patches/dbus-next%400.10.2.patch
 * Preserve dbus-next's LICENSE when staging the dependency.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export const APP_SHOT_DBUS_PATCH = Object.freeze({
  version: "0.10.2",
  sourceCommit: "3d8856c3cd15b7726d9cdea4c100874b99af972a",
  t3Commit: "337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17",
  originalConnectionBlob: "780dc041c58e83ebfcd84434e500ec471020813a",
  patchedConnectionBlob: "6b5c02dac6e48b344c4a16defdf1709e8145109b",
  originalManifestBlob: "a396df1298b9c3d2f2faad33563c3cdded50281e",
  patchedManifestBlob: "9a41e7d142aaf1d6ce20c2faa89a6f342e0e7556",
});

const CONNECTION_BEFORE = [
  "          if (params.abstract) {",
  "            const usocket = require('usocket');",
  "            const sock = new usocket.USocket({ path: '\\u0000' + params.abstract });",
  "            sock.supportsUnixFd = negotiateUnixFd;",
  "            return sock;",
  "          }",
  "          if (params.path) {",
  "            try {",
  "              const usocket = require('usocket');",
  "              const sock = new usocket.USocket({ path: params.path });",
  "              sock.supportsUnixFd = negotiateUnixFd;",
  "              return sock;",
  "            } catch (err) {",
  "              // TODO: maybe emit warning?",
  "              return net.createConnection(params.path);",
  "            }",
  "          }",
  "",
].join("\n");

const CONNECTION_AFTER = [
  "          // T3 Code never passes Unix descriptors, so usocket is not installed.",
  "          // Node connects to both path and abstract sockets natively.",
  "          if (params.abstract) {",
  "            return net.createConnection('\\u0000' + params.abstract);",
  "          }",
  "          if (params.path) {",
  "            return net.createConnection(params.path);",
  "          }",
  "",
].join("\n");

export function dbusBlobHash(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8");
  return createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
}

async function assertDirectory(directory) {
  const entry = await lstat(directory);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error(
      "Refusing symlinked/non-directory AppShot stage: " + directory,
    );
  }
}

async function assertDirectories(root, directory) {
  for (const candidate of [
    root,
    join(root, "node_modules"),
    directory,
    join(directory, "lib"),
  ]) {
    await assertDirectory(candidate);
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function snapshot(file) {
  const entry = await lstat(file);
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    (await realpath(file)) !== file
  ) {
    throw new Error(
      "Refusing symlinked/shared/non-regular dbus-next file: " + file,
    );
  }
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (!sameFile(entry, after) || after.isSymbolicLink() || !after.isFile()) {
    throw new Error("dbus-next file changed while reading: " + file);
  }
  return { file, entry, bytes, blob: dbusBlobHash(bytes) };
}

function plan(record, originalBlob, patchedBlob, transform) {
  if (record.blob === patchedBlob) {
    return { ...record, output: record.bytes, expected: patchedBlob };
  }
  if (record.blob !== originalBlob) {
    throw new Error(
      "Unrecognized dbus-next 0.10.2 bytes: " +
        record.file +
        " (" +
        record.blob +
        ")",
    );
  }
  const output = Buffer.from(transform(record.bytes.toString("utf8")), "utf8");
  if (dbusBlobHash(output) !== patchedBlob) {
    throw new Error(
      "dbus-next patch did not produce the reviewed blob: " + record.file,
    );
  }
  return { ...record, output, expected: patchedBlob };
}

/**
 * Patch only the explicit dependency at stagingRoot/node_modules/dbus-next.
 * The root may be a copied package stage or an installed npm runtime tree passed
 * explicitly by the caller's postinstall hook. Preserve the dependency LICENSE
 * and T3 MIT notice, and serialize access to this tree. This helper does not
 * discover installations or run itself. Only the dependency's connection.js and
 * package.json change; no root manifest, lockfile, or other package is modified.
 *
 * Both input files are checked before either is replaced. Replacements are
 * atomic per file, not a two-file transaction. An interrupted mixed state is
 * accepted only when each file independently matches its reviewed original or
 * patched blob, so rerunning safely completes that exact patch.
 */
export async function patchAppShotDbus({ stagingRoot, packageDirectory } = {}) {
  if (typeof stagingRoot !== "string" || stagingRoot.length === 0) {
    throw new Error("AppShot dbus-next patch requires an explicit stagingRoot");
  }
  const root = resolve(stagingRoot);
  const directory = resolve(
    packageDirectory ?? join(root, "node_modules", "dbus-next"),
  );
  if (directory !== join(root, "node_modules", "dbus-next")) {
    throw new Error(
      "dbus-next patch target must be stagingRoot/node_modules/dbus-next",
    );
  }
  await assertDirectories(root, directory);
  const manifest = await snapshot(join(directory, "package.json"));
  let metadata;
  try {
    metadata = JSON.parse(manifest.bytes.toString("utf8"));
  } catch {
    throw new Error("Unrecognized dbus-next package.json: invalid JSON");
  }
  if (
    metadata?.name !== "dbus-next" ||
    metadata.version !== APP_SHOT_DBUS_PATCH.version
  ) {
    throw new Error("Unaudited dbus-next package: expected dbus-next 0.10.2");
  }
  const connection = await snapshot(join(directory, "lib", "connection.js"));
  const plans = [
    plan(
      connection,
      APP_SHOT_DBUS_PATCH.originalConnectionBlob,
      APP_SHOT_DBUS_PATCH.patchedConnectionBlob,
      (source) => source.replace(CONNECTION_BEFORE, CONNECTION_AFTER),
    ),
    plan(
      manifest,
      APP_SHOT_DBUS_PATCH.originalManifestBlob,
      APP_SHOT_DBUS_PATCH.patchedManifestBlob,
      (source) => source.replace('    "usocket": "^0.3.0"\n', ""),
    ),
  ];
  const changed = plans.filter((item) => item.blob !== item.expected);
  if (changed.length === 0) return "already patched";

  const temporaryFiles = [];
  try {
    // Prepare every replacement before publishing any of them.
    for (const item of changed) {
      await assertDirectories(root, directory);
      const temporary = item.file + ".zenx-" + randomUUID();
      const handle = await open(temporary, "wx", item.entry.mode & 0o777);
      temporaryFiles.push(temporary);
      item.temporary = temporary;
      try {
        await handle.writeFile(item.output);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await snapshot(temporary)).blob !== item.expected) {
        throw new Error("dbus-next temporary patch failed verification");
      }
    }
    await assertDirectories(root, directory);
    for (const item of plans) {
      const current = await snapshot(item.file);
      if (!sameFile(item.entry, current.entry) || current.blob !== item.blob) {
        throw new Error("dbus-next stage changed before patch publication");
      }
    }
    for (const item of changed) {
      await assertDirectories(root, directory);
      const current = await snapshot(item.file);
      if (!sameFile(item.entry, current.entry) || current.blob !== item.blob) {
        throw new Error("dbus-next stage changed during patch publication");
      }
      await rename(item.temporary, item.file);
    }
    await assertDirectories(root, directory);
    for (const item of plans) {
      if ((await snapshot(item.file)).blob !== item.expected) {
        throw new Error("dbus-next published patch failed verification");
      }
    }
  } finally {
    await Promise.all(temporaryFiles.map((file) => rm(file, { force: true })));
  }
  return "patched";
}
