import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { requestPluginDevLink } from "../dist/index.js";

const cli = path.resolve(import.meta.dirname, "..", "dist", "cli.js");

test("dev validates a project and asks one authenticated target instance for a dev-link mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-dev-cli-"));
  const target = path.join(root, "dev-plugin");
  const tokenFile = path.join(root, "dev.token");
  const descriptorFile = path.join(root, "dev.json");
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        version: 1,
        pluginId: "dev-plugin",
        packageName: "dev-plugin",
        generation: "fixture-generation",
        reload: { status: "reloaded" },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  try {
    run(process.execPath, [
      cli,
      "create",
      target,
      "--name",
      "dev-plugin",
      "--id",
      "dev-plugin",
    ]);
    await writeFile(tokenFile, "private-dev-token\n", { mode: 0o600 });
    await writeFile(
      descriptorFile,
      `${JSON.stringify({
        version: 1,
        transport: "http",
        url: `http://127.0.0.1:${address.port}`,
        authentication: { type: "bearer-file", tokenFile },
      })}\n`,
      { mode: 0o600 },
    );
    if (process.platform !== "win32") {
      await chmod(tokenFile, 0o600);
      await chmod(descriptorFile, 0o600);
    }

    const developed = await runAsync(process.execPath, [
      cli,
      "dev",
      target,
      "--target",
      descriptorFile,
    ]);
    assert.equal(JSON.parse(developed.stdout).pluginId, "dev-plugin");
    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/v1/plugins/dev",
        authorization: "Bearer private-dev-token",
        body: {
          version: 1,
          projectDirectory: await realpath(target),
          packageName: "dev-plugin",
          pluginId: "dev-plugin",
        },
      },
    ]);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dev client bounds a stalled target request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-dev-stalled-"));
  const tokenFile = path.join(root, "dev.token");
  const descriptorFile = path.join(root, "dev.json");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  try {
    await writeFile(tokenFile, "private-dev-token\n", { mode: 0o600 });
    await writeFile(
      descriptorFile,
      `${JSON.stringify({
        version: 1,
        transport: "http",
        url: `http://127.0.0.1:${address.port}`,
        authentication: { type: "bearer-file", tokenFile },
      })}\n`,
      { mode: 0o600 },
    );
    if (process.platform !== "win32") {
      await chmod(tokenFile, 0o600);
      await chmod(descriptorFile, 0o600);
    }
    await assert.rejects(
      requestPluginDevLink(
        descriptorFile,
        {
          version: 1,
          projectDirectory: root,
          packageName: "stalled-plugin",
          pluginId: "stalled-plugin",
        },
        { timeoutMs: 30 },
      ),
      /timed out|aborted/iu,
    );
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

function run(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

async function runAsync(executable, arguments_) {
  const child = spawn(executable, arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(status, 0, stderr);
  return { stdout, stderr };
}
