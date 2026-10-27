import assert from "node:assert/strict";
import test from "node:test";
import { ComputerTargetSession, type TargetTransport } from "../src/main/capabilities/computer-target-session.js";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import { decodeComputerArguments, projectComputerResult } from "../src/main/capabilities/model-computer-facade.js";
function fixture(cap = true) {
  const calls: Record<string, unknown>[] = [];
  const transport: TargetTransport = {
    async request(request) {
      calls.push(request);
      return request.operation === "select" ? {
        bindingId: "owned", ...(cap ? { appKeyboardInputAvailable: true } : {}),
        target: { pid: 7, bundleId: "owned.test", applicationName: "Owned", windowTitle: "Original window" },
        windowId: 10, bounds: { x: 0, y: 0, width: 100, height: 100 },
      } : { dispatch: "posted", applicationEffect: "unverified", release: "posted", targetScope: "application_current_focus" };
    }, async close() {},
  };
  return { calls, session: new ComputerTargetSession(transport) };
}
const signal = new AbortController().signal;
test("app keyboard derives one owner binding without capture or window verification", async () => {
  const { calls, session } = fixture();
  await session.select("owner", { pid: 7 }, signal);
  await session.backgroundType("owner", "owned", "中文🌙🦆", signal);
  await session.backgroundKeyPress("owner", "owned", "enter", signal);
  assert.deepEqual(calls.map(c => c.operation), ["select", "backgroundType", "backgroundKeyPress"]);
  assert.equal(calls[1]?.bindingId, "owned"); assert.equal(calls[1]?.target, undefined);
  await assert.rejects(session.backgroundType("foreign", "owned", "x", signal), /binding|Select/i);
  await assert.rejects(session.backgroundType("owner", "reselected", "x", signal), /binding|changed/i);
});
test("old helper, malformed Unicode and shortcuts reject before native dispatch", async () => {
  const old = fixture(false); await old.session.select("owner", { pid: 7 }, signal);
  await assert.rejects(old.session.backgroundType("owner", "owned", "x", signal), /helper|keyboard/i);
  assert.equal(old.calls.length, 1);
  const f = fixture(); await f.session.select("owner", { pid: 7 }, signal);
  for (const text of ["", "x".repeat(1025), "\ud800"])
    await assert.rejects(f.session.backgroundType("owner", "owned", text, signal), /Unicode|text/i);
  await assert.rejects(f.session.backgroundKeyPress("owner", "owned", "command+a", signal), /key/i);
  assert.equal(f.calls.length, 1);
  await f.session.backgroundType("owner", "owned", "🦆".repeat(1024), signal);
});
test("model app input consumes only an existing typed binding ref, never raw routing", () => {
  const refs = new ModelReferenceRegistry().scope("owner");
  const projected = projectComputerResult({ bindingId: "owned" }, {}, refs, "epoch");
  assert.deepEqual(decodeComputerArguments("computer_background_type", { binding: projected.binding, text: "中文🌙" }, refs, "epoch"), { bindingId: "owned", text: "中文🌙" });
  for (const extra of [{ pid: 7 }, { target: {} }, { capture: projected.binding }, { modifiers: ["command"] }])
    assert.throws(() => decodeComputerArguments("computer_background_type", { binding: projected.binding, text: "x", ...extra }, refs, "epoch"), /only|accept|binding/i);
  assert.throws(() => decodeComputerArguments("computer_background_type", { binding: projected.binding, text: "x" }, refs, "retired"), /retired|reference/i);
});
