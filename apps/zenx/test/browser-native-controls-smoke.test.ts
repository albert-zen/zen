import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { targetedInputContractPage } from "../src/main/browser-parallel-input-smoke.js";

for (const mode of ["light-native", "shadow"]) {
  test(`${mode} smoke cancels picker defaults without hiding paired event witnesses`, () => {
    const dom = new JSDOM(targetedInputContractPage(`/?mode=${mode}`), {
      runScripts: "dangerously",
    });
    try {
      const host = dom.window.document.querySelector("#contract-host")!;
      const root = host.shadowRoot ?? host;
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
