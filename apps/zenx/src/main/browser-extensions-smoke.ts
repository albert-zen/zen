/** Synthetic-only acceptance called by existing headed native Browser fixtures. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ZenXBrowserBackend } from "./capabilities/browser-provider.js";
export const browserExtensionsFixturePath = "/zenx-programmable-fixture-data";
export const browserExtensionsFixtureBody = JSON.stringify({
  synthetic: true,
  value: 42,
});

export async function verifyBrowserExtensions(
  backend: ZenXBrowserBackend,
  sessionId: string,
  tabId: string,
  origin: string,
): Promise<Record<string, unknown>> {
  const extension = backend.extension?.bind(backend);
  assert.ok(extension, "Provider must implement real programmable extensions");
  const url = new URL(browserExtensionsFixturePath, origin).href;
  assert.equal(
    new URL(url).hostname,
    "127.0.0.1",
    "Only disposable loopback fixture data is allowed",
  );
  await extension(sessionId, tabId, "network_start", {});
  await extension(sessionId, tabId, "console_start", {});
  // Two separate action/read invocations prove collection survives guest-call boundaries.
  let cursor: string | undefined;
  let count = 0;
  for (let round = 1; round <= 2; round++) {
    const observation = await backend.inspect(sessionId, tabId);
    const result = (await extension(sessionId, tabId, "evaluate", {
      observationId: observation.observationId,
      expression: `(async()=>{console.log('ZEN_SYNTHETIC_EXTENSION_${round}');const value=await fetch(${JSON.stringify(url + "?round=")}+${round}).then(r=>r.json());return {answer:6*7,synthetic:value.synthetic};})()`,
    })) as { value: { answer: number; synthetic: boolean } };
    assert.equal(result.value.answer, 42);
    assert.equal(result.value.synthetic, true);
    const captured = (await extension(sessionId, tabId, "network_read", {
      eventCursor: cursor,
      limit: 100,
    })) as {
      events: Array<{ method: string; params: any }>;
      eventCursor: string;
      rawPath: string;
    };
    const response = captured.events.find(
      (e) =>
        e.method === "Network.responseReceived" &&
        e.params.response.url === url + `?round=${round}`,
    );
    assert.ok(
      response,
      "Real same-origin fetch response event must be captured",
    );
    const body = (await extension(sessionId, tabId, "network_response", {
      requestId: response.params.requestId,
    })) as { body: string; base64Encoded: boolean };
    assert.deepEqual(
      JSON.parse(
        body.base64Encoded
          ? Buffer.from(body.body, "base64").toString()
          : body.body,
      ),
      JSON.parse(browserExtensionsFixtureBody),
    );
    const raw = JSON.parse(
      await readFile(captured.rawPath, "utf8"),
    ) as unknown[];
    assert.ok(raw.length >= captured.events.length);
    cursor = captured.eventCursor;
    count += captured.events.length;
  }
  const logs = (await extension(sessionId, tabId, "console_read", {})) as {
    events: unknown[];
  };
  assert.ok(JSON.stringify(logs.events).includes("ZEN_SYNTHETIC_EXTENSION_1"));
  assert.ok(JSON.stringify(logs.events).includes("ZEN_SYNTHETIC_EXTENSION_2"));
  const mainObservation = await backend.inspect(sessionId, tabId);
  const mainValue = (await extension(sessionId, tabId, "evaluate", {
    observationId: mainObservation.observationId,
    world: "main",
    expression: "window.__zenProgrammableSmoke",
  })) as { value: unknown };
  assert.equal(
    mainValue.value,
    42,
    "Pinned main-world evaluation must read the fixture application global",
  );
  const content = (await extension(sessionId, tabId, "content", {})) as {
    html: string;
  };
  assert.ok(content.html.includes("<"));
  return {
    syntheticOnly: true,
    evaluationWorld: "isolated-programmable and pinned main",
    applicationMainWorldGlobal: true,
    sameOriginFetchAndResponseBody: true,
    persistentCollectionAcrossCalls: true,
    networkEvents: count,
    consoleEvents: logs.events.length,
    rawCaptureFile: true,
    html: true,
  };
}
