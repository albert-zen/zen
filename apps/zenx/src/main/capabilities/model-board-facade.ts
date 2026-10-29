import type { ModelTool } from "../../../../../src/model.js";
import type { ToolExecutionResult } from "../../../../../src/tool.js";
import {
  ModelReferenceBudgetError,
  type ModelReferenceScope,
} from "../../../../../src/model-references.js";
import { browserSidebarDescriptor } from "./model-browser-facade.js";
import {
  attachBrowserSidebarTargets,
  readBrowserSidebarTargets,
  type BrowserModelRoute,
} from "./model-browser-metadata.js";
import {
  MODEL_REF,
  asJson,
  object,
  only,
  record,
} from "./model-facade-fields.js";

export const isBoardModelTool = (name: string) =>
  name === "zenx_board_put" || name === "zenx_board_read";

export const boardModelDocument = `Compose conversation-owned information Boards with short authored document/block/event IDs. Owner defaults to { kind: 'thread' } for the calling Thread; Room ownership uses { kind: 'room', room: <scoped Room ref> } and still requires current membership. put preserves user field values and does not execute actions. read defaults to compact semantic state; explicitly request view: 'document' for complete authored blocks, events, HTML/CSS/JS and current values before editing.

Templates compose freely with isolated custom HTML/CSS/JS. Every block has id and kind: note needs text, optional title; metric needs title/value (string), optional detail; progress needs title/value (number), optional positive max; field needs label/field, optional input (text default, textarea, select, checkbox), options and placeholder; action needs label/event (declared event ID), optional emphasis. For a form/question, pair fields with an explicit action, for example blocks: [{ id: 'question', kind: 'field', label: 'Choose a scope', field: 'choice', input: 'select', options: ['Small', 'Full'] }, { id: 'answerButton', kind: 'action', label: 'Send answer', event: 'answer', emphasis: true }], initialValues: { choice: 'Small' }, events: [{ id: 'answer', label: 'Send answer', actions: [{ kind: 'submit', text: 'My choice: {{choice}}' }] }]. Fields are draft data, never approval.

Submit text interpolates {{field}}; scripts interpolate only {{valuesBase64}} as base64 JSON, never user text directly into shell code. if actions use field/equals with then/otherwise actions and may inspect result.exitCode/result.output after confirmed script completion. Navigate actions use target: { kind: 'url', url } or { kind: 'browser' | 'external-browser', tab: <exact Browser tab ref> }; a full read marks closed targets unavailable without losing the rest of the document.

Custom HTML receives window.zenxPluginUi. Read zenxPluginUi.context.board and zenxPluginUi.context.values; listen for zenx-plugin-ui:change to refresh them. From a genuine user click/key handler, await zenxPluginUi.commands.execute('draft', { choice: 'Full' }) to save a scalar field map (not a nested values object), or await zenxPluginUi.commands.execute('event', { eventId: 'answer', values: { choice: 'Full' } }) to request a declared event; values is optional. Inspect the event result.error before continuing. await zenxPluginUi.navigation.navigate('https://example.test/result') opens only an absolute HTTP(S) URL through the Host, never an application route. commands.execute('navigate', { target }) also accepts a typed URL or an existing native Browser target; model authors should instead declare Browser navigation events using scoped tab refs and invoke those event IDs, never invent or embed native target IDs.

For asynchronous interaction chains, begin inside the user handler and use only the callback's scoped SDK: await zenxPluginUi.interaction.run(async (sdk) => { const result = await sdk.commands.execute('event', { eventId: 'answer' }); if (result.error) throw new Error(result.error); await sdk.navigation.navigate('https://example.test/result'); }). This retains the witnessed gesture across script awaits longer than the direct five-second window, for at most five minutes and only the same mounted document revision and owner; the scope ends when the callback finishes. It does not grant approval, bypass existing permissions, schedule background work or authorize a replacement document. Local, submit, script and conditional events require explicit user interaction, never merely read/put. No automatic retry of errors or unknown outcomes.`;

