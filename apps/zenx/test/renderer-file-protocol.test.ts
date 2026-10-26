import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { Session } from "electron";
import { installRendererFileProtocol } from "../src/main/renderer-file-protocol.js";

test("exact entry receives a fresh nonce; other local GET assets use original session fetch without recursion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renderer-policy-test-"));
  try {
    const entry = join(directory, "index.html");
    await writeFile(
      entry,
      await readFile(
        new URL("../src/renderer/index.html", import.meta.url),
        "utf8",
      ),
    );
    let handler: (request: Request) => Promise<Response>;
    let registrations = 0;
    const forwarded: { url: string; bypass: boolean }[] = [];
    const owner = {
      protocol: {
        handle: (_scheme: string, value: typeof handler) => {
          handler = value;
          registrations++;
        },
      },
      fetch: async (
        request: Request,
        options: { bypassCustomProtocolHandlers: boolean },
      ) => {
        forwarded.push({
          url: request.url,
          bypass: options.bypassCustomProtocolHandlers,
        });
        return new Response("original asset");
      },
    } as unknown as Session;
    installRendererFileProtocol(owner, entry);
    installRendererFileProtocol(owner, entry);
    assert.equal(registrations, 1);
    assert.throws(() =>
      installRendererFileProtocol(owner, join(directory, "other.html")),
    );
    const url = pathToFileURL(entry).href;
    const a = await handler!(new Request(url)),
      b = await handler!(new Request(url));
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("cache-control"), "no-store");
    const first = await a.text(),
      second = await b.text();
    const nonce = (text: string) =>
      /name="zenx-style-nonce" content="([^"]+)"/.exec(text)?.[1];
    assert.ok(
      nonce(first) && nonce(second) && nonce(first) !== nonce(second),
      "new document response has independent nonce",
    );
    for (const target of [
      url + "?x=1",
      url + "#x",
      url.replace("index.html", "%69ndex.html"),
      pathToFileURL(join(directory, "asset.css")).href,
    ]) {
      assert.equal(
        await (await handler!(new Request(target))).text(),
        "original asset",
      );
    }
    assert.equal(forwarded.length, 4);
    assert.ok(forwarded.every((request) => request.bypass));
    assert.equal(
      (await handler!(new Request(url, { method: "POST" }))).status,
      403,
    );
    for (const other of [
      new Request("file://remote/share/index.html"),
      new Request(pathToFileURL(join(directory, "asset.css")).href, {
        method: "HEAD",
      }),
    ])
      assert.equal(await (await handler!(other)).text(), "original asset");
    await writeFile(entry, "<html>invalid security template</html>");
    assert.equal((await handler!(new Request(url))).status, 500);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed synchronous registration is not marked installed or retried via overwrite", () => {
  let attempts = 0;
  const owner = {
    protocol: {
      handle: () => {
        attempts++;
        if (attempts === 1) throw new Error("existing file handler");
      },
    },
  } as unknown as Session;
  assert.throws(
    () => installRendererFileProtocol(owner, "/trusted/index.html"),
    /existing file handler/u,
  );
  installRendererFileProtocol(owner, "/trusted/index.html");
  installRendererFileProtocol(owner, "/trusted/index.html");
  assert.equal(attempts, 2);
});
