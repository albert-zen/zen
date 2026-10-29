import {
  attachBrowserSidebarTargets,
  readBrowserSidebarTargets,
  type BrowserModelRoute,
} from "./model-browser-metadata.js";
import { localErrorDetail } from "../../local-error-detail.js";
import { randomUUID } from "node:crypto";
import type { ToolInvocation } from "../../../../../src/tool.js";
import type { ZenXPluginHostSdkV1 } from "../plugin-host-sdk.js";
import type { ZenXCapabilityPackage } from "./types.js";
import { boardManifest } from "../../../../../packages/zenx-board-plugin/src/manifest.js";
import {
  boardOwnerKey,
  type BoardAction,
  type BoardNavigationTarget,
  type BoardDocument,
  type BoardEventResult,
  type BoardOwner,
  type BoardSnapshot,
  type BoardValue,
  type BoardValues,
} from "../../../../../packages/zenx-board-plugin/src/board.js";

export interface BoardHostPort {
  readOwner(owner: BoardOwner): Promise<BoardOwner>;
  makeClientId?(owner: BoardOwner): string;
  readNavigationTarget?(
    owner: BoardOwner,
    target: BoardNavigationTarget,
  ): Promise<BrowserModelRoute | undefined>;
  navigate?(
    owner: BoardOwner,
    target: BoardNavigationTarget,
    signal: AbortSignal,
  ): Promise<void>;
  deliver(
    owner: BoardOwner,
    text: string,
    clientId: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  execute(
    owner: BoardOwner,
    action: { tool: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<unknown>;
}
/** Current plugin product state only; never stores/replays action execution receipts. */
export class ZenXBoardCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest = boardManifest;
  readonly storage = { version: 1, initialValue: { boards: {} } };
  #sdk?: Pick<ZenXPluginHostSdkV1, "storage">;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #running = new Set<string>();
  constructor(readonly host: BoardHostPort) {}
  createRuntime() {
    return new ZenXBoardCapabilityPackage(this.host);
  }
  start(sdk: Pick<ZenXPluginHostSdkV1, "storage">) {
    this.#sdk = sdk;
  }
  async invoke(name: string, invocation: ToolInvocation): Promise<unknown> {
    invocation.signal.throwIfAborted();
    if (!this.manifest.tools.some((tool) => tool.name === name))
      throw new Error(`Unknown Board tool: ${name}`);
    const ui = invocation.trustedPluginUi === true;
    if (name === "zenx_board_ui" && !ui)
      throw new Error("Board actions require an explicit human UI event");
    const args = record(ui ? invocation.arguments.input : invocation.arguments);
    const document =
      name === "zenx_board_put"
        ? validateDocument(args.document, invocation.threadId)
        : undefined;
    // Room UI reads resolve the persisted execution member; never guess from the foreground selection.
    if (
      ui &&
      args.operation === "read" &&
      typeof args.owner === "object" &&
      args.owner !== null
    ) {
      const candidate = args.owner as Record<string, unknown>;
      if (candidate.kind === "room" && candidate.threadId === undefined) {
        const saved = await this.#serial(
          async () =>
            (await this.#boards())[
              `room:${text(candidate.roomId, "roomId", 512)}`
            ],
        );
        if (!saved) return null;
        args.owner = saved.document.owner;
      }
    }
    const owner =
      document?.owner ??
      validateOwner(
        args.owner ?? { kind: "thread", threadId: invocation.threadId },
      );
    if (!ui && owner.threadId !== invocation.threadId)
      throw new Error("Board owner must be the calling Thread");
    await this.host.readOwner(owner);
    if (document) {
      const targets = navigationTargets(
        document.events.flatMap((event) => event.actions),
      );
      const supplied = readBrowserSidebarTargets(invocation);
      for (const target of targets) {
        if (target.kind === "url") continue;
        const route = await this.host.readNavigationTarget?.(owner, target);
        if (
          !route ||
          (supplied && !supplied.some((entry) => sameRoute(entry, route)))
        )
          throw new Error(
            "Board navigation requires the exact live Browser target owned by this Thread",
          );
      }
    }
    if (name === "zenx_board_ui" && args.operation === "event")
      return await this.#event(owner, args, invocation.signal);
    if (name === "zenx_board_ui" && args.operation === "navigate")
      return await this.#navigate(owner, args, invocation.signal);
    return await this.#serial(async () => {
      const boards = await this.#boards();
      const key = boardOwnerKey(owner);
      const current = boards[key];
      if (current && current.document.owner.threadId !== owner.threadId)
        throw new Error("Board belongs to a different execution member");
      if (document) {
        const next: BoardSnapshot = {
          document,
          revision: (current?.revision ?? 0) + 1,
          draftRevision: current?.draftRevision ?? 0,
          values: {
            ...(document.initialValues ?? {}),
            ...(current?.values ?? {}),
          },
          pinned: current?.pinned ?? false,
        };
        boards[key] = next;
        await this.#save(boards);
        return semantic(next);
      }
      if (name === "zenx_board_read") {
        if (
          args.view !== undefined &&
          args.view !== "semantic" &&
          args.view !== "document"
        )
          throw new Error("Board read view must be semantic or document");
        if (!current) return null;
        if (args.view !== "document") return semantic(current);
        const routes: BrowserModelRoute[] = [];
        const navigationDiagnostics: Array<{
          kind: string;
          id: string;
          status: "unknown" | "unavailable";
          error?: string;
          errorDetail?: string;
        }> = [];
        for (const target of navigationTargets(
          current.document.events.flatMap((event) => event.actions),
        )) {
          if (target.kind === "url") continue;
          try {
            const route = await this.host.readNavigationTarget?.(owner, target);
            if (
              route &&
              routes.length < 64 &&
              !routes.some((entry) => sameRoute(entry, route))
            )
              routes.push(route);
            if (!route)
              navigationDiagnostics.push({
                kind: target.kind,
                id: target.id,
                status: "unavailable",
              });
          } catch (error) {
            // Transient local evidence is retained in ordinary raw Trace; model projection removes routing IDs/details.
            navigationDiagnostics.push({
              kind: target.kind,
              id: target.id,
              status: "unknown",
              error: error instanceof Error ? error.message : String(error),
              errorDetail: localErrorDetail(error),
            });
          }
        }
        return attachBrowserSidebarTargets(
          {
            ...current,
            ...(navigationDiagnostics.length ? { navigationDiagnostics } : {}),
          },
          routes,
        );
      }
      if (args.operation === "read") return current ?? null;
      if (!current) throw new Error("No board exists for this conversation");
      if (args.operation === "draft") {
        if (args.expectedDraftRevision !== current.draftRevision)
          throw new Error(
            "Board draft changed in another view; your unsent fields are preserved locally. Reload before saving.",
          );
        current.values = { ...current.values, ...values(args.values) };
        current.draftRevision++;
      } else if (args.operation === "pin") {
        if (typeof args.pinned !== "boolean")
          throw new Error("pinned must be boolean");
        current.pinned = args.pinned;
      } else throw new Error("Unknown Board UI operation");
      await this.#save(boards);
      return current;
    });
  }
  async #navigate(
    owner: BoardOwner,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<BoardEventResult> {
    const target = validateNavigationTarget(args.target);
    const key = boardOwnerKey(owner);
    if (this.#running.has(key))
      throw new Error("A Board action is already running; it was not repeated");
    this.#running.add(key);
    try {
      const snapshot = await this.#serial(async () => {
        const current = (await this.#boards())[key];
        if (!current || current.document.owner.threadId !== owner.threadId)
          throw new Error("Board owner is unavailable");
        if (current.revision !== args.revision)
          throw new Error(
            "Board changed; review the latest content before navigating",
          );
        return structuredClone(current);
      });
      signal.throwIfAborted();
      await this.host.readOwner(owner);
      if (!this.host.navigate)
        throw new Error("Board resource navigation is unavailable");
      await this.host.navigate(owner, target, signal);
      return {
        snapshot,
        navigation: [target],
        outcomes: [{ kind: "navigate" }],
      };
    } finally {
      this.#running.delete(key);
    }
  }

  async #event(
    owner: BoardOwner,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<BoardEventResult> {
    const key = boardOwnerKey(owner);
    if (this.#running.has(key))
      throw new Error("A Board action is already running; it was not repeated");
    this.#running.add(key);
    try {
      const snapshot = await this.#serial(async () => {
        const current = (await this.#boards())[key];
        if (!current || current.document.owner.threadId !== owner.threadId)
          throw new Error("Board owner is unavailable");
        if (
          current.revision !== args.revision ||
          current.draftRevision !== args.draftRevision
        )
          throw new Error(
            "Board changed; review the latest content before running this action",
          );
        return structuredClone(current);
      });
      const event = snapshot.document.events.find(
        (event) => event.id === args.eventId,
      );
      if (!event) throw new Error("Unknown Board event");
      const result: BoardEventResult = {
        snapshot,
        outcomes: [],
        navigation: [],
      };
      const working = {
        ...snapshot.values,
        ...(args.values === undefined ? {} : values(args.values)),
      };
      const executedSets = new Set<string>();
      const run = async (actions: BoardAction[]): Promise<void> => {
        for (const action of actions) {
          signal.throwIfAborted();
          await this.host.readOwner(owner);
          if (action.kind === "if") {
            await run(
              working[action.field] === action.equals
                ? action.then
                : (action.otherwise ?? []),
            );
            continue;
          }
          if (action.kind === "set") {
            Object.assign(working, action.values);
            for (const key of Object.keys(action.values)) executedSets.add(key);
            result.outcomes.push({ kind: "set" });
            continue;
          }
          if (action.kind === "navigate") {
            if (!action.target)
              throw new Error(
                "This saved Board uses legacy route navigation. Replace it with a typed URL or exact Browser target before running it.",
              );
            const target =
              action.target.kind === "url"
                ? validateNavigationTarget({
                    kind: "url",
                    url: interpolate(action.target.url, working),
                  })
                : action.target;
            if (!this.host.navigate)
              throw new Error("Board resource navigation is unavailable");
            await this.host.navigate(owner, target, signal);
            result.navigation.push(target);
            result.outcomes.push({ kind: "navigate" });
            continue;
          }
          if (action.kind === "submit") {
            const text = interpolate(action.text, working);
            if (!text.trim()) throw new Error("Composed message is empty");
            const admission = await this.host.deliver(
              owner,
              text,
              this.host.makeClientId?.(owner) ?? randomUUID(),
              signal,
            );
            result.outcomes.push({ kind: "submit", result: admission });
            if (owner.kind === "room") {
              // The Room receipt is retained above even when native admission
              // failed or is unknown. A saved product message is not admission.
              const fields = (value: unknown): Record<string, unknown> =>
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value)
                  ? (value as Record<string, unknown>)
                  : {};
              const receipt = fields(admission);
              const delivery = fields(receipt.delivery);
              const recipients = Array.isArray(delivery.mentions)
                ? delivery.mentions
                : [];
              const recipient =
                recipients.length === 1 ? fields(recipients[0]) : {};
              const deliveries = Array.isArray(recipient.deliveries)
                ? recipient.deliveries
                : [];
              const native =
                deliveries.length === 1 ? fields(deliveries[0]) : {};
              if (
                receipt.kind !== "room" ||
                receipt.roomId !== owner.roomId ||
                receipt.threadId !== owner.threadId ||
                delivery.roomId !== owner.roomId ||
                delivery.state !== "saved" ||
                typeof delivery.messageId !== "string" ||
                !delivery.messageId ||
                recipient.threadId !== owner.threadId ||
                typeof native.historyId !== "string" ||
                !native.historyId ||
                typeof native.triggerId !== "string" ||
                !native.triggerId ||
                (native.status !== "running" && native.status !== "completed")
              ) {
                const status =
                  typeof native.status === "string" &&
                  [
                    "failed",
                    "unknown",
                    "pending",
                    "queued",
                    "unconfigured",
                  ].includes(native.status)
                    ? native.status
                    : "unconfirmed";
                throw new Error(
                  `Room model admission is ${status}; later actions were stopped. Inspect the retained delivery receipt; do not retry automatically.`,
                );
              }
            }
            continue;
          }
          const command = action.command.replaceAll(
            "{{valuesBase64}}",
            Buffer.from(JSON.stringify(working)).toString("base64"),
          );
          const execution = await this.host.execute(
            owner,
            {
              tool: "shell",
              arguments: {
                command,
                ...(action.timeoutMs === undefined
                  ? {}
                  : { timeout_ms: action.timeoutMs }),
              },
            },
            signal,
          );
          result.outcomes.push({ kind: "script", result: execution });
          const response = record(execution);
          // Conditions may inspect actual terminal exit status, never infer it from admission.
          working["result.exitCode"] =
            typeof response.exitCode === "number" ? response.exitCode : null;
          working["result.output"] =
            typeof response.output === "string"
              ? response.output.slice(0, 8192)
              : "";
          if (response.contentType === "application/vnd.zen.tool-task+json") {
            const task =
              typeof response.structuredContent === "object" &&
              response.structuredContent !== null
                ? (response.structuredContent as Record<string, unknown>)
                : {};
            if (task.status === "cancelled" || task.status === "timed_out")
              throw new Error(
                `Execution ${task.status === "cancelled" ? "was cancelled" : "timed out"}; later actions were stopped. Do not retry automatically.`,
              );
          }
          if (
            response.contentType === "application/vnd.zen.tool-task+json" ||
            typeof response.exitCode !== "number"
          )
            throw new Error(
              "Execution has no confirmed terminal result; inspect its receipt before any further action",
            );
        }
      };
      try {
        await run(event.actions);
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        result.errorDetail = localErrorDetail(error);
      }
      // Local set actions update only this unchanged draft; action outputs are transient, not product history.
      const changed = Object.fromEntries(
        Object.entries(working).filter(
          ([key, value]) =>
            executedSets.has(key) &&
            !key.startsWith("result.") &&
            snapshot.values[key] !== value,
        ),
      );
      if (Object.keys(changed).length) {
        try {
          result.snapshot = await this.#serial(async () => {
            const boards = await this.#boards();
            const current = boards[key];
            if (!current || current.draftRevision !== snapshot.draftRevision)
              throw new Error(
                "A newer user draft was preserved; local action changes were not saved",
              );
            current.values = { ...current.values, ...changed };
            current.draftRevision++;
            await this.#save(boards);
            return current;
          });
        } catch (error) {
          result.errorDetail = [result.errorDetail, localErrorDetail(error)]
            .filter(Boolean)
            .join("\n\n");
          result.error = [
            result.error,
            error instanceof Error ? error.message : String(error),
          ]
            .filter(Boolean)
            .join("; ");
        }
      }
      return result;
    } finally {
      this.#running.delete(key);
    }
  }
  #serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(action);
    this.#tail = next.catch(() => {});
    return next;
  }
  async #boards(): Promise<Record<string, BoardSnapshot>> {
    if (!this.#sdk) throw new Error("Board plugin storage is unavailable");
    const stored = await this.#sdk.storage.get();
    return structuredClone(record(stored.boards ?? {})) as Record<
      string,
      BoardSnapshot
    >;
  }
  async #save(boards: Record<string, BoardSnapshot>) {
    if (!this.#sdk) throw new Error("Board plugin storage is unavailable");
    await this.#sdk.storage.set({ boards });
  }
}
function semantic(state: BoardSnapshot) {
  const fields = state.document.blocks.filter(
    (block) => block.kind === "field",
  );
  const entries = Object.entries(state.values);
  return {
    id: state.document.id,
    title: state.document.title,
    summary: state.document.summary,
    revision: state.revision,
    draftRevision: state.draftRevision,
    valuesMeaning: "Unsent user drafts, not approval or a submitted message",
    fields: fields.slice(0, 16).map((block) => ({
      id: block.id,
      label: block.label.slice(0, 80),
      field: block.field,
    })),
    actions: state.document.events
      .slice(0, 16)
      .map((event) => ({ id: event.id, label: event.label.slice(0, 80) })),
    values: Object.fromEntries(
      entries
        .slice(0, 32)
        .map(([key, value]) => [
          key,
          typeof value === "string" ? value.slice(0, 256) : value,
        ]),
    ),
    truncated:
      fields.length > 16 ||
      state.document.events.length > 16 ||
      entries.length > 32 ||
      entries.some(
        ([, value]) => typeof value === "string" && value.length > 256,
      ),
  };
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 8192): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(
      `${label} must be non-empty text (${max} characters maximum)`,
    );
  return value;
}
function id(value: unknown): string {
  const result = text(value, "ID", 64);
  if (
    !/^[a-zA-Z][a-zA-Z0-9_.-]*$/u.test(result) ||
    ["__proto__", "constructor", "prototype"].includes(result)
  )
    throw new Error("Invalid short Board ID");
  return result;
}
function scalar(value: unknown): BoardValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 8192)
  )
    return value;
  throw new Error("Board values must be bounded scalar JSON");
}
function values(value: unknown): BoardValues {
  const entries = Object.entries(record(value));
  if (entries.length > 128) throw new Error("Too many Board fields");
  return Object.fromEntries(
    entries.map(([key, value]) => [id(key), scalar(value)]),
  );
}
export function validateOwner(value: unknown): BoardOwner {
  const owner = record(value);
  const threadId = text(owner.threadId, "threadId", 512);
  if (owner.kind === "thread") return { kind: "thread", threadId };
  if (owner.kind === "room")
    return {
      kind: "room",
      roomId: text(owner.roomId, "roomId", 512),
      threadId,
    };
  throw new Error("Invalid Board owner");
}
function interpolate(template: string, values: BoardValues): string {
  return template.replace(
    /\{\{([a-zA-Z][a-zA-Z0-9_.-]*)\}\}/gu,
    (_, key: string) => {
      if (!(key in values)) throw new Error(`Missing Board field: ${key}`);
      return String(values[key] ?? "");
    },
  );
}
export function validateDocument(
  value: unknown,
  threadId?: string,
): BoardDocument {
  if (value === undefined || JSON.stringify(value).length > 256 * 1024)
    throw new Error("Board document exceeds 256 KiB");
  const doc = record(value);
  const owner = validateOwner(doc.owner ?? { kind: "thread", threadId });
  if (
    !Array.isArray(doc.blocks) ||
    doc.blocks.length > 64 ||
    !Array.isArray(doc.events) ||
    doc.events.length > 32
  )
    throw new Error("Board needs bounded blocks and events");
  let count = 0;
  const actions = (value: unknown, depth = 0): BoardAction[] => {
    if (!Array.isArray(value) || depth > 6)
      throw new Error("Invalid Board actions");
    return value.map((raw): BoardAction => {
      if (++count > 128) throw new Error("Too many Board actions");
      const action = record(raw);
      switch (action.kind) {
        case "set":
          return { kind: "set", values: values(action.values) };
        case "navigate":
          return {
            kind: "navigate",
            target: validateNavigationTarget(action.target),
          };
        case "submit":
          return { kind: "submit", text: text(action.text, "message", 100000) };
        case "script": {
          const command = text(action.command, "command", 100000);
          if (/\{\{(?!valuesBase64\}\})/u.test(command))
            throw new Error(
              "Scripts interpolate only {{valuesBase64}}; decode JSON in the script rather than concatenating user text into shell code",
            );
          if (
            action.timeoutMs !== undefined &&
            (!Number.isSafeInteger(action.timeoutMs) ||
              Number(action.timeoutMs) < 1 ||
              Number(action.timeoutMs) > 86400000)
          )
            throw new Error("Invalid script timeout");
          return {
            kind: "script",
            command,
            ...(action.timeoutMs === undefined
              ? {}
              : { timeoutMs: Number(action.timeoutMs) }),
          };
        }
        case "if":
          return {
            kind: "if",
            field: id(action.field),
            equals: scalar(action.equals),
            then: actions(action.then, depth + 1),
            ...(action.otherwise === undefined
              ? {}
              : { otherwise: actions(action.otherwise, depth + 1) }),
          };
        default:
          throw new Error("Unknown Board action");
      }
    });
  };
  const eventIds = new Set<string>();
  const events = doc.events.map((raw) => {
    const event = record(raw);
    const key = id(event.id);
    if (eventIds.has(key)) throw new Error("Duplicate Board event ID");
    eventIds.add(key);
    return {
      id: key,
      label: text(event.label, "event label", 256),
      actions: actions(event.actions),
    };
  });
  const blockIds = new Set<string>();
  const blocks: BoardDocument["blocks"] = doc.blocks.map((raw) => {
    const block = record(raw);
    const key = id(block.id);
    if (blockIds.has(key)) throw new Error("Duplicate Board block ID");
    blockIds.add(key);
    switch (block.kind) {
      case "note":
        return {
          id: key,
          kind: "note",
          text: text(block.text, "note"),
          ...(block.title === undefined
            ? {}
            : { title: text(block.title, "title", 256) }),
        };
      case "metric":
        return {
          id: key,
          kind: "metric",
          title: text(block.title, "title", 256),
          value: text(block.value, "value", 256),
          ...(block.detail === undefined
            ? {}
            : { detail: text(block.detail, "detail") }),
        };
      case "progress": {
        if (
          typeof block.value !== "number" ||
          !Number.isFinite(block.value) ||
          block.value < 0 ||
          (block.max !== undefined &&
            (typeof block.max !== "number" ||
              !Number.isFinite(block.max) ||
              block.max <= 0))
        )
          throw new Error("Invalid progress");
        return {
          id: key,
          kind: "progress",
          title: text(block.title, "title", 256),
          value: block.value,
          ...(block.max === undefined ? {} : { max: Number(block.max) }),
        };
      }
      case "field": {
        if (
          block.input !== undefined &&
          !["text", "textarea", "select", "checkbox"].includes(
            String(block.input),
          )
        )
          throw new Error("Invalid field input");
        if (
          block.options !== undefined &&
          (!Array.isArray(block.options) || block.options.length > 100)
        )
          throw new Error("Invalid field options");
        return {
          id: key,
          kind: "field",
          label: text(block.label, "label", 256),
          field: id(block.field),
          ...(block.input === undefined
            ? {}
            : { input: block.input as "text" }),
          ...(block.options === undefined
            ? {}
            : {
                options: (block.options as unknown[]).map((option) =>
                  text(option, "option", 256),
                ),
              }),
          ...(block.placeholder === undefined
            ? {}
            : { placeholder: text(block.placeholder, "placeholder", 256) }),
        };
      }
      case "action": {
        const event = id(block.event);
        if (!eventIds.has(event)) throw new Error("Dangling Board event");
        return {
          id: key,
          kind: "action",
          label: text(block.label, "label", 256),
          event,
          ...(block.emphasis === true ? { emphasis: true } : {}),
        };
      }
      default:
        throw new Error("Unknown Board block");
    }
  });
  return {
    id: id(doc.id),
    title: text(doc.title, "title", 256),
    summary: text(doc.summary, "summary", 1024),
    owner,
    blocks,
    events,
    ...(doc.initialValues === undefined
      ? {}
      : { initialValues: values(doc.initialValues) }),
    ...(doc.html === undefined ? {} : { html: text(doc.html, "html", 200000) }),
  };
}

