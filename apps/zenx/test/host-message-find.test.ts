import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Turn } from "../src/protocol-client/index.js";
import type { TriggerHistoryEntry } from "../src/main/trigger-types.js";
import { HostMessageContent } from "../src/renderer/src/HostMessageContent.js";
import { Markdown } from "../src/renderer/src/Markdown.js";
import {
  createThreadReadingState,
  ThreadReadingContext,
  disclosureKey,
} from "../src/renderer/src/thread-reading-state.js";
import {
  createTranscriptFindIndexer,
  indexTurnFindText,
  searchTranscript,
} from "../src/renderer/src/transcript-find-index.js";
import { transcriptFindRange } from "../src/renderer/src/transcript-find-ranges.js";
import {
  hostMessageSummary,
  triggerMessagePresentation,
} from "../src/renderer/src/trigger-message-presentation.js";

const envelope =
  "[ZenX trigger wakeup]\nTrigger ID: trigger-a\nReason: timer\nRegistered trigger: Morning\n\nInjected prompt:\nPrompt **body**\n\nCurrent Room message (synthetic):\nTail exact";
const makeTurn = (source: "bootstrap" | "room" | "trigger", text: string) =>
  ({
    id: "t",
    status: "completed",
    items: [
      {
        type: "hostMessage",
        id: "host",
        clientId: "client",
        source,
        sourceId: source === "trigger" ? "trigger-a" : "room-a",
        mode: "start",
        text,
      },
    ],
  }) as Turn;
function renderedHost(turn: Turn, prompt?: string) {
  const item = turn.items[0] as Extract<
    Turn["items"][number],
    { type: "hostMessage" }
  >;
  const reading = createThreadReadingState();
  reading.set(disclosureKey("host", "host"), true);
  const markup = renderToStaticMarkup(
    React.createElement(
      "main",
      null,
      React.createElement(
        ThreadReadingContext.Provider,
        { value: reading },
        React.createElement(HostMessageContent, {
          source: item.source,
          sourceId: item.sourceId,
          text: item.text,
          prompt,
          findItemId: "host",
          copyAction: false,
        }),
      ),
    ),
  );
  return new JSDOM(markup);
}

test("actual Host renderer welcome, summary and original text have exact independent indexed scopes", () => {
  const bootstrap = makeTurn("bootstrap", "Welcome **visible**");
  const entries = indexTurnFindText(bootstrap);
  const dom = renderedHost(bootstrap);
  const matches = searchTranscript(entries, "visible");
  assert.deepEqual(
    matches.map((match) => match.entry.field),
    ["body", "host-original"],
  );
  for (const match of matches)
    assert.equal(
      transcriptFindRange(
        dom.window.document.querySelector("main")!,
        match,
        "visible",
      )?.toString(),
      "visible",
    );
  assert.deepEqual(
    entries.find((entry) => entry.field === "body")!.disclosures,
    [],
    "visible welcome does not expand unrelated Turn history",
  );
  assert.deepEqual(
    entries.find((entry) => entry.field === "host-original")!.disclosures,
    [disclosureKey("host", "host")],
  );
  dom.window.close();

  const room = makeTurn("room", envelope);
  const wakeups = [
    {
      clientUserMessageId: "client",
      sourceRoomId: "room-a",
      triggerId: "trigger-a",
      prompt: "Changed history prompt",
    },
  ] as TriggerHistoryEntry[];
  const indexed = createTranscriptFindIndexer()([room], new Map(), wakeups);
  const rendered = renderedHost(room, wakeups[0]!.prompt);
  const summary = hostMessageSummary(envelope, wakeups[0]!.prompt);
  assert.equal(summary, "Morning · Changed history prompt");
  const result = searchTranscript(indexed, summary)[0]!;
  assert.equal(result.entry.field, "host-summary");
  assert.equal(
    transcriptFindRange(
      rendered.window.document.querySelector("main")!,
      result,
      summary,
    )?.toString(),
    summary,
  );
  const original = searchTranscript(indexed, "Tail exact")[0]!;
  assert.equal(original.entry.field, "host-original");
  assert.equal(
    transcriptFindRange(
      rendered.window.document.querySelector("main")!,
      original,
      "Tail exact",
    )?.toString(),
    "Tail exact",
  );
  rendered.window.close();
});

test("known Host and legacy user Trigger bubbles search the actual projected Markdown body, not hidden envelopes", () => {
  const host = makeTurn("trigger", envelope);
  const entries = indexTurnFindText(host);
  assert.equal(searchTranscript(entries, "Trigger ID").length, 0);
  const match = searchTranscript(entries, "Prompt body")[0]!;
  const markup = renderToStaticMarkup(
    React.createElement(
      "main",
      null,
      React.createElement(
        "div",
        { "data-thread-find-item-id": "host" },
        React.createElement(Markdown, {
          text: triggerMessagePresentation(envelope, "trigger-a").text,
        }),
      ),
    ),
  );
  const dom = new JSDOM(markup);
  assert.equal(
    transcriptFindRange(
      dom.window.document.querySelector("main")!,
      match,
      "Prompt body",
    )?.toString(),
    "Prompt body",
  );
  assert.equal(
    searchTranscript(entries, "Tail exact").length,
    1,
    "projection keeps the renderer's trailing context body intact",
  );
  dom.window.close();
  const user = {
    id: "u",
    status: "completed",
    items: [
      {
        type: "userMessage",
        id: "legacy",
        clientId: "client",
        content: [{ type: "text", text: envelope, text_elements: [] }],
      },
    ],
  } as Turn;
  const wakeups = [
    {
      clientUserMessageId: "client",
      triggerId: "trigger-a",
      prompt: "Prompt **body**",
    },
  ] as TriggerHistoryEntry[];
  const index = createTranscriptFindIndexer();
  assert.equal(
    searchTranscript(index([user], new Map(), wakeups), "Trigger ID").length,
    0,
  );
  assert.equal(
    searchTranscript(index([user], new Map(), []), "Trigger ID").length,
    1,
    "wakeup metadata removal invalidates only the affected presentation cache",
  );
});

test("only hidden middle responses and trace detail matches request their Turn disclosure", () => {
  const turn = {
    id: "t",
    status: "completed",
    items: [
      {
        type: "userMessage",
        id: "u",
        clientId: null,
        content: [{ type: "text", text: "input", text_elements: [] }],
      },
      { type: "agentMessage", id: "middle", text: "intermediate" },
      { type: "agentMessage", id: "final", text: "final" },
    ],
  } as Turn;
  const entries = indexTurnFindText(turn);
  assert.deepEqual(
    entries.find((entry) => entry.itemId === "u")!.disclosures,
    [],
  );
  assert.deepEqual(
    entries.find((entry) => entry.itemId === "final")!.disclosures,
    [],
  );
  assert.deepEqual(
    entries.find((entry) => entry.itemId === "middle")!.disclosures,
    [disclosureKey("turn", "t")],
  );
});
