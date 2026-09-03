import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { requestPluginDevLink } from "@zenx/plugin-sdk";

import { ZenXPluginDevControlServer } from "../src/main/plugin-dev-control.js";

test("a cancelled bootstrap removes a plugin-dev descriptor published in flight", async () => {
  const fixture = await controlFixture();
  let publicationBoundaries = 0;
  try {
    await assert.rejects(
      ZenXPluginDevControlServer.start({
        ...fixture.options,
        assertCanPublish: () => {
          publicationBoundaries += 1;
          if (publicationBoundaries === 3) {
            throw new Error("bootstrap cancelled after plugin-dev publication");
          }
        },
        install: async () => committedInstall(),
        reload: async () => ({ status: "reloaded" }),
      }),
      /bootstrap cancelled after plugin-dev publication/u,
    );
    assert.equal(publicationBoundaries, 3);
    await assert.rejects(readFile(fixture.options.descriptorFile), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(fixture.options.tokenFile), {
      code: "ENOENT",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("plugin-dev startup cleanup keeps the cancellation cause and attempts every resource", async () => {
  const fixture = await controlFixture();
  const cancellation = new Error("bootstrap cancellation evidence");
  let publicationBoundaries = 0;
  try {
    await assert.rejects(
      ZenXPluginDevControlServer.start({
        ...fixture.options,
        assertCanPublish: () => {
          publicationBoundaries += 1;
          if (publicationBoundaries !== 3) return;
          rmSync(fixture.options.descriptorFile);
          mkdirSync(fixture.options.descriptorFile);
          writeFileSync(
            path.join(fixture.options.descriptorFile, "blocks-unlink"),
            "keep",
          );
          throw cancellation;
        },
        install: async () => committedInstall(),
        reload: async () => ({ status: "reloaded" }),
      }),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors[0] === cancellation &&
        error.errors.length === 2,
    );
    await assert.rejects(readFile(fixture.options.tokenFile), {
      code: "ENOENT",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("bounds an authenticated partial request body before install starts", async () => {
  const fixture = await controlFixture();
  let installs = 0;
  const server = await ZenXPluginDevControlServer.start({
    ...fixture.options,
    requestBodyTimeoutMs: 25,
    install: async () => {
      installs += 1;
      throw new Error("install should not start");
    },
    reload: async () => ({ status: "reloaded" }),
  });
  try {
    const descriptor = JSON.parse(
      await readFile(fixture.options.descriptorFile, "utf8"),
    ) as { url: string };
    const token = (await readFile(fixture.options.tokenFile, "utf8")).trim();
    const response = await partialRequest(descriptor.url, token);
    assert.equal(response.status, 400);
    assert.match(response.body, /request body timed out after 25ms/u);
    assert.equal(installs, 0);
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

test("transaction deadline aborts and settles install before returning failure", async () => {
  const fixture = await controlFixture();
  let settled = false;
  const server = await ZenXPluginDevControlServer.start({
    ...fixture.options,
    transactionTimeoutMs: 25,
    install: async (_request, signal) =>
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              settled = true;
              reject(signal.reason);
            }, 10);
          },
          { once: true },
        );
      }),
    reload: async () => ({ status: "reloaded" }),
  });
  try {
    await assert.rejects(
      requestPluginDevLink(
        fixture.options.descriptorFile,
        devRequest(fixture.directory),
        { timeoutMs: 500 },
      ),
      /transaction timed out after 25ms/u,
    );
    assert.equal(settled, true);
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

test("server close aborts and settles an active install", async () => {
  const fixture = await controlFixture();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => (started = resolve));
  let settled = false;
  const server = await ZenXPluginDevControlServer.start({
    ...fixture.options,
    transactionTimeoutMs: 1_000,
    install: async (_request, signal) => {
      started();
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            settled = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    reload: async () => ({ status: "reloaded" }),
  });
  const request = requestPluginDevLink(
    fixture.options.descriptorFile,
    devRequest(fixture.directory),
    { timeoutMs: 500 },
  );
  const rejected = assert.rejects(request);
  try {
    await didStart;
    await server.close();
    await rejected;
    assert.equal(settled, true);
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

test("server close attempts token cleanup when descriptor cleanup fails", async () => {
  const fixture = await controlFixture();
  const server = await ZenXPluginDevControlServer.start({
    ...fixture.options,
    install: async () => committedInstall(),
    reload: async () => ({ status: "reloaded" }),
  });
  try {
    rmSync(fixture.options.descriptorFile);
    mkdirSync(fixture.options.descriptorFile);
    writeFileSync(
      path.join(fixture.options.descriptorFile, "blocks-unlink"),
      "keep",
    );

    await assert.rejects(server.close());
    await assert.rejects(readFile(fixture.options.tokenFile), {
      code: "ENOENT",
    });
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

test("client timeout disconnect aborts the active install without a late result", async () => {
  const fixture = await controlFixture();
  let settled!: () => void;
  const didSettle = new Promise<void>((resolve) => (settled = resolve));
  const server = await ZenXPluginDevControlServer.start({
    ...fixture.options,
    transactionTimeoutMs: 1_000,
    install: async (_request, signal) =>
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            settled();
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    reload: async () => ({ status: "reloaded" }),
  });
  try {
    await assert.rejects(
      requestPluginDevLink(
        fixture.options.descriptorFile,
        devRequest(fixture.directory),
        { timeoutMs: 25 },
      ),
      /timed out/iu,
    );
    await didSettle;
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

test("transaction timeout after the commit fence waits and returns the committed result", async () => {
  const fixture = await controlFixture();
  const fenced = deferred<void>();
  const release = deferred<void>();
  let installSignal: AbortSignal | undefined;
  const server = await ZenXPluginDevControlServer.start({
    ...fixture.options,
    transactionTimeoutMs: 25,
    install: async (_request, signal, enterCommitPhase) => {
      installSignal = signal;
      enterCommitPhase();
      fenced.resolve();
      await release.promise;
      return committedInstall();
    },
    reload: async () => ({ status: "reloaded" }),
  });
  try {
    const requested = requestPluginDevLink(
      fixture.options.descriptorFile,
      devRequest(fixture.directory),
      { timeoutMs: 500 },
    );
    await fenced.promise;
    await delay(40);
    assert.equal(installSignal?.aborted, false);
    release.resolve();
    assert.deepEqual(await requested, {
      version: 1,
      ...committedInstall(),
      reload: { status: "reloaded" },
    });
  } finally {
    release.resolve();
    await server.close();
    await fixture.cleanup();
  }
});

test("server close waits for a commit-fenced install and preserves its response", async () => {
  const fixture = await controlFixture();
  const fenced = deferred<void>();
  const release = deferred<void>();
  const server = await ZenXPluginDevControlServer.start({
    ...fixture.options,
    transactionTimeoutMs: 1_000,
    install: async (_request, signal, enterCommitPhase) => {
      enterCommitPhase();
      fenced.resolve();
      await release.promise;
      assert.equal(signal.aborted, false);
      return committedInstall();
    },
    reload: async () => ({ status: "reloaded" }),
  });
  const requested = requestPluginDevLink(
    fixture.options.descriptorFile,
    devRequest(fixture.directory),
    { timeoutMs: 500 },
  );
  try {
    await fenced.promise;
    const closing = server.close();
    assert.equal(
      await Promise.race([
        closing.then(() => "closed"),
        delay(20).then(() => "waiting"),
      ]),
      "waiting",
    );
    release.resolve();
    assert.equal((await requested).generation, "committed-generation");
    await closing;
  } finally {
    release.resolve();
    await server.close();
    await fixture.cleanup();
  }
});

test("client disconnect after the commit fence cannot abort the active install", async () => {
  const fixture = await controlFixture();
  const fenced = deferred<void>();
  const release = deferred<void>();
  const finished = deferred<void>();
  let installSignal: AbortSignal | undefined;
  const server = await ZenXPluginDevControlServer.start({
    ...fixture.options,
    transactionTimeoutMs: 1_000,
    install: async (_request, signal, enterCommitPhase) => {
      installSignal = signal;
      enterCommitPhase();
      fenced.resolve();
      await release.promise;
      finished.resolve();
      return committedInstall();
    },
    reload: async () => ({ status: "reloaded" }),
  });
  try {
    const client = await rawDevRequest(fixture, devRequest(fixture.directory));
    client.once("error", () => undefined);
    await fenced.promise;
    client.destroy();
    await delay(10);
    assert.equal(installSignal?.aborted, false);
    release.resolve();
    await finished.promise;
  } finally {
    release.resolve();
    await server.close();
    await fixture.cleanup();
  }
});

function devRequest(projectDirectory: string) {
  return {
    version: 1 as const,
    projectDirectory,
    packageName: "bounded-plugin",
    pluginId: "bounded-plugin",
  };
}

async function partialRequest(
  baseUrl: string,
  token: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(new URL("/v1/plugins/dev", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": "100",
      },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.once("end", () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
    });
    request.write("{");
  });
}

async function controlFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-dev-control-"));
  return {
    directory,
    options: {
      descriptorFile: path.join(directory, "plugin-dev.json"),
      tokenFile: path.join(directory, "plugin-dev.token"),
    },
    cleanup: async () => await rm(directory, { recursive: true, force: true }),
  };
}

function committedInstall() {
  return {
    pluginId: "bounded-plugin",
    packageName: "bounded-plugin",
    generation: "committed-generation",
  };
}

async function rawDevRequest(
  fixture: Awaited<ReturnType<typeof controlFixture>>,
  body: ReturnType<typeof devRequest>,
) {
  const descriptor = JSON.parse(
    await readFile(fixture.options.descriptorFile, "utf8"),
  ) as { url: string };
  const token = (await readFile(fixture.options.tokenFile, "utf8")).trim();
  const request = httpRequest(new URL("/v1/plugins/dev", descriptor.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  request.end(JSON.stringify(body));
  return request;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