function navigationTargets(actions: BoardAction[]): BoardNavigationTarget[] {
  return actions.flatMap((action) =>
    action.kind === "navigate"
      ? action.target
        ? [action.target]
        : []
      : action.kind === "if"
        ? [
            ...navigationTargets(action.then),
            ...navigationTargets(action.otherwise ?? []),
          ]
        : [],
  );
}
export function validateNavigationTarget(
  value: unknown,
): BoardNavigationTarget {
  const target = record(value);
  if (
    target.kind === "url" &&
    Object.keys(target).every((key) => ["kind", "url"].includes(key))
  ) {
    const url = text(target.url, "URL", 8192);
    const parsed = new URL(url);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error(
        "Board URLs must be HTTP(S) without embedded credentials",
      );
    return { kind: "url", url };
  }
  if (
    (target.kind === "browser" || target.kind === "external-browser") &&
    Object.keys(target).every((key) => ["kind", "id"].includes(key))
  )
    return { kind: target.kind, id: text(target.id, "Browser target", 4096) };
  throw new Error(
    "Board navigation requires a typed URL or exact existing Browser target",
  );
}

function sameRoute(left: BrowserModelRoute, right: BrowserModelRoute): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(
    (key) =>
      left[key as keyof BrowserModelRoute] ===
      right[key as keyof BrowserModelRoute],
  );
}
