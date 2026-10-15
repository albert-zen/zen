import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Icon } from "../src/renderer/src/icons.js";
Object.assign(globalThis, { React });

test("Fork keeps all three branch endpoints and their strokes inside its shared viewBox", () => {
  const document = new JSDOM(
    renderToStaticMarkup(React.createElement(Icon, { name: "fork" })),
  ).window.document;
  const svg = document.querySelector("svg")!;
  const [x, y, width, height] = svg
    .getAttribute("viewBox")!
    .split(" ")
    .map(Number);
  const stroke =
    Number(document.querySelector("g")!.getAttribute("stroke-width")) / 2;
  const endpoints = [...document.querySelectorAll("circle")];
  assert.equal(endpoints.length, 3);
  for (const circle of endpoints) {
    const cx = Number(circle.getAttribute("cx"));
    const cy = Number(circle.getAttribute("cy"));
    const radius = Number(circle.getAttribute("r")) + stroke;
    assert(
      cx - radius >= x! && cx + radius <= x! + width!,
      "Fork endpoint is horizontally clipped",
    );
    assert(
      cy - radius >= y! && cy + radius <= y! + height!,
      "Fork endpoint is vertically clipped",
    );
  }
});

test("Fork branch strokes leave all three endpoint holes open", async () => {
  const { Resvg } = await import("@resvg/resvg-js");
  const svg = renderToStaticMarkup(
    React.createElement(Icon, {
      name: "fork",
      xmlns: "http://www.w3.org/2000/svg",
    }),
  );
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: 160 },
  }).render();
  const document = new JSDOM(svg).window.document;
  for (const circle of document.querySelectorAll("circle")) {
    const x = Number(circle.getAttribute("cx")) * 10;
    const y = Number(circle.getAttribute("cy")) * 10;
    assert.equal(
      rendered.pixels[(y * rendered.width + x) * 4 + 3],
      0,
      "A branch stroke intrudes into an endpoint hole",
    );
  }
});
