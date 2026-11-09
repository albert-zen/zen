import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  instrumentSteerReader,
  installSteerScrollDiagnostic,
} from "../scripts/steer-scroll-diagnostic.mjs";

test("reader probes require exact source anchors and preserve surrounding source", () => {
  const source = [
    "const pauseFollowing = useCallback(() => {",
    "const followBottom = useCallback(() => {",
    "onWheel={(event) => {",
  ].join("\n");
  const result = instrumentSteerReader(source);
  assert.equal(result.match(/__steerRecord/g).length, 3);
  assert.ok(result.includes("following: shouldFollowRef.current"));
  assert.throws(() => instrumentSteerReader(source + source));
  assert.throws(() => instrumentSteerReader(""));
});

test("diagnostic observes without changing native setter or scroll method outcomes", () => {
  class Element {
    top = 0;
    get scrollTop() {
      return this.top;
    }
    set scrollTop(value) {
      if (value === -1) throw Error("native rejection");
      this.top = Number(value);
    }
    scrollTo(value) {
      this.scrollTop = value;
      return "native result";
    }
    matches(selector) {
      return selector === ".messages";
    }
  }
  const context = vm.createContext({
    Element,
    Node: Element,
    performance: { now: () => 1 },
    document: { addEventListener() {} },
  });
  vm.runInContext(`(${installSteerScrollDiagnostic.toString()})()`, context);
  const element = new Element();
  element.scrollTop = 585;
  assert.equal(element.scrollTo(0), "native result");
  assert.equal(element.scrollTop, 0);
  assert.throws(() => {
    element.scrollTop = -1;
  }, /native rejection/);
  for (let i = 0; i < 510; i++) element.scrollTop = i;
  assert.equal(element.scrollTop, 509);
  assert.equal(context.__steerScrollTrace.entries.length, 500);
  assert.ok(context.__steerScrollTrace.dropped > 0);
});

test("diagnostic is opt-in, selects one fresh scene, retains failure trace and leaves full matrix", () => {
  const capture = readFileSync(
    new URL("../scripts/capture-steer-image-preview.mjs", import.meta.url),
    "utf8",
  );
  const build = readFileSync(
    new URL("../scripts/build-steer-image-preview.mjs", import.meta.url),
    "utf8",
  );
  assert.match(capture, /process\.argv\.includes\("--diagnostic"\)/);
  assert.match(capture, /diagnostic && scene !== "en-dark-390-2-long-held"/);
  assert.match(capture, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(capture, /scroll-diagnostic\.json/);
  assert.match(capture, /assertSteerWheelReceipt\(receipt\)/);
  assert.match(
    capture,
    /captureExitCode\(lifecycle\.receipt\.captureStatus, closed\)/,
  );
  assert.match(build, /minify: !diagnostic/);
  assert.match(build, /plugins: diagnostic/);
  assert.doesNotMatch(capture, /--no-sandbox|--disable-web-security/);
});
