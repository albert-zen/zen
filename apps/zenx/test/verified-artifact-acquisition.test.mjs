import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
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

test("serializes invalid-cache cleanup with a competing publish", async () => {
  const bytes = Buffer.from("transaction winner bytes");
  const digest = sha256(bytes);
  let releaseRequest;
  const requestReceived = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const fixture = await createFixture((_request, response) => {
    response.end(bytes, releaseRequest);
  });
  const cacheFile = path.join(fixture.cacheLocation, "sha256", digest);
  const readyFile = path.join(fixture.cacheLocation, "slow-ready");
  const releaseFile = path.join(fixture.cacheLocation, "release-slow");
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, "invalid predecessor");

  const slow = acquirePausedAfterCacheSnapshot(
    {
      artifactName: "slow invalid-cache contender",
      url: "http://127.0.0.1:1/unavailable",
      digest,
      deadline: Date.now() + 5_000,
      cacheLocation: fixture.cacheLocation,
    },
    { cacheFile, readyFile, releaseFile },
  );
  try {
    await waitForPath(readyFile);
    const fast = acquireInChild({
      artifactName: "publishing contender",
      url: `${fixture.url}/winner`,
      digest,
      deadline: Date.now() + 5_000,
      cacheLocation: fixture.cacheLocation,
    });
    const publishedBeforeRelease = await Promise.race([
      requestReceived.then(async () => {
        await fast;
        return true;
      }),
      delay(500).then(() => false),
    ]);
    await writeFile(releaseFile, "release");

    const slowResult = await slow;
    assert.equal(slowResult.ok, false);
    const fastResult = await fast;
    assert.equal(fastResult, cacheFile);
    assert.deepEqual(await readFile(cacheFile), bytes);
    assert.equal(
      publishedBeforeRelease,
      false,
      "a contender must not publish while the invalid-cache transaction is held",
    );
  } finally {
    await writeFile(releaseFile, "release").catch(() => {});
    await fixture.close();
  }
});

test(
  "removes a cache-path symlink without changing its target",
  { skip: process.platform === "win32" ? "POSIX mode contract" : false },
  async () => {
    const bytes = Buffer.from("replacement artifact bytes");
    const digest = sha256(bytes);
    const fixture = await createFixture((_request, response) => {
      response.end(bytes);
    });
    const cacheFile = path.join(fixture.cacheLocation, "sha256", digest);
    const target = path.join(fixture.cacheLocation, "symlink-target");
    try {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(target, "do not mutate this target", { mode: 0o444 });
      await chmod(target, 0o444);
      const targetMode = (await stat(target)).mode & 0o777;
      await symlink(target, cacheFile);

      assert.equal(
        await acquireVerifiedArtifact({
          artifactName: "symlinked cache fixture",
          url: `${fixture.url}/replacement`,
          digest,
          deadline: Date.now() + 2_000,
          cacheLocation: fixture.cacheLocation,
        }),
        cacheFile,
      );

      assert.deepEqual(await readFile(cacheFile), bytes);
      assert.equal((await lstat(cacheFile)).isFile(), true);
      assert.equal(await readFile(target, "utf8"), "do not mutate this target");
      assert.equal((await stat(target)).mode & 0o777, targetMode);
    } finally {
      await fixture.close();
    }
  },
);

test("converges cross-process contenders through one download", async () => {
  const bytes = Buffer.from("one serialized download");
  let requests = 0;
  const fixture = await createFixture((_request, response) => {
    requests += 1;
    setTimeout(() => response.end(bytes), 50);
  });
  try {
    const options = {
      artifactName: "cross-process stress fixture",
      url: `${fixture.url}/serialized`,
      digest: sha256(bytes),
      deadline: Date.now() + 10_000,
      cacheLocation: fixture.cacheLocation,
    };
    const settled = await Promise.allSettled(
      Array.from({ length: 12 }, () => acquireInChild(options)),
    );
    const failures = settled.filter((result) => result.status === "rejected");
    assert.deepEqual(
      failures.map((result) => result.reason?.message ?? String(result.reason)),
      [],
    );
    const results = settled.map((result) => result.value);

    assert.equal(new Set(results).size, 1);
    assert.deepEqual(await readFile(results[0]), bytes);
    assert.equal(requests, 1);
  } finally {
    await fixture.close();
  }
});

