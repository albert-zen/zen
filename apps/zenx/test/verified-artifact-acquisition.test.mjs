import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquireVerifiedArtifact } from "../../../scripts/verified-artifact-acquisition.mjs";

const run = promisify(execFile);
const acquisitionModule = pathToFileURL(
  fileURLToPath(
    new URL(
      "../../../scripts/verified-artifact-acquisition.mjs",
      import.meta.url,
    ),
  ),
).href;

test("bounds a server that accepts a request but never responds", async () => {
  const fixture = await createFixture((_request, _response) => {});
  const started = Date.now();
  try {
    await assert.rejects(
      acquireVerifiedArtifact({
        artifactName: "hung provider fixture",
        url: `${fixture.url}/hung?credential=hidden`,
        digest: sha256("never returned"),
        deadline: Date.now() + 500,
        cacheLocation: fixture.cacheLocation,
      }),
      (error) => {
        assert.match(error.message, /hung provider fixture/u);
        assert.match(error.message, /overall deadline/u);
        assert.doesNotMatch(error.message, /credential=hidden/u);
        return true;
      },
    );
    assert.ok(Date.now() - started < 3_000, "deadline must bound failure");
    assert.deepEqual(await cacheFiles(fixture.cacheLocation), []);
  } finally {
    await fixture.close();
  }
});

test("rejects a partial response and removes its partial cache file", async () => {
  const fixture = await createFixture((_request, response) => {
    response.writeHead(200, { "content-length": "12" });
    response.write("partial");
    response.destroy();
  });
  try {
    await assert.rejects(
      acquireVerifiedArtifact({
        artifactName: "partial provider fixture",
        url: `${fixture.url}/partial`,
        digest: sha256("partial body"),
        deadline: Date.now() + 2_000,
        cacheLocation: fixture.cacheLocation,
      }),
      /partial provider fixture.*incomplete/iu,
    );
    assert.deepEqual(await cacheFiles(fixture.cacheLocation), []);
  } finally {
    await fixture.close();
  }
});

test("rejects a digest mismatch without publishing a cache entry", async () => {
  const fixture = await createFixture((_request, response) => {
    response.end("wrong bytes");
  });
  try {
    await assert.rejects(
      acquireVerifiedArtifact({
        artifactName: "mismatched provider fixture",
        url: `${fixture.url}/mismatch`,
        digest: sha256("expected bytes"),
        deadline: Date.now() + 2_000,
        cacheLocation: fixture.cacheLocation,
      }),
      /mismatched provider fixture.*digest mismatch/iu,
    );
    assert.deepEqual(await cacheFiles(fixture.cacheLocation), []);
  } finally {
    await fixture.close();
  }
});

test("reuses a verified digest-keyed immutable cache entry offline", async () => {
  const bytes = Buffer.from("verified provider bytes");
  let requests = 0;
  const fixture = await createFixture((_request, response) => {
    requests += 1;
    response.end(bytes);
  });
  try {
    const options = {
      artifactName: "cached provider fixture",
      url: `${fixture.url}/cached`,
      digest: sha256(bytes),
      deadline: Date.now() + 2_000,
      cacheLocation: fixture.cacheLocation,
    };
    const first = await acquireVerifiedArtifact(options);
    await fixture.closeServer();
    const second = await acquireVerifiedArtifact({
      ...options,
      url: "http://127.0.0.1:1/offline",
      deadline: Date.now() + 2_000,
    });

    assert.equal(second, first);
    assert.equal(path.basename(first), options.digest);
    assert.deepEqual(await readFile(first), bytes);
    if (process.platform !== "win32") {
      assert.equal((await stat(first)).mode & 0o222, 0);
    }
    assert.equal(requests, 1);
    assert.deepEqual(await cacheFiles(fixture.cacheLocation), [first]);
  } finally {
    await fixture.close();
  }
});

test("re-verifies a cache hit before reuse", async () => {
  const bytes = Buffer.from("authoritative bytes");
  let requests = 0;
  const fixture = await createFixture((_request, response) => {
    requests += 1;
    response.end(bytes);
  });
  try {
    const options = {
      artifactName: "reverified provider fixture",
      url: `${fixture.url}/reverified`,
      digest: sha256(bytes),
      deadline: Date.now() + 2_000,
      cacheLocation: fixture.cacheLocation,
    };
    const cached = await acquireVerifiedArtifact(options);
    await chmod(cached, 0o600);
    await writeFile(cached, "tampered");

    assert.equal(await acquireVerifiedArtifact(options), cached);
    assert.deepEqual(await readFile(cached), bytes);
    assert.equal(requests, 2);
  } finally {
    await fixture.close();
  }
});

