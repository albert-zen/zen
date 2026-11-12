import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  publishZenXConnectionDescriptor,
  readZenXConnectionDescriptor,
  revokeZenXConnectionDescriptor,
} from "../src/protocol-client/connection-descriptor.js";

test("publishes a private discoverable descriptor without embedding its bearer token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-descriptor-"));
  const descriptorFile = path.join(directory, "zas-connection.json");
  const tokenFile = path.join(directory, "app-server.token");
  const token = "never-copy-this-token-into-the-descriptor";
  try {
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await publishZenXConnectionDescriptor(descriptorFile, {
      version: 1,
      transport: "websocket",
      url: "ws://127.0.0.1:41234",
      authentication: { type: "bearer-file", tokenFile },
    });

    assert.deepEqual(await readZenXConnectionDescriptor(descriptorFile), {
      version: 1,
      transport: "websocket",
      url: "ws://127.0.0.1:41234",
      authentication: { type: "bearer-file", tokenFile },
    });
    const source = await readFile(descriptorFile, "utf8");
    assert.equal(source.includes(token), false);
    if (process.platform !== "win32") {
      assert.equal((await stat(descriptorFile)).mode & 0o777, 0o600);
    }

    await revokeZenXConnectionDescriptor(descriptorFile);
    await assert.rejects(readFile(descriptorFile), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects descriptors that are not authenticated loopback WebSockets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-descriptor-"));
  const descriptorFile = path.join(directory, "zas-connection.json");
  try {
    await writeFile(
      descriptorFile,
      JSON.stringify({
        version: 1,
        transport: "websocket",
        url: "ws://192.0.2.10:41234",
        authentication: {
          type: "bearer-file",
          tokenFile: path.join(directory, "token"),
        },
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      readZenXConnectionDescriptor(descriptorFile),
      /loopback WebSocket/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
