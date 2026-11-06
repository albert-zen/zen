/*
 * Exact dbus-next 0.10.2 fixture bytes, not an installed dependency or real bus.
 * Source tag v0.10.2, commit 3d8856c3cd15b7726d9cdea4c100874b99af972a:
 * https://github.com/dbusjs/node-dbus-next/blob/3d8856c3cd15b7726d9cdea4c100874b99af972a/lib/connection.js
 * https://github.com/dbusjs/node-dbus-next/blob/3d8856c3cd15b7726d9cdea4c100874b99af972a/package.json
 *
 * This software is released under the MIT license:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  APP_SHOT_DBUS_PATCH,
  dbusBlobHash,
  patchAppShotDbus,
} from "../scripts/patch-app-shot-dbus.mjs";

const originalConnection = [
  "const EventEmitter = require('events').EventEmitter;",
  "const net = require('net');",
  "const message = require('./message');",
  "const clientHandshake = require('./handshake');",
  "const { getDbusAddressFromFs } = require('./address-x11');",
  "const { Message } = require('./message-type');",
  "const { messageToJsFmt, marshallMessage } = require('./marshall-compat');",
  "",
  "function createStream (opts) {",
  "  let { busAddress, negotiateUnixFd } = opts;",
  "",
  "  if (negotiateUnixFd === undefined) {",
  "    negotiateUnixFd = false;",
  "  }",
  "",
  "  // TODO according to the dbus spec, we should start a new server if the bus",
  "  // address cannot be found.",
  "  if (!busAddress) {",
  "    busAddress = process.env.DBUS_SESSION_BUS_ADDRESS;",
  "  }",
  "  if (!busAddress) {",
  "    busAddress = getDbusAddressFromFs();",
  "  }",
  "",
  "  const addresses = busAddress.split(';');",
  "  for (let i = 0; i < addresses.length; ++i) {",
  "    const address = addresses[i];",
  "    const familyParams = address.split(':');",
  "    const family = familyParams[0];",
  "    const params = {};",
  "    familyParams[1].split(',').forEach(function (p) {",
  "      const keyVal = p.split('=');",
  "      params[keyVal[0]] = keyVal[1];",
  "    });",
  "",
  "    try {",
  "      switch (family.toLowerCase()) {",
  "        case 'tcp': {",
  "          const host = params.host || 'localhost';",
  "          const port = params.port;",
  "          return net.createConnection(port, host);",
  "        }",
  "        case 'unix': {",
  "          if (params.socket) {",
  "            return net.createConnection(params.socket);",
  "          }",
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
  "          throw new Error(",
  "            \"not enough parameters for 'unix' connection - you need to specify 'socket' or 'abstract' or 'path' parameter\"",
  "          );",
  "        }",
  "        case 'unixexec': {",
  "          const eventStream = require('event-stream');",
  "          const spawn = require('child_process').spawn;",
  "          const args = [];",
  "          for (let n = 1; params['arg' + n]; n++) args.push(params['arg' + n]);",
  "          const child = spawn(params.path, args);",
  "          // duplex socket is auto connected so emit connect event next frame",
  "          setTimeout(() => eventStream.emit('connected'), 0);",
  "",
  "          return eventStream.duplex(child.stdin, child.stdout);",
  "        }",
  "        default: {",
  "          throw new Error('unknown address type:' + family);",
  "        }",
  "      }",
  "    } catch (e) {",
  "      if (i < addresses.length - 1) {",
  "        console.warn(e.message);",
  "        continue;",
  "      } else {",
  "        throw e;",
  "      }",
  "    }",
  "  }",
  "}",
  "",
  "function createConnection (opts) {",
  "  const self = new EventEmitter();",
  "  opts = opts || {};",
  "  const stream = (self.stream = createStream(opts));",
  "  stream.setNoDelay && stream.setNoDelay();",
  "",
  "  stream.on('error', function (err) {",
  "    // forward network and stream errors",
  "    self.emit('error', err);",
  "  });",
  "",
  "  stream.on('end', function () {",
  "    self.emit('end');",
  "    self.message = function () {",
  "      self.emit('error', new Error('Tried to write a message to a closed stream'));",
  "    };",
  "  });",
  "",
  "  self.end = function () {",
  "    stream.end();",
  "    return self;",
  "  };",
  "",
  "  function afterHandshake (error, guid) {",
  "    if (error) {",
  "      return self.emit('error', error);",
  "    }",
  "    self.guid = guid;",
  "    self.emit('connect');",
  "    message.unmarshalMessages(",
  "      stream,",
  "      function (message) {",
  "        try {",
  "          message = new Message(messageToJsFmt(message));",
  "        } catch (err) {",
  "          self.emit('error', err, `There was an error receiving a message (this is probably a bug in dbus-next): ${message}`);",
  "          return;",
  "        }",
  "        self.emit('message', message);",
  "      },",
  "      opts",
  "    );",
  "  }",
  "  stream.once('connect', () => clientHandshake(stream, opts, afterHandshake));",
  "  stream.once('connected', () => clientHandshake(stream, opts, afterHandshake));",
  "",
  "  self._messages = [];",
  "",
  "  // pre-connect version, buffers all messages. replaced after connect",
  "  self.message = function (msg) {",
  "    self._messages.push(msg);",
  "  };",
  "",
  "  self.once('connect', function () {",
  "    self.state = 'connected';",
  "    for (let i = 0; i < self._messages.length; ++i) {",
  "      const [data, fds] = marshallMessage(self._messages[i]);",
  "      if (stream.supportsUnixFd) {",
  "        stream.write({ data, fds });",
  "      } else {",
  "        stream.write(data);",
  "      }",
  "    }",
  "    self._messages.length = 0;",
  "",
  "    // no need to buffer once connected",
  "    self.message = function (msg) {",
  "      if (!stream.writable) {",
  "        throw new Error('Cannot send message, stream is closed');",
  "      }",
  "      const [data, fds] = marshallMessage(msg);",
  "      if (stream.supportsUnixFd) {",
  "        stream.write({ data, fds });",
  "      } else {",
  "        if (fds.length > 0) {",
  "          console.warn('Sending file descriptors is not supported in current bus connection');",
  "        }",
  "        stream.write(data);",
  "      }",
  "    };",
  "  });",
  "",
  "  return self;",
  "}",
  "",
  "module.exports = createConnection;",
  "",
].join("\n");

const originalManifest = [
  "{",
  '  "name": "dbus-next",',
  '  "version": "0.10.2",',
  '  "keywords": [',
  '    "dbus",',
  '    "dcop",',
  '    "d-bus",',
  '    "rpc",',
  '    "gnome",',
  '    "kde"',
  "  ],",
  '  "description": "The next great DBus library for Node",',
  '  "files": [',
  '    "lib/*",',
  '    "index.js",',
  '    "package.json",',
  '    "types.d.ts"',
  "  ],",
  '  "directories": {',
  '    "lib": "lib",',
  '    "test": "test",',
  '    "examples": "examples"',
  "  },",
  '  "main": "index.js",',
  '  "types": "types.d.ts",',
  '  "maintainers": [',
  "    {",
  '      "name": "Tony Crisci",',
  '      "email": "tony@dubstepdish.com"',
  "    }",
  "  ],",
  '  "license": "MIT",',
  '  "repository": {',
  '    "type": "git",',
  '    "url": "http://github.com/dbusjs/node-dbus-next.git"',
  "  },",
  '  "dependencies": {',
  '    "event-stream": "3.3.4",',
  '    "hexy": "^0.2.10",',
  '    "jsbi": "^2.0.5",',
  '    "long": "^4.0.0",',
  '    "@nornagon/put": "0.0.8",',
  '    "safe-buffer": "^5.1.1",',
  '    "xml2js": "^0.4.17"',
  "  },",
  '  "optionalDependencies": {',
  '    "usocket": "^0.3.0"',
  "  },",
  '  "devDependencies": {',
  '    "@babel/core": "^7.1.5",',
  '    "@babel/plugin-proposal-class-properties": "^7.1.0",',
  '    "@babel/plugin-proposal-decorators": "^7.1.2",',
  '    "@babel/plugin-syntax-bigint": "^7.2.0",',
  '    "@babel/plugin-transform-async-to-generator": "^7.3.4",',
  '    "babel-core": "^7.0.0-bridge.0",',
  '    "babel-eslint": "^10.1.0",',
  '    "babel-jest": "^26.6.3",',
  '    "babel-plugin-syntax-async-functions": "^6.13.0",',
  '    "babel-plugin-transform-async-to-generator": "^6.24.1",',
  '    "commander": "^2.19.0",',
  '    "handlebars": "^4.1.0",',
  '    "jest": "^24.1.0",',
  '    "jsdoc": "^3.6.3",',
  '    "semistandard": "^16.0.0"',
  "  },",
  '  "scripts": {',
  '    "integration": "dbus-run-session -- jest ./test/integration",',
  '    "coverage": "dbus-run-session -- jest --coverage",',
  '    "unit": "jest ./test/*.test.js",',
  '    "test": "dbus-run-session -- jest",',
  '    "doc": "jsdoc --verbose -c jsdoc.conf --readme README.md -r lib index.js -d doc",',
  '    "format": "cd lib && semistandard --global BigInt --fix && cd ../test && semistandard --env jest --parser babel-eslint --global BigInt --fix"',
  "  },",
  '  "jest": {',
  '    "testEnvironment": "node",',
  '    "bail": true',
  "  },",
  '  "standard": {',
  '    "parser": "babel-eslint",',
  '    "globals": [',
  '      "BigInt"',
  "    ]",
  "  },",
  '  "engine": {',
  '    "node": ">=6.3.0"',
  "  }",
  "}",
  "",
].join("\n");

const preservedLicense =
  "The staged upstream MIT license must remain untouched.\n";

async function fixture(t) {
  // realpath avoids platform temp aliases such as macOS /var -> /private/var.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zenx-dbus-patch-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const stagingRoot = join(root, "stage");
  const packageDirectory = join(stagingRoot, "node_modules", "dbus-next");
  const connection = join(packageDirectory, "lib", "connection.js");
  const manifest = join(packageDirectory, "package.json");
  await mkdir(dirname(connection), { recursive: true });
  await writeFile(connection, originalConnection);
  await writeFile(manifest, originalManifest);
  await writeFile(join(packageDirectory, "LICENSE"), preservedLicense);
  await writeFile(join(packageDirectory, "CHANGELOG.md"), "Keep this file.\n");
  await writeFile(
    join(root, "package.json"),
    '{"name":"unrelated-checkout"}\n',
  );
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  return { root, stagingRoot, packageDirectory, connection, manifest };
}

async function assertPatched(f) {
  assert.equal(
    dbusBlobHash(await readFile(f.connection)),
    APP_SHOT_DBUS_PATCH.patchedConnectionBlob,
  );
  assert.equal(
    dbusBlobHash(await readFile(f.manifest)),
    APP_SHOT_DBUS_PATCH.patchedManifestBlob,
  );
  for (const directory of [f.packageDirectory, dirname(f.connection)]) {
    assert.equal(
      (await readdir(directory)).some((name) => name.includes(".zenx-")),
      false,
    );
  }
}

test("fixtures pin the exact upstream Git blobs and version", () => {
  assert.equal(
    dbusBlobHash(originalConnection),
    APP_SHOT_DBUS_PATCH.originalConnectionBlob,
  );
  assert.equal(
    dbusBlobHash(originalManifest),
    APP_SHOT_DBUS_PATCH.originalManifestBlob,
  );
  assert.equal(JSON.parse(originalManifest).version, "0.10.2");
  assert.equal(
    dbusBlobHash("é"),
    dbusBlobHash(Buffer.from("é", "utf8")),
    "Git blob lengths count UTF-8 bytes rather than JavaScript characters",
  );
});

test("copied dependency receives exactly T3's two reviewed blobs", async (t) => {
  const f = await fixture(t);
  assert.equal(await patchAppShotDbus(f), "patched");
  await assertPatched(f);
  const metadata = JSON.parse(await readFile(f.manifest, "utf8"));
  assert.deepEqual(metadata.optionalDependencies, {});
  assert.equal(
    await readFile(join(f.packageDirectory, "LICENSE"), "utf8"),
    preservedLicense,
  );
  assert.equal(
    await readFile(join(f.packageDirectory, "CHANGELOG.md"), "utf8"),
    "Keep this file.\n",
  );
  assert.equal(
    await readFile(join(f.root, "package.json"), "utf8"),
    '{"name":"unrelated-checkout"}\n',
  );
  assert.equal(
    await readFile(join(f.root, "package-lock.json"), "utf8"),
    '{"lockfileVersion":3}\n',
  );
});

test("already-patched files are idempotent without replacement", async (t) => {
  const f = await fixture(t);
  await patchAppShotDbus(f);
  const before = await Promise.all([lstat(f.connection), lstat(f.manifest)]);
  assert.equal(await patchAppShotDbus(f), "already patched");
  const after = await Promise.all([lstat(f.connection), lstat(f.manifest)]);
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(after[i].ino, before[i].ino);
    assert.equal(after[i].mtimeMs, before[i].mtimeMs);
    assert.equal(after[i].ctimeMs, before[i].ctimeMs);
  }
  await assertPatched(f);
});

for (const unpatched of ["connection", "manifest"]) {
  test("a reviewed mixed state completes safely: " + unpatched, async (t) => {
    const f = await fixture(t);
    await patchAppShotDbus(f);
    const unchanged = unpatched === "connection" ? f.manifest : f.connection;
    const before = await lstat(unchanged);
    await writeFile(
      f[unpatched],
      unpatched === "connection" ? originalConnection : originalManifest,
    );
    assert.equal(await patchAppShotDbus(f), "patched");
    assert.equal((await lstat(unchanged)).ino, before.ino);
    await assertPatched(f);
  });
}

const invalidInputs = [
  ["unknown connection", "connection", originalConnection + "\n"],
  [
    "CRLF connection",
    "connection",
    originalConnection.replaceAll("\n", "\r\n"),
  ],
  ["unknown manifest", "manifest", originalManifest + "\n"],
  ["CRLF manifest", "manifest", originalManifest.replaceAll("\n", "\r\n")],
  [
    "wrong version",
    "manifest",
    originalManifest.replace('"0.10.2"', '"0.10.3"'),
  ],
  [
    "wrong package",
    "manifest",
    originalManifest.replace('"dbus-next"', '"other"'),
  ],
  ["invalid JSON", "manifest", "{not json"],
  ["missing source", "connection", ""],
];
for (const [name, target, bytes] of invalidInputs) {
  test("rejects " + name + " before mutating either file", async (t) => {
    const f = await fixture(t);
    await writeFile(f[target], bytes);
    const before = await Promise.all([
      readFile(f.connection),
      readFile(f.manifest),
    ]);
    await assert.rejects(patchAppShotDbus(f), /Unrecognized|Unaudited/);
    assert.deepEqual(await readFile(f.connection), before[0]);
    assert.deepEqual(await readFile(f.manifest), before[1]);
    assert.deepEqual(await readdir(dirname(f.connection)), ["connection.js"]);
    assert.equal(
      (await readdir(f.packageDirectory)).some((file) =>
        file.includes(".zenx-"),
      ),
      false,
    );
  });
}

test("a patched source does not bypass unknown manifest validation", async (t) => {
  const f = await fixture(t);
  await patchAppShotDbus(f);
  const connection = await readFile(f.connection);
  await writeFile(f.manifest, originalManifest + "\n");
  await assert.rejects(patchAppShotDbus(f), /Unrecognized/);
  assert.deepEqual(await readFile(f.connection), connection);
  assert.equal(await readFile(f.manifest, "utf8"), originalManifest + "\n");
});

test("stage must be explicit and the target must be its direct dependency", async (t) => {
  const f = await fixture(t);
  await assert.rejects(patchAppShotDbus(), /explicit stagingRoot/);
  await assert.rejects(
    patchAppShotDbus({ ...f, packageDirectory: f.root }),
    /target must be/,
  );
  await assert.rejects(
    patchAppShotDbus({ ...f, packageDirectory: join(f.root, "dbus-next") }),
    /target must be/,
  );
  assert.equal(await readFile(f.connection, "utf8"), originalConnection);
  assert.equal(await readFile(f.manifest, "utf8"), originalManifest);
});

async function makeSymlink(t, target, path, type) {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("This host does not permit fixture symlinks: " + error.code);
      return false;
    }
    throw error;
  }
}

for (const target of ["connection", "manifest"]) {
  test("rejects a symlinked " + target + " before writing", async (t) => {
    const f = await fixture(t);
    const external = join(f.root, "shared-" + target);
    await copyFile(f[target], external);
    await rm(f[target]);
    if (!(await makeSymlink(t, external, f[target], "file"))) return;
    await assert.rejects(patchAppShotDbus(f), /symlinked/);
    assert.equal(
      await readFile(external, "utf8"),
      target === "connection" ? originalConnection : originalManifest,
    );
    assert.equal(await readFile(f.connection, "utf8"), originalConnection);
    assert.equal(await readFile(f.manifest, "utf8"), originalManifest);
  });
  test("rejects a non-regular " + target, async (t) => {
    const f = await fixture(t);
    await rm(f[target]);
    await mkdir(f[target]);
    await assert.rejects(patchAppShotDbus(f), /non-regular/);
  });
  test("rejects a shared hard-linked " + target, async (t) => {
    const f = await fixture(t);
    const external = join(f.root, "hard-linked-" + target);
    await link(f[target], external);
    await assert.rejects(patchAppShotDbus(f), /shared/);
    assert.equal(
      await readFile(external, "utf8"),
      target === "connection" ? originalConnection : originalManifest,
    );
  });
}

for (const target of ["stage", "modules", "package", "lib"]) {
  test("rejects a symlinked " + target + " directory", async (t) => {
    const f = await fixture(t);
    const directory = {
      stage: f.stagingRoot,
      modules: join(f.stagingRoot, "node_modules"),
      package: f.packageDirectory,
      lib: dirname(f.connection),
    }[target];
    const external = join(f.root, "saved-" + target);
    await rename(directory, external);
    if (!(await makeSymlink(t, external, directory, "junction"))) return;
    await assert.rejects(patchAppShotDbus(f), /symlinked/);
    assert.equal(await readFile(f.connection, "utf8"), originalConnection);
    assert.equal(await readFile(f.manifest, "utf8"), originalManifest);
  });
}

function loadWithFakeRequire(source) {
  const loads = [];
  const sockets = [];
  const warnings = [];
  const handshakes = [];
  const module = { exports: {} };
  const modules = {
    events: { EventEmitter },
    net: {
      createConnection(...address) {
        const stream = new EventEmitter();
        stream.writable = true;
        stream.writes = [];
        stream.setNoDelay = () => {};
        stream.end = () => stream.emit("end");
        stream.write = (data) => {
          stream.writes.push(data);
          return true;
        };
        sockets.push({ address, stream });
        return stream;
      },
    },
    "./message": { unmarshalMessages() {} },
    "./handshake": (stream, options, done) => {
      handshakes.push({ stream, options });
      done(null, "fixture-guid");
    },
    "./address-x11": {
      getDbusAddressFromFs() {
        throw new Error("Fixture must provide an explicit bus address");
      },
    },
    "./message-type": { Message: class {} },
    "./marshall-compat": {
      messageToJsFmt: (message) => message,
      marshallMessage: () => [Buffer.from("fixture-message"), []],
    },
  };
  vm.runInNewContext(
    source,
    {
      module,
      require(name) {
        loads.push(name);
        if (!Object.hasOwn(modules, name)) {
          throw new Error("Forbidden fixture require: " + name);
        }
        return modules[name];
      },
      process: { env: {} },
      console: { warn: (message) => warnings.push(message) },
      setTimeout() {
        throw new Error("Fixture must not schedule external work");
      },
    },
    { filename: "copied-dbus-next/lib/connection.js" },
  );
  return {
    createConnection: module.exports,
    loads,
    sockets,
    warnings,
    handshakes,
  };
}

const unixCases = [
  ["path", "unix:path=/tmp/app-shot-fixture", "/tmp/app-shot-fixture"],
  ["abstract", "unix:abstract=app-shot-fixture", "\0app-shot-fixture"],
];
for (const [name, busAddress, expectedAddress] of unixCases) {
  for (const negotiateUnixFd of [false, true]) {
    test(
      name +
        " uses native net and never resolves usocket, negotiateUnixFd=" +
        negotiateUnixFd,
      async (t) => {
        const f = await fixture(t);
        await patchAppShotDbus(f);
        const mock = loadWithFakeRequire(await readFile(f.connection, "utf8"));
        const connection = mock.createConnection({
          busAddress,
          negotiateUnixFd,
        });
        assert.equal(mock.sockets.length, 1);
        const socket = mock.sockets[0];
        assert.deepEqual(socket.address, [expectedAddress]);
        assert.equal(mock.loads.includes("usocket"), false);
        assert.equal(Object.hasOwn(socket.stream, "supportsUnixFd"), false);
        connection.message({});
        socket.stream.emit("connect");
        connection.message({});
        assert.equal(mock.handshakes.length, 1);
        assert.equal(connection.state, "connected");
        assert.equal(socket.stream.writes.length, 2);
        assert.ok(socket.stream.writes.every(Buffer.isBuffer));
        assert.deepEqual(mock.warnings, []);
        assert.equal(mock.loads.includes("usocket"), false);
      },
    );
  }
}

test("fake require detects the original path fallback's usocket attempt", () => {
  const mock = loadWithFakeRequire(originalConnection);
  mock.createConnection({ busAddress: unixCases[0][1] });
  assert.ok(mock.loads.includes("usocket"));
});

test("fake require rejects the original abstract socket's usocket dependency", () => {
  const mock = loadWithFakeRequire(originalConnection);
  assert.throws(
    () => mock.createConnection({ busAddress: unixCases[1][1] }),
    /Forbidden fixture require: usocket/,
  );
  assert.ok(mock.loads.includes("usocket"));
});

test("existing socket and TCP branches remain native net transports", async (t) => {
  const f = await fixture(t);
  await patchAppShotDbus(f);
  const source = await readFile(f.connection, "utf8");
  for (const [busAddress, expected] of [
    ["unix:socket=/tmp/existing-socket", ["/tmp/existing-socket"]],
    ["tcp:host=127.0.0.1,port=1234", ["1234", "127.0.0.1"]],
  ]) {
    const mock = loadWithFakeRequire(source);
    mock.createConnection({ busAddress });
    assert.deepEqual(mock.sockets[0].address, expected);
    assert.equal(mock.loads.includes("usocket"), false);
  }
});