test("rejects an oversized stream before accepting its body", async () => {
  const fixture = await createFixture((_request, response) => {
    response.writeHead(200, { "content-length": String(1024 ** 3) });
    response.end();
  });
  try {
    await assert.rejects(
      acquireVerifiedArtifact({
        artifactName: "oversized provider fixture",
        url: `${fixture.url}/oversized`,
        digest: sha256("unused"),
        deadline: Date.now() + 2_000,
        cacheLocation: fixture.cacheLocation,
      }),
      /oversized provider fixture.*size bound/iu,
    );
    assert.deepEqual(await cacheFiles(fixture.cacheLocation), []);
  } finally {
    await fixture.close();
  }
});

test("honors isolated proxy and direct routing without changing global settings", async () => {
  const bytes = Buffer.from("proxy routing fixture");
  let requests = 0;
  const fixture = await createFixture((_request, response) => {
    requests += 1;
    response.end(bytes);
  });
  const proxy = await createProxyFixture();
  try {
    const proxyResult = await acquireInChild(
      {
        artifactName: "proxied provider fixture",
        url: `${fixture.url}/through-proxy`,
        digest: sha256(bytes),
        deadline: Date.now() + 5_000,
        cacheLocation: path.join(fixture.cacheLocation, "proxied"),
      },
      {
        HTTP_PROXY: proxy.url,
        http_proxy: proxy.url,
        HTTPS_PROXY: "",
        https_proxy: "",
        NO_PROXY: "",
        no_proxy: "",
      },
    );
    assert.deepEqual(await readFile(proxyResult), bytes);
    assert.equal(proxy.connections(), 1);

    const directResult = await acquireInChild(
      {
        artifactName: "direct provider fixture",
        url: `${fixture.url}/direct`,
        digest: sha256(bytes),
        deadline: Date.now() + 5_000,
        cacheLocation: path.join(fixture.cacheLocation, "direct"),
      },
      {
        HTTP_PROXY: "http://127.0.0.1:1",
        http_proxy: "http://127.0.0.1:1",
        HTTPS_PROXY: "",
        https_proxy: "",
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      },
    );
    assert.deepEqual(await readFile(directResult), bytes);
    assert.equal(requests, 2);
  } finally {
    await proxy.close();
    await fixture.close();
  }
});

test("names the artifact and source without leaking URL credentials", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-redaction-test-"),
  );
  try {
    await assert.rejects(
      acquireVerifiedArtifact({
        artifactName: "credentialed provider fixture",
        url: "http://user:secret@127.0.0.1:1/archive?token=hidden",
        digest: sha256("unavailable"),
        deadline: Date.now() + 2_000,
        cacheLocation: directory,
      }),
      (error) => {
        assert.match(error.message, /credentialed provider fixture/u);
        assert.match(error.message, /http:\/\/127\.0\.0\.1:1\/archive/u);
        assert.doesNotMatch(error.message, /user|secret|token|hidden/u);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createFixture(listener) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-artifact-test-"),
  );
  const cacheLocation = path.join(directory, "cache");
  const server = createServer(listener);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  let closed = false;
  const closeServer = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  };
  return {
    cacheLocation,
    url: `http://127.0.0.1:${String(address.port)}`,
    closeServer,
    close: async () => {
      await closeServer();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function createProxyFixture() {
  let connections = 0;
  const server = createServer();
  server.on("connect", (request, client, head) => {
    connections += 1;
    const separator = request.url.lastIndexOf(":");
    const host = request.url.slice(0, separator);
    const port = Number(request.url.slice(separator + 1));
    const upstream = connect({ host, port }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength > 0) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    connections: () => connections,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    },
  };
}

async function acquireInChild(options, environment) {
  const source = `
    import { acquireVerifiedArtifact } from ${JSON.stringify(acquisitionModule)};
    const result = await acquireVerifiedArtifact(JSON.parse(process.env.ZENX_ARTIFACT_OPTIONS));
    process.stdout.write(result);
  `;
  const result = await run(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      env: {
        ...process.env,
        ...environment,
        ZENX_ARTIFACT_OPTIONS: JSON.stringify(options),
      },
    },
  );
  return result.stdout;
}

async function cacheFiles(root) {
  const files = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else files.push(candidate);
    }
  };
  await visit(root);
  return files.sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
