import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  evaluationPage,
  createEvaluationServer,
} from "../evals/browser-computer/fixture.mjs";

test("form requires exact values and navigation starts a fresh task", () => {
  const dom = new JSDOM(evaluationPage("form"), { runScripts: "dangerously" });
  const doc = dom.window.document;
  doc.querySelector("button").click();
  assert.match(doc.querySelector("output").textContent, /^FAIL/);
  doc.querySelector("#recipient").value = "ZenX 测试";
  doc.querySelector("#city").value = "杭州";
  doc.querySelector("button").click();
  assert.match(doc.querySelector("output").textContent, /^PASS/);
  const fresh = new JSDOM(evaluationPage("form"));
  assert.equal(
    fresh.window.document.querySelector("output").textContent,
    "Not saved",
  );
  dom.window.close();
  fresh.window.close();
});

test("replacement really detaches the old control and disabled input does nothing", () => {
  const dom = new JSDOM(evaluationPage("stale"), { runScripts: "dangerously" });
  const doc = dom.window.document;
  const old = doc.querySelector("#confirm");
  doc.querySelector("#refresh").click();
  assert.equal(old.isConnected, false);
  assert.equal(doc.querySelector("#confirm").textContent, "Confirm current");
  doc.querySelector("#confirm").click();
  assert.match(doc.querySelector("output").textContent, /^PASS/);
  dom.window.close();
  const disabled = new JSDOM(evaluationPage("disabled"), {
    runScripts: "dangerously",
  });
  disabled.window.document.querySelector("button[disabled]").click();
  assert.equal(
    disabled.window.document.querySelector("output").textContent,
    "Not submitted",
  );
  disabled.window.document.querySelector("button:not([disabled])").click();
  assert.match(
    disabled.window.document.querySelector("output").textContent,
    /^PASS/,
  );
  disabled.window.close();
});

test("fixture serves only known local GET routes", async () => {
  const server = createEvaluationServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.match(await (await fetch(`${url}/scroll`)).text(), /height:2200px/);
    assert.equal((await fetch(`${url}/unknown`)).status, 404);
    assert.equal((await fetch(`${url}/form`, { method: "POST" })).status, 405);
    assert.match(await (await fetch(`${url}/tabs`)).text(), /target="_blank"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("preferences reports actual select, checkbox and rich-text values", () => {
  const dom = new JSDOM(evaluationPage("preferences"), {
    runScripts: "dangerously",
  });
  try {
    const doc = dom.window.document;
    doc.querySelector("#save").click();
    assert.deepEqual(JSON.parse(doc.querySelector("output").textContent), {
      speed: "standard",
      updates: false,
      note: "",
    });
    doc.querySelector("#speed").value = "express";
    doc.querySelector("#updates").click();
    doc.querySelector("#note").textContent = "门口轻放";
    doc.querySelector("#save").click();
    assert.deepEqual(JSON.parse(doc.querySelector("output").textContent), {
      speed: "express",
      updates: true,
      note: "门口轻放",
    });
  } finally {
    dom.window.close();
  }
});
