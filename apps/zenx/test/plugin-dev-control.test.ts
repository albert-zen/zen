import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { requestPluginDevLink } from "@zenx/plugin-sdk";

import { ZenXPluginDevControlServer } from "../src/main/plugin-dev-control.js";

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
