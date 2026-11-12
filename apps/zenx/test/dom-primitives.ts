// Browser primitives used by accessible portal controls. Each test still owns its DOM.
import * as React from "react";
Object.assign(globalThis, { React });
import { JSDOM } from "jsdom";
let currentWindow = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
}).window;
function prepare(window: typeof currentWindow) {
  window.requestAnimationFrame ??= (callback) =>
    window.setTimeout(() => callback(Date.now()), 0);
  window.cancelAnimationFrame ??= (id) => window.clearTimeout(id);
  window.Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  window.Range.prototype.getBoundingClientRect ??= () => ({
    left: 0,
    top: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON() {},
  });
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.setPointerCapture ??= () => {};
  window.HTMLElement.prototype.releasePointerCapture ??= () => {};
  return window;
}
prepare(currentWindow);
Object.defineProperty(globalThis, "window", {
  configurable: true,
  get: () => currentWindow,
  set: (value) => {
    currentWindow = prepare(value);
  },
});
Object.assign(globalThis, { document: currentWindow.document });
for (const name of [
  "Window",
  "DocumentFragment",
  "HTMLElement",
  "Element",
  "SVGElement",
  "Node",
  "NodeFilter",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get: () => currentWindow[name],
    set: () => {},
  });
}
Object.assign(globalThis, {
  getComputedStyle: (element: Element) =>
    currentWindow.getComputedStyle(element),
  requestAnimationFrame: (callback: (time: number) => void) =>
    setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