const ownerSchema = {
  anyOf: [
    {
      type: "object",
      properties: { kind: { const: "thread" } },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "room" }, room: MODEL_REF },
      required: ["kind", "room"],
      additionalProperties: false,
    },
  ],
  description:
    "Calling Thread, or an exact scoped Room with current membership.",
};
const targetSchema = {
  anyOf: [
    {
      type: "object",
      properties: { kind: { const: "url" }, url: { type: "string" } },
      required: ["kind", "url"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { enum: ["browser", "external-browser"] },
        tab: MODEL_REF,
      },
      required: ["kind", "tab"],
      additionalProperties: false,
    },
  ],
};
const scalarSchema = {
  anyOf: [
    { type: "string", maxLength: 8192 },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};
const valuesSchema = {
  type: "object",
  maxProperties: 128,
  additionalProperties: scalarSchema,
  description:
    "Short field names with bounded scalar values; draft values never grant approval.",
};
const shortIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-zA-Z][a-zA-Z0-9_.-]*$",
  description: "Authored short ID; reserved prototype keys are not allowed.",
};
const labelSchema = { type: "string", minLength: 1, maxLength: 256 };
const bodySchema = { type: "string", minLength: 1, maxLength: 8192 };
const blockSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        id: shortIdSchema,
        kind: { const: "note" },
        text: bodySchema,
        title: labelSchema,
      },
      required: ["id", "kind", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        id: shortIdSchema,
        kind: { const: "metric" },
        title: labelSchema,
        value: labelSchema,
        detail: bodySchema,
      },
      required: ["id", "kind", "title", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        id: shortIdSchema,
        kind: { const: "progress" },
        title: labelSchema,
        value: { type: "number", minimum: 0 },
        max: { type: "number", exclusiveMinimum: 0 },
      },
      required: ["id", "kind", "title", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        id: shortIdSchema,
        kind: { const: "field" },
        label: labelSchema,
        field: shortIdSchema,
        input: {
          enum: ["text", "textarea", "select", "checkbox"],
          description: "Defaults to text; checkbox values are booleans.",
        },
        options: { type: "array", maxItems: 100, items: labelSchema },
        placeholder: labelSchema,
      },
      required: ["id", "kind", "label", "field"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        id: shortIdSchema,
        kind: { const: "action" },
        label: labelSchema,
        event: {
          ...shortIdSchema,
          description: "Exact ID of an event declared in this document.",
        },
        emphasis: { type: "boolean" },
      },
      required: ["id", "kind", "label", "event"],
      additionalProperties: false,
    },
  ],
};
function actionSchema(nested = false): Record<string, unknown> {
  const children = {
    type: "array",
    maxItems: 128,
    items: nested
      ? {
          type: "object",
          description:
            "The same set/navigate/submit/script/if action shape recursively. At most six conditional levels and 128 total actions per document; native validation enforces every nested action.",
        }
      : actionSchema(true),
  };
  return {
    type: "object",
    properties: {
      kind: { enum: ["set", "navigate", "submit", "script", "if"] },
      values: valuesSchema,
      target: targetSchema,
      text: {
        type: "string",
        minLength: 1,
        maxLength: 100000,
        description:
          "submit: explicit model message with {{field}} substitution.",
      },
      command: {
        type: "string",
        minLength: 1,
        maxLength: 100000,
        description:
          "script: existing permission-gated shell command. Only {{valuesBase64}} interpolation is allowed; decode JSON rather than interpolating user text into code.",
      },
      timeoutMs: { type: "integer", minimum: 1, maximum: 86400000 },
      field: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description:
          "if: exact scalar field, including result.exitCode/result.output after confirmed execution.",
      },
      equals: scalarSchema,
      then: children,
      otherwise: children,
    },
    required: ["kind"],
    additionalProperties: false,
    description:
      "set requires values; navigate requires target; submit requires text; script requires command; if requires field, equals and then, with optional otherwise.",
  };
}
export function boardModelDefinition<T extends ModelTool>(source: T): T {
  const tool = structuredClone(source);
  tool.description =
    source.name === "zenx_board_read"
      ? "Read compact semantic Board state by default, or explicitly request view:'document' for complete authored content and current draft values. Drafts are not approval; native owner membership still applies."
      : "Replace an authored Board document without executing its events or overwriting user draft fields. Owner uses the calling Thread or a scoped Room ref; Browser navigation uses exact tab refs, never native IDs.";
  tool.inputSchema =
    source.name === "zenx_board_read"
      ? {
          type: "object",
          properties: {
            owner: ownerSchema,
            view: { enum: ["semantic", "document"] },
          },
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: {
            document: {
              type: "object",
              properties: {
                id: shortIdSchema,
                title: labelSchema,
                summary: { type: "string", minLength: 1, maxLength: 1024 },
                owner: ownerSchema,
                blocks: { type: "array", maxItems: 64, items: blockSchema },
                initialValues: valuesSchema,
                html: { type: "string", minLength: 1, maxLength: 200000 },
                events: {
                  type: "array",
                  maxItems: 32,
                  items: {
                    type: "object",
                    properties: {
                      id: shortIdSchema,
                      label: labelSchema,
                      actions: {
                        type: "array",
                        maxItems: 128,
                        items: actionSchema(),
                      },
                    },
                    required: ["id", "label", "actions"],
                  },
                },
              },
              required: ["id", "title", "summary", "blocks", "events"],
              additionalProperties: false,
            },
          },
          required: ["document"],
          additionalProperties: false,
        };
  return tool;
}

