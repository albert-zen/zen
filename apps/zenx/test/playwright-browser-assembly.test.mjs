import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { assemblePlaywrightBrowser } from "../../../scripts/assemble-zenx-providers.mjs";
import { hashBundledDirectoryAsset } from "../src/main/capabilities/provider-provisioning.js";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("provider lock is the only Playwright browser archive authority", async () => {
  const lock = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "apps",
        "zenx",
        "resources",
        "providers",
        "provider-lock.json",
      ),
      "utf8",
    ),
  );
  assert.equal(lock.browser.name, "chromium");
  assert.match(lock.browser.revision, /^\d+$/u);
  assert.deepEqual(
    Object.keys(lock.browser.platformArchives).sort(),
    Object.keys(lock.node.platformArchives).sort(),
  );
  for (const archive of Object.values(lock.browser.platformArchives)) {
    assert.match(
      archive.url,
      /^https:\/\/(?:storage\.googleapis\.com|playwright\.download\.prss\.microsoft\.com)\//u,
    );
    assert.match(archive.sourceUrl, /^https:\/\/cdn\.playwright\.dev\//u);
    assert.match(archive.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(typeof archive.executable, "string");
    assert.ok(archive.executable.length > 0);
  }
  const assemblySource = await readFile(
    path.join(repositoryRoot, "scripts", "assemble-zenx-providers.mjs"),
    "utf8",
  );
  assert.doesNotMatch(assemblySource, /install-browser/u);
  assert.doesNotMatch(assemblySource, /PLAYWRIGHT_DOWNLOAD_HOST/u);
});

test("browser assembly fails closed on digest and reuses verified cache offline", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-browser-assembly-test-"),
  );
  const archive = path.join(directory, "browser.tar");
  const archiveSource = path.join(directory, "archive-source");
  const executablePath = "chrome-fixture/chrome";
  const playwrightDirectory = path.join(directory, "playwright-cli");
  const cacheLocation = path.join(directory, "cache");
  let requests = 0;
  let server;
  try {
    await mkdir(path.join(archiveSource, "chrome-fixture"), {
      recursive: true,
    });
    await writeFile(
      path.join(archiveSource, executablePath),
      "verified browser executable",
    );
    await writeFile(path.join(archiveSource, "resource.pak"), "resource");
    await run("tar", ["-cf", archive, "-C", archiveSource, "."]);
    const archiveBytes = await readFile(archive);
    const archiveSha256 = sha256(archiveBytes);
    await mkdir(
      path.join(playwrightDirectory, "node_modules", "playwright-core"),
      { recursive: true },
    );
    await writeFile(
      path.join(
        playwrightDirectory,
        "node_modules",
        "playwright-core",
        "browsers.json",
      ),
      JSON.stringify({
        browsers: [
          {
            name: "chromium",
            revision: "fixture-revision",
            browserVersion: "fixture-version",
          },
        ],
      }),
    );
    server = await createArchiveServer(archive, archiveBytes.byteLength, () => {
      requests += 1;
    });
    const platform = process.platform;
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const platformKey = `${platform}-${arch}`;
    const pin = {
      name: "chromium",
      revision: "fixture-revision",
      version: "fixture-version",
      platformArchives: {
        [platformKey]: {
          url: `${server.url}/browser.tar`,
          sha256: archiveSha256,
          executable: executablePath,
        },
      },
    };

    const rejectedProviders = path.join(directory, "rejected", "providers");
    await mkdir(rejectedProviders, { recursive: true });
    await assert.rejects(
      assemblePlaywrightBrowser({
        pin: {
          ...pin,
          platformArchives: {
            [platformKey]: {
              ...pin.platformArchives[platformKey],
              sha256: "0".repeat(64),
            },
          },
        },
        platform,
        arch,
        providersDirectory: rejectedProviders,
        playwrightDirectory,
        cacheLocation,
        deadline: Date.now() + 5_000,
      }),
      /Playwright chromium.*digest mismatch/iu,
    );
    await assert.rejects(
      access(
        path.join(
          rejectedProviders,
          "playwright-browsers",
          "chromium-fixture-revision",
        ),
      ),
      { code: "ENOENT" },
    );

    const onlineProviders = path.join(directory, "online", "providers");
    await mkdir(onlineProviders, { recursive: true });
    const online = await assemblePlaywrightBrowser({
      pin,
      platform,
      arch,
      providersDirectory: onlineProviders,
      playwrightDirectory,
      cacheLocation,
      deadline: Date.now() + 5_000,
    });
    assert.equal(online.archiveSha256, archiveSha256);
    assert.equal(online.assets[0].kind, "directory");
    assert.deepEqual(online.assets[0].ignoredPaths, ["DEPENDENCIES_VALIDATED"]);
    assert.equal(
      online.assets[0].sha256,
      await hashBundledDirectoryAsset(
        online.browserDirectory,
        online.assets[0].ignoredPaths,
      ),
    );
    assert.equal(
      online.assets[1].sha256,
      sha256("verified browser executable"),
    );
    await access(path.join(online.browserDirectory, "INSTALLATION_COMPLETE"));
    await writeFile(
      path.join(online.browserDirectory, "DEPENDENCIES_VALIDATED"),
      "",
    );
    assert.equal(
      await hashBundledDirectoryAsset(
        online.browserDirectory,
        online.assets[0].ignoredPaths,
      ),
      online.assets[0].sha256,
    );
    await writeFile(path.join(online.browserDirectory, "untrusted.dll"), "x");
    assert.notEqual(
      await hashBundledDirectoryAsset(
        online.browserDirectory,
        online.assets[0].ignoredPaths,
      ),
      online.assets[0].sha256,
    );
    await rm(path.join(online.browserDirectory, "untrusted.dll"));
    assert.equal(requests, 2);

    await server.close();
    server = undefined;
    const offlineProviders = path.join(directory, "offline", "providers");
    await mkdir(offlineProviders, { recursive: true });
    const offline = await assemblePlaywrightBrowser({
      pin: {
        ...pin,
        platformArchives: {
          [platformKey]: {
            ...pin.platformArchives[platformKey],
            url: "http://127.0.0.1:1/offline-browser.tar",
          },
        },
      },
      platform,
      arch,
      providersDirectory: offlineProviders,
      playwrightDirectory,
      cacheLocation,
      deadline: Date.now() + 5_000,
    });
    assert.equal(offline.assets[0].sha256, online.assets[0].sha256);
    assert.deepEqual(await readdir(path.join(cacheLocation, "sha256")), [
      archiveSha256,
    ]);
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createArchiveServer(archive, size, onRequest) {
  const server = createServer((_request, response) => {
    onRequest();
    response.writeHead(200, { "content-length": String(size) });
    createReadStream(archive).pipe(response);
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
