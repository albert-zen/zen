import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { targetedInputContractPage } from "../src/main/browser-parallel-input-smoke.js";

for (const mode of ["light-native", "shadow", "same-origin-frame"]) {
  test(`${mode} smoke cancels picker defaults without hiding paired event witnesses`, () => {
    const dom = new JSDOM(targetedInputContractPage(`/?mode=${mode}`), {
      runScripts: "dangerously",
    });
    try {
      const host = dom.window.document.querySelector("#contract-host")!;
      const frame = host.querySelector("iframe");
      const root = frame?.contentDocument?.body ?? host.shadowRoot ?? host;
      for (const type of ["file", "color", "date", "select"]) {
        for (const id of [`native-${type}`, `label-${type}`]) {
          const element = root.querySelector(`#${id}`)!;
          for (const eventType of [
            "pointerdown",
            "pointerup",
            "keydown",
            "keyup",
            "mousedown",
            "click",
          ]) {
            const event = new dom.window.Event(eventType, {
              bubbles: true,
              composed: true,
              cancelable: true,
            });
            (element.querySelector("span") ?? element).dispatchEvent(event);
            assert.equal(event.defaultPrevented, eventType !== "pointerup");
          }
        }
      }
      const events = dom.window.contract.state().events as {
        type: string;
        target: string;
        trusted: boolean;
      }[];
      assert.equal(events.length, 32);
      for (let offset = 0; offset < events.length; offset += 4) {
        assert.deepEqual(
          Array.from(events.slice(offset, offset + 4), (event) => event.type),
          ["pointerdown", "pointerup", "keydown", "keyup"],
        );
        assert.ok(
          events
            .slice(offset, offset + 4)
            .every((event) => event.target === events[offset]!.target),
        );
      }
      assert.ok(
        events.every((event) => !event.trusted),
        "JSDOM is synthetic evidence, not a real native input claim",
      );
      const ordinary = new dom.window.Event("pointerdown", {
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      root.querySelector("#canvas")!.dispatchEvent(ordinary);
      assert.equal(ordinary.defaultPrevented, false);
    } finally {
      dom.window.close();
    }
  });
}

for (const mode of ["closed-shadow", "same-origin-closed-shadow"]) {
  test(`${mode} native fixture begins with observable inner focus`, () => {
    const dom = new JSDOM(targetedInputContractPage(`/?mode=${mode}`), {
      runScripts: "dangerously",
    });
    try {
      assert.equal(dom.window.contract.focus("text-a").inner, "text-a");
      assert.equal(dom.window.contract.state().mode, mode);
      assert.deepEqual(Array.from(dom.window.contract.state().events), []);
      assert.ok(Number.isFinite(dom.window.contract.point("text-a").x));
    } finally {
      dom.window.close();
    }
  });
}