function decodeOwner(value: unknown, refs: ModelReferenceScope) {
  const owner = object(value ?? { kind: "thread" });
  if (owner.kind === "thread") {
    only(owner, ["kind"]);
    return { kind: "thread", threadId: refs.ownerThreadId };
  }
  if (owner.kind === "room") {
    only(owner, ["kind", "room"]);
    const room = object(refs.resolve(owner.room, "rooms", "room"));
    if (typeof room.id !== "string" || !room.id)
      throw Error(
        "Room reference has no exact native identity; read Rooms again",
      );
    return { kind: "room", roomId: room.id, threadId: refs.ownerThreadId };
  }
  throw Error("Board owner must be the calling Thread or a scoped Room");
}

/** Rewrite only typed action targets, never authored text, values, commands or HTML. */
function mapActions(
  document: Record<string, unknown>,
  target: (value: unknown) => unknown,
  preserveLegacyRoutes = false,
): void {
  let count = 0;
  const actions = (values: unknown, depth = 0): unknown[] => {
    if (!Array.isArray(values) || depth > 6)
      throw Error("Board actions must be bounded arrays");
    return values.map((value) => {
      if (++count > 128) throw Error("Too many Board actions");
      const action = object(value);
      if (action.kind === "navigate") {
        if (
          preserveLegacyRoutes &&
          typeof action.route === "string" &&
          action.target === undefined
        )
          return {
            ...action,
            status: "unavailable",
            reason:
              "Legacy navigation is inert; review and replace it with an explicit typed target before use.",
          };
        only(action, ["kind", "target"]);
        return { ...action, target: target(action.target) };
      }
      if (action.kind === "if")
        return {
          ...action,
          then: actions(action.then, depth + 1),
          ...(action.otherwise === undefined
            ? {}
            : { otherwise: actions(action.otherwise, depth + 1) }),
        };
      return action;
    });
  };
  if (!Array.isArray(document.events))
    throw Error("Board events must be an array");
  document.events = document.events.map((value) => {
    const event = object(value);
    return { ...event, actions: actions(event.actions) };
  });
}

export function decodeBoardArguments(
  name: string,
  input: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  const args = structuredClone(input);
  if (name === "zenx_board_read") {
    only(args, ["owner", "view"]);
    if (
      args.view !== undefined &&
      !["semantic", "document"].includes(String(args.view))
    )
      throw Error("Board view must be semantic or document");
    return { ...args, owner: decodeOwner(args.owner, refs) };
  }
  only(args, ["document"]);
  const document = object(args.document);
  document.owner = decodeOwner(document.owner, refs);
  const targets = new Map<string, BrowserModelRoute>();
  mapActions(document, (value) => {
    const target = object(value);
    if (target.kind === "url") {
      only(target, ["kind", "url"]);
      return target;
    }
    if (target.kind !== "browser" && target.kind !== "external-browser")
      throw Error("Unknown Board navigation target");
    only(target, ["kind", "tab"]);
    const browser = browserSidebarDescriptor(
      target.tab,
      target.kind,
      refs,
      epoch,
    );
    if (browser.route.ownerThreadId !== refs.ownerThreadId)
      throw Error("Board Browser target belongs to another Thread");
    targets.set(JSON.stringify(browser.route), browser.route);
    return { kind: target.kind, id: browser.tab.id };
  });
  return targets.size
    ? attachBrowserSidebarTargets(args, [...targets.values()])
    : args;
}