test("ignores a participant atomically retired while it is observed", async () => {
  const bytes = Buffer.from("retirement race recovery");
  const digest = sha256(bytes);
  const fixture = await createFixture((_request, response) => {
    response.end(bytes);
  });
  const record = await seedParticipant(fixture.cacheLocation, digest, {
    token: "retiring-observer-fixture",
    createdAt: Date.now(),
    deadline: Date.now() + 30_000,
    ticket: 1,
  });
  try {
    const result = await acquireAfterRetiringObservedParticipant(
      {
        artifactName: "retirement observer fixture",
        url: `${fixture.url}/retired-observer`,
        digest,
        deadline: Date.now() + 5_000,
        cacheLocation: fixture.cacheLocation,
      },
      record,
    );

    assert.deepEqual(await readFile(result), bytes);
    assert.deepEqual(await readdir(record.transactionRoot), []);
  } finally {
    await fixture.close();
  }
});

test("quarantines a live participant with future-skewed timestamps", async () => {
  const bytes = Buffer.from("future timestamp recovery");
  const digest = sha256(bytes);
  const fixture = await createFixture((_request, response) => {
    response.end(bytes);
  });
  const future = Date.now() + 24 * 60 * 60_000;
  const record = await seedParticipant(fixture.cacheLocation, digest, {
    token: "future-owner-fixture",
    createdAt: future,
    deadline: future + 30_000,
    ticket: 1,
    modifiedAt: future,
  });
  try {
    const result = await acquireVerifiedArtifact({
      artifactName: "future owner fixture",
      url: `${fixture.url}/future-owner`,
      digest,
      deadline: Date.now() + 2_000,
      cacheLocation: fixture.cacheLocation,
    });

    assert.deepEqual(await readFile(result), bytes);
    assert.deepEqual(await readdir(record.transactionRoot), []);
  } finally {
    await fixture.close();
  }
});

test("quarantines a published participant without a ticket", async () => {
  const bytes = Buffer.from("invalid participant recovery");
  const digest = sha256(bytes);
  const fixture = await createFixture((_request, response) => {
    response.end(bytes);
  });
  const record = await seedParticipant(fixture.cacheLocation, digest, {
    token: "missing-ticket-fixture",
    createdAt: Date.now(),
    deadline: Date.now() + 30_000,
  });
  try {
    const result = await acquireVerifiedArtifact({
      artifactName: "invalid participant fixture",
      url: `${fixture.url}/invalid-participant`,
      digest,
      deadline: Date.now() + 2_000,
      cacheLocation: fixture.cacheLocation,
    });

    assert.deepEqual(await readFile(result), bytes);
    assert.deepEqual(await readdir(record.transactionRoot), []);
  } finally {
    await fixture.close();
  }
});

