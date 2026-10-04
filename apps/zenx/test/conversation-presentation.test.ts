import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  CONVERSATION_DETAIL_STORAGE_KEY,
  createConversationPresentationStore,
  getConversationPresentationStore,
} from "../src/renderer/src/conversation-presentation.js";

test("conversation detail reads only valid local preferences and never writes a default", () => {
  for (const stored of [
    null,
    "invalid",
    "verbose",
    '"debug"',
    "debug",
    "normal",
  ]) {
    const writes: string[] = [];
    const store = createConversationPresentationStore({
      getItem: (key) => {
        assert.equal(key, CONVERSATION_DETAIL_STORAGE_KEY);
        return stored;
      },
      setItem: (_key, value) => {
        writes.push(value);
      },
    });
    assert.equal(store.getSnapshot(), stored === "debug" ? "debug" : "normal");
    assert.deepEqual(writes, []);
  }
});

test("storage unavailable defaults to Normal and explicit choices still work for the window", () => {
  const store = createConversationPresentationStore({
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("storage unavailable");
    },
  });
  assert.equal(store.getSnapshot(), "normal");
  assert.doesNotThrow(() => store.setDetail("debug"));
  assert.equal(store.getSnapshot(), "debug");
  store.setDetail("normal");
  assert.equal(store.getSnapshot(), "normal");
  assert.equal(createConversationPresentationStore().getSnapshot(), "normal");
});

test("one window shares immediate detail updates and follows only relevant storage changes", () => {
  const dom = new JSDOM("<!doctype html><html></html>", {
    url: "http://localhost",
  });
  try {
    const store = getConversationPresentationStore(
      dom.window as unknown as Window,
    );
    assert.equal(
      getConversationPresentationStore(dom.window as unknown as Window),
      store,
    );
    let changes = 0;
    const unsubscribe = store.subscribe(() => {
      changes++;
    });
    store.setDetail("debug");
    assert.equal(
      dom.window.localStorage.getItem(CONVERSATION_DETAIL_STORAGE_KEY),
      "debug",
    );
    assert.equal(changes, 1);
    store.setDetail("debug");
    assert.equal(changes, 1);
    dom.window.localStorage.setItem(CONVERSATION_DETAIL_STORAGE_KEY, "normal");
    dom.window.dispatchEvent(
      new dom.window.StorageEvent("storage", { key: "another-preference" }),
    );
    assert.equal(store.getSnapshot(), "debug");
    dom.window.dispatchEvent(
      new dom.window.StorageEvent("storage", {
        key: CONVERSATION_DETAIL_STORAGE_KEY,
      }),
    );
    assert.equal(store.getSnapshot(), "normal");
    assert.equal(changes, 2);
    unsubscribe();
    store.setDetail("debug");
    assert.equal(changes, 2);
  } finally {
    dom.window.close();
  }
});
