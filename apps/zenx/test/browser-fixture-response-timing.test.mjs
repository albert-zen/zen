import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
const source = readFileSync(
  new URL("../src/main/browser-fixture-response-timing.ts", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const { observeFixtureResponseTiming } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);
test("records receipt and actual finish/close without response mutation or payload", () => {
  const response = new EventEmitter();
  const events = [];
  let time = 100;
  observeFixtureResponseTiming(
    response,
    (e) => events.push(e),
    () => time++,
  );
  response.emit("finish", { secret: "not retained" });
  response.emit("finish");
  response.emit("close");
  assert.deepEqual(events, [
    { phase: "received", atMs: 100 },
    { phase: "response-finished", atMs: 101 },
    { phase: "response-closed", atMs: 102 },
  ]);
});
test("aborted response does not fabricate finish", () => {
  const response = new EventEmitter();
  const events = [];
  observeFixtureResponseTiming(response, (e) => events.push(e));
  response.emit("close");
  assert.deepEqual(
    events.map((e) => e.phase),
    ["received", "response-closed"],
  );
});