test("reclaims a dead contender without leaving the digest blocked", async () => {
  const bytes = Buffer.from("recovered after dead owner");
  const digest = sha256(bytes);
  const fixture = await createFixture((_request, response) => {
    response.end(bytes);
  });
  const cacheFile = path.join(fixture.cacheLocation, "sha256", digest);
  const readyFile = path.join(fixture.cacheLocation, "dead-owner-ready");
  const releaseFile = path.join(fixture.cacheLocation, "never-release-owner");
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, "invalid predecessor");

  const deadOwner = acquirePausedAfterCacheSnapshot(
    {
      artifactName: "dead cache transaction owner",
      url: `${fixture.url}/unused`,
      digest,
      deadline: Date.now() + 30_000,
      cacheLocation: fixture.cacheLocation,
    },
    { cacheFile, readyFile, releaseFile },
  );
  try {
    await waitForPath(readyFile);
    assert.equal(deadOwner.child.kill(), true);
    await assert.rejects(deadOwner, /paused acquisition exited/u);

    const started = Date.now();
    assert.equal(
      await acquireVerifiedArtifact({
        artifactName: "dead-owner recovery fixture",
        url: `${fixture.url}/recovery`,
        digest,
        deadline: Date.now() + 2_000,
        cacheLocation: fixture.cacheLocation,
      }),
      cacheFile,
    );
    assert.ok(
      Date.now() - started < 1_500,
      "dead owner cleanup must be bounded",
    );
    assert.deepEqual(await readFile(cacheFile), bytes);
    assert.deepEqual(
      await readdir(
        path.join(fixture.cacheLocation, "sha256", ".transactions", digest),
      ),
      [],
    );
  } finally {
    deadOwner.child.kill();
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

async function acquireAfterRetiringObservedParticipant(options, record) {
  const source = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const originalReadFile = fs.promises.readFile;
    let ownerObservations = 0;
    fs.promises.readFile = async (...arguments_) => {
      const result = await originalReadFile(...arguments_);
      if (String(arguments_[0]) === process.env.ZENX_OBSERVED_OWNER) {
        ownerObservations += 1;
        if (ownerObservations === 2) {
          await fs.promises.rename(
            process.env.ZENX_OBSERVED_PARTICIPANT,
            process.env.ZENX_RETIRED_PARTICIPANT,
          );
          await fs.promises.rm(process.env.ZENX_RETIRED_PARTICIPANT, {
            recursive: true,
            force: true,
          });
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const { acquireVerifiedArtifact } = await import(${JSON.stringify(acquisitionModule)});
    const result = await acquireVerifiedArtifact(JSON.parse(process.env.ZENX_ARTIFACT_OPTIONS));
    process.stdout.write(result);
  `;
  const retiredParticipant = path.join(
    record.transactionRoot,
    `retired-${path.basename(record.directory)}-fixture`,
  );
  const result = await run(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      env: {
        ...process.env,
        ZENX_ARTIFACT_OPTIONS: JSON.stringify(options),
        ZENX_OBSERVED_OWNER: path.join(record.directory, "owner.json"),
        ZENX_OBSERVED_PARTICIPANT: record.directory,
        ZENX_RETIRED_PARTICIPANT: retiredParticipant,
      },
    },
  );
  return result.stdout;
}

function acquirePausedAfterCacheSnapshot(options, gate) {
  const source = `
    import fs from "node:fs";
    const originalOpen = fs.promises.open;
    const originalWriteFile = fs.promises.writeFile;
    const originalAccess = fs.promises.access;
    let paused = false;
    fs.promises.open = async (...arguments_) => {
      const handle = await originalOpen(...arguments_);
      if (!paused && String(arguments_[0]) === process.env.ZENX_CACHE_FILE) {
        paused = true;
        const metadata = await handle.stat();
        const snapshot = await handle.readFile();
        await handle.close();
        await originalWriteFile(process.env.ZENX_READY_FILE, "ready");
        while (true) {
          try {
            await originalAccess(process.env.ZENX_RELEASE_FILE);
            break;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        let position = 0;
        return {
          stat: async () => metadata,
          read: async (buffer, offset, length) => {
            const bytesRead = Math.min(length, snapshot.byteLength - position);
            if (bytesRead > 0) {
              snapshot.copy(buffer, offset, position, position + bytesRead);
              position += bytesRead;
            }
            return { bytesRead, buffer };
          },
          close: async () => {},
        };
      }
      return handle;
    };
    const { acquireVerifiedArtifact } = await import(${JSON.stringify(acquisitionModule)});
    try {
      const result = await acquireVerifiedArtifact(JSON.parse(process.env.ZENX_ARTIFACT_OPTIONS));
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, message: error.message }));
    }
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      env: {
        ...process.env,
        ZENX_ARTIFACT_OPTIONS: JSON.stringify(options),
        ZENX_CACHE_FILE: gate.cacheFile,
        ZENX_READY_FILE: gate.readyFile,
        ZENX_RELEASE_FILE: gate.releaseFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `paused acquisition exited ${String(code)} ${signal ?? ""}: ${stderr}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
  completion.child = child;
  return completion;
}

async function seedParticipant(cacheLocation, digest, options) {
  const transactionRoot = path.join(
    cacheLocation,
    "sha256",
    ".transactions",
    digest,
  );
  const directory = path.join(transactionRoot, `participant-${options.token}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, "owner.json"),
    `${JSON.stringify({
      version: 1,
      token: options.token,
      pid: process.pid,
      createdAt: options.createdAt,
      deadline: options.deadline,
    })}\n`,
    { mode: 0o600 },
  );
  if (options.choosing === true) {
    await writeFile(path.join(directory, "choosing"), "", { mode: 0o600 });
  }
  if (options.ticket !== undefined) {
    await writeFile(path.join(directory, "ticket"), `${options.ticket}\n`, {
      mode: 0o600,
    });
  }
  if (options.modifiedAt !== undefined) {
    const modifiedAt = new Date(options.modifiedAt);
    await utimes(directory, modifiedAt, modifiedAt);
  }
  return { transactionRoot, directory };
}

async function waitForPath(file) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await stat(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