export function projectBoardResult(
  result: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
  raw: ToolExecutionResult,
): Record<string, unknown> {
  const output = structuredClone(result);
  // Product/UI bookkeeping is not part of the model-authored document contract.
  delete output.revision;
  delete output.draftRevision;
  delete output.pinned;
  delete output.browserSidebarTargets;
  delete output.navigationDiagnostics;
  const projectOwner = (value: unknown) => {
    const owner = object(value);
    if (owner.threadId !== refs.ownerThreadId)
      return { kind: owner.kind, status: "unavailable" };
    if (owner.kind === "thread") return { kind: "thread" };
    if (owner.kind === "room" && typeof owner.roomId === "string")
      return {
        kind: "room",
        room: refs.bind("rooms", "room", { id: owner.roomId }),
      };
    throw Error("Board returned an invalid owner");
  };
  if (output.owner !== undefined) output.owner = projectOwner(output.owner);
  const document = record(output.document);
  if (!document) return output;
  const nativeOwner = object(document.owner);
  document.owner = projectOwner(document.owner);
  const routes = readBrowserSidebarTargets(raw) ?? [];
  const diagnostics = Array.isArray(result.navigationDiagnostics)
    ? result.navigationDiagnostics
        .map(record)
        .filter((value) => value !== undefined)
    : [];
  const knownIds = new Set<string>([
    refs.ownerThreadId,
    ...Object.values(nativeOwner).filter(
      (value): value is string =>
        typeof value === "string" && value !== "thread" && value !== "room",
    ),
    ...routes
      .flatMap((route) => [
        route.ownerThreadId,
        route.sessionId,
        route.sessionEpoch,
        route.connectionId,
        route.generation,
        route.tabId,
        route.targetId,
      ])
      .filter((value): value is string => typeof value === "string"),
    ...diagnostics
      .map((diagnostic) => diagnostic.id)
      .filter((value): value is string => typeof value === "string"),
  ]);
  const diagnosticReason = (message: string) => {
    for (const id of [...knownIds]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length))
      message = message.replaceAll(id, "[native target]");
    return message;
  };
  mapActions(
    document,
    (value) => {
      const target = object(value);
      if (target.kind === "url") return target;
      const unavailable = (reason: string) => ({
        kind: target.kind,
        status: "unavailable",
        reason,
      });
      const diagnostic = diagnostics.find(
        (entry) =>
          entry.id === target.id &&
          entry.kind === target.kind &&
          (entry.status === "unknown" || entry.status === "unavailable"),
      );
      if (diagnostic)
        return {
          kind: target.kind,
          status: diagnostic.status,
          reason:
            typeof diagnostic.error === "string" && diagnostic.error
              ? diagnosticReason(diagnostic.error)
              : diagnostic.status === "unknown"
                ? "Browser liveness check failed; inspect local diagnostics before using this target."
                : "Browser target is no longer available; inspect again before replacing this action.",
        };
      const matches = routes.filter(
        (route) =>
          route.targetId === target.id &&
          route.ownerThreadId === refs.ownerThreadId &&
          (target.kind === "external-browser") ===
            !!route.backend?.startsWith("connected"),
      );
      if (
        (target.kind !== "browser" && target.kind !== "external-browser") ||
        matches.length !== 1
      )
        return unavailable(
          "Browser target is no longer available; inspect again before replacing this action.",
        );
      try {
        return {
          kind: target.kind,
          tab: refs.bind(
            "browser",
            "tab",
            asJson({ route: matches[0]! }),
            epoch,
          ),
        };
      } catch (error) {
        if (!(error instanceof ModelReferenceBudgetError)) throw error;
        return unavailable(
          "Browser reference publication budget exceeded; inspect the target again.",
        );
      }
    },
    true,
  );
  return output;
}
