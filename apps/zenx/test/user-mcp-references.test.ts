import assert from "node:assert/strict";
import test from "node:test";
import {
  mapUserMcpReferences,
  mapUserMcpReferenceSchema,
} from "../src/main/user-mcp-references.js";

const map = (ref: unknown) => {
  assert.match(String(ref), /^r[1-9][0-9]*$/);
  return `connection:${ref}`;
};
test("MCP reference envelopes visit typed facade slots while authored strings remain literal", () => {
  const sidebar = {
    snapshot: "r1",
    scope: { ref: "r2", name: "r2" },
    authorizedScopes: [{ ref: "r3", name: "r3" }],
    state: {
      selectedTab: "r4",
      resourceThread: "r5",
      tabs: [
        { ref: "r4", thread: "r5", resourceThread: "r6", id: "r4", url: "r6" },
      ],
    },
    information: {
      cursor: "r7",
      widgets: [{ ref: "r8", type: "board", config: { instanceKey: "r8" } }],
    },
  };
  mapUserMcpReferences(
    "zenx_self_control_sidebar_read",
    sidebar,
    "output",
    map,
  );
  assert.deepEqual(sidebar, {
    snapshot: "connection:r1",
    scope: { ref: "connection:r2", name: "r2" },
    authorizedScopes: [{ ref: "connection:r3", name: "r3" }],
    state: {
      selectedTab: "connection:r4",
      resourceThread: "connection:r5",
      tabs: [
        {
          ref: "connection:r4",
          thread: "connection:r5",
          resourceThread: "connection:r6",
          id: "r4",
          url: "r6",
        },
      ],
    },
    information: {
      cursor: "connection:r7",
      widgets: [
        { ref: "connection:r8", type: "board", config: { instanceKey: "r8" } },
      ],
    },
  });
  const patch = {
    snapshot: "r1",
    patch: {
      selectedTab: "r2",
      tabs: [
        { ref: "r2" },
        { kind: "custom", id: "r4" },
        { kind: "thread", thread: "r3" },
        { kind: "browser", tab: "r5" },
      ],
      information: {
        operations: [
          { op: "move", id: "r6", before: "r7" },
          {
            op: "add",
            type: "board",
            config: { instanceKey: "r8" },
            before: null,
          },
        ],
      },
    },
  };
  mapUserMcpReferences("zenx_self_control_sidebar_update", patch, "input", map);
  assert.equal(patch.patch.tabs[1]!.id, "r4");
  assert.equal(patch.patch.tabs[2]!.thread, "connection:r3");
  assert.equal(patch.patch.tabs[3]!.tab, "connection:r5");
  assert.deepEqual(patch.patch.information.operations, [
    { op: "move", id: "connection:r6", before: "connection:r7" },
    { op: "add", type: "board", config: { instanceKey: "r8" }, before: null },
  ]);
  const board = {
    snapshot: "r1",
    owner: { kind: "room", room: "r2" },
    document: {
      owner: { kind: "room", room: "r2" },
      id: "r1",
      title: "r2",
      blocks: [{ id: "r2", kind: "note", text: "r3" }],
      initialValues: { ref: "r4" },
      html: "r5",
      events: [
        {
          id: "r6",
          actions: [
            {
              kind: "if",
              field: "r7",
              equals: "r8",
              then: [
                { kind: "navigate", target: { kind: "browser", tab: "r9" } },
              ],
              otherwise: [
                { kind: "navigate", target: { kind: "url", url: "r10" } },
              ],
            },
          ],
        },
      ],
    },
  };
  const literal = structuredClone(board.document);
  mapUserMcpReferences("zenx_board_put", board, "input", map);
  literal.owner.room = "connection:r2";
  literal.events[0]!.actions[0]!.then[0]!.target.tab = "connection:r9";
  assert.deepEqual(board.document, literal);
  const history = {
    ref: "r1",
    nextCursor: "r2",
    thread: { ref: "r1", name: "r3", lastTurn: { turn: "r4" } },
    turns: [
      {
        turn: "r4",
        items: [
          {
            ref: "r5",
            turn: "r4",
            text: "r6",
            arguments: { ref: "r7" },
            output: "r8",
          },
        ],
      },
    ],
  };
  mapUserMcpReferences("zenx_threads_read", history, "output", map);
  assert.equal(history.nextCursor, "connection:r2");
  assert.deepEqual(history.turns[0]!.items[0], {
    ref: "connection:r5",
    turn: "connection:r4",
    text: "r6",
    arguments: { ref: "r7" },
    output: "r8",
  });
  const historyInput = {
    cursor: "r1",
    turn: "r2",
    item: "r3",
    through: "r4",
    granularity: "r5",
  };
  mapUserMcpReferences("zenx_threads_read", historyInput, "input", map);
  assert.deepEqual(historyInput, {
    cursor: "connection:r1",
    turn: "connection:r2",
    item: "connection:r3",
    through: "connection:r4",
    granularity: "r5",
  });
});

test("MCP reference schema envelope follows nested property/items/union nodes only", () => {
  const ref = { type: "string", pattern: "^r[1-9][0-9]*$" };
  const schema = {
    type: "object",
    properties: {
      cursor: { ...ref },
      patch: {
        type: "array",
        items: {
          anyOf: [
            {
              properties: {
                id: { ...ref },
                before: { anyOf: [{ ...ref }, { type: "null" }] },
              },
            },
          ],
        },
      },
      config: { type: "string", pattern: "literal" },
    },
    description: "^r[1-9][0-9]*$",
  };
  mapUserMcpReferenceSchema(schema, "^connection:r[1-9][0-9]*$");
  assert.equal(schema.properties.cursor.pattern, "^connection:r[1-9][0-9]*$");
  const nestedRef =
    schema.properties.patch.items.anyOf[0]!.properties.before.anyOf[0]!;
  assert("pattern" in nestedRef);
  assert.equal(nestedRef.pattern, "^connection:r[1-9][0-9]*$");
  assert.equal(schema.properties.config.pattern, "literal");
  assert.equal(schema.description, "^r[1-9][0-9]*$");
});
