import type { ModelTool } from "../../../../../src/model.js";
import type {
  ToolInvocation,
  ToolExecutionResult,
} from "../../../../../src/tool.js";
import {
  ModelReferenceRegistry,
  ModelReferenceBudgetError,
  CAPABILITY_REFERENCE_BUDGET,
  attachModelReferenceBindings,
  type ModelReferenceScope,
} from "../../../../../src/model-references.js";
import type { ModelFacadeInvocation } from "./model-tool-facade.js";
import {
  MODEL_REF,
  object,
  record,
  only,
  pick,
  asJson,
} from "./model-facade-fields.js";
import {
  attachBrowserModelRoute,
  copyBrowserModelContext,
  readBrowserModelRoute,
  readBrowserModelTargets,
  isBrowserModelRoute,
  type BrowserModelRoute,
} from "./model-browser-metadata.js";
import { browserConnectionScopeKey } from "./browser-connections.js";
import {
  browserOperations,
  browserOperation as operation,
  browserNamespace as namespace,
  buildBrowserModelDefinition,
  sessionTools,
  targetTools,
  observationTools,
} from "../../../../../packages/zenx-browser-plugin/src/model-contract.js";
import { projectTargetChanges } from "../../../../../packages/zenx-browser-plugin/src/model-observation.js";
export { browserModelDocument } from "../../../../../packages/zenx-browser-plugin/src/model-contract.js";
export type BrowserModelConnections = ReadonlyMap<
  string,
  { connectionId: string; label: string; state: string; generation: string }
>;
const names = new Set([
  "browser_connections",
  ...["browser_", "browser_workspace_", "browser_connected_"].flatMap((p) =>
    browserOperations.map((o) => p + o),
  ),
]);
export const isBrowserModelTool = (name: string) => names.has(name);
export function browserModelDefinition<T extends ModelTool>(source: T): T {
  return buildBrowserModelDefinition(source, MODEL_REF);
}
function routeFrom(value: Record<string, unknown>): BrowserModelRoute {
  if (!isBrowserModelRoute(value.route))
    throw Error("Browser reference lacks native target provenance; refresh");
  return value.route;
}
function matchesNamespace(name: string, route: BrowserModelRoute): void {
  const ns = namespace(name);
  if (
    (ns === "legacy" && route.backend !== undefined) ||
    (ns !== "legacy" &&
      route.backend !== ns &&
      !route.backend?.startsWith(`${ns}/`))
  )
    throw Error("Browser ref belongs to another backend");
}
function connection(
  id: unknown,
  generation: unknown,
  connections?: BrowserModelConnections,
) {
  const value = typeof id === "string" ? connections?.get(id) : undefined;
  if (!value || value.state !== "connected" || value.generation !== generation)
    throw Error(
      "Browser connection retired or unavailable; refresh the catalog and discover again",
    );
  return value;
}
/** Shared by approval, resource claims and dispatch: no implicit newest target. */
export function decodeBrowserArguments(
  name: string,
  input: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
  connections?: BrowserModelConnections,
): Record<string, unknown> {
  const op = operation(name),
    args: Record<string, unknown> = {},
    allowed = [
      "session",
      "connection",
      "tab",
      "target",
      "observation",
      "cursor",
      "url",
      "text",
      "submit",
      "option",
      "direction",
      "pixels",
      "x",
      "y",
      "key",
      "observe",
      "since",
      "full",
      "query",
    ];
  only(input, op === "connections" ? [] : allowed);
  if (op === "connections") return args;
  let route: BrowserModelRoute | undefined;
  const resolve = (ref: unknown, kind: string) =>
    object(refs.resolve(ref, "browser", kind, epoch));
  if (sessionTools.has(op)) {
    only(input, [
      "session",
      "connection",
      ...(op === "open" ? ["url", "observe", "since", "full"] : []),
    ]);
    if (typeof input.session === "string" && refs.lookup(input.session))
      route = routeFrom(resolve(input.session, "session"));
    else {
      if (op === "close_session")
        throw Error("Close requires an exact session ref");
      if (
        input.session !== undefined &&
        (typeof input.session !== "string" || /^r[0-9]+$/u.test(input.session))
      )
        throw Error("Use a semantic session name or exact returned ref");
      args.sessionId = input.session ?? "main";
    }
  } else {
    const field =
      input.cursor !== undefined
        ? "cursor"
        : targetTools.has(op)
          ? "target"
          : observationTools.has(op)
            ? "observation"
            : "tab";
    if (field === "cursor" && op !== "inspect")
      throw Error("Cursor is only supported by inspect");
    for (const other of [
      "session",
      "connection",
      "tab",
      "target",
      "cursor",
      "observation",
    ])
      if (
        other !== field &&
        input[other] !== undefined &&
        !(["navigate", "close"].includes(op) && other === "observation") &&
        !(targetTools.has(op) && other === "observation")
      )
        throw Error(
          "The exact Browser ref already binds its target; omit other routing fields",
        );
    const bound = resolve(input[field], field);
    route = routeFrom(bound);
    if (field === "target" || field === "observation")
      args.observationId = bound.observationId;
    if (field === "target") args.targetId = bound.targetId;
    if (field === "cursor") args.cursor = bound.cursor;
    if (
      (["navigate", "close"].includes(op) || targetTools.has(op)) &&
      input.observation !== undefined
    ) {
      const observed = resolve(input.observation, "observation");
      if (JSON.stringify(routeFrom(observed)) !== JSON.stringify(route))
        throw Error("Observation belongs to another exact tab");
      args.observationId = observed.observationId;
    }
  }
  if (route) {
    matchesNamespace(name, route);
    args.sessionId = route.sessionId;
    if (route.tabId !== undefined) args.tabId = route.tabId;
    if (route.connectionId !== undefined) {
      connection(route.connectionId, route.generation, connections);
      args.connectionId = route.connectionId;
    }
    attachBrowserModelRoute(args, route);
  }
  if (input.connection !== undefined) {
    const bound = resolve(input.connection, "connection");
    const selected = connection(
      bound.connectionId,
      bound.generation,
      connections,
    );
    if (
      namespace(name) !== "connected" ||
      (route &&
        (route.connectionId !== selected.connectionId ||
          route.generation !== selected.generation))
    )
      throw Error("Browser connection mismatches the exact session");
    args.connectionId = selected.connectionId;
  }
  if (
    namespace(name) === "connected" &&
    connections &&
    args.connectionId === undefined
  )
    throw Error("Choose an exact connection ref from browser_connections");
  for (const key of [
    "url",
    "text",
    "submit",
    "option",
    "direction",
    "pixels",
    "x",
    "y",
    "key",
    "observe",
    "query",
  ])
    if (input[key] !== undefined) args[key] = structuredClone(input[key]);
  if (input.since !== undefined) {
    if (args.cursor !== undefined || input.full === true)
      throw Error("since cannot be combined with cursor or full:true");
    const base = resolve(input.since, "observation");
    const baseRoute = routeFrom(base);
    if (route && JSON.stringify(baseRoute) !== JSON.stringify(route))
      throw Error("Baseline belongs to another exact tab");
    if (!route && op === "open")
      throw Error("Open cannot compare an observation from an unknown new tab");
    args.baseObservationId = base.observationId;
  }
  if (input.full !== undefined) args.full = input.full;
  else if (
    op === "inspect" &&
    args.cursor === undefined &&
    input.since === undefined
  )
    args.full = true;
  return args;
}
export function browserApprovalScope(
  args: Record<string, unknown>,
  connections: BrowserModelConnections,
) {
  if (typeof args.connectionId !== "string")
    throw Error("An explicit browser connectionId is required");
  const id = args.connectionId,
    selected = typeof id === "string" ? connections.get(id) : undefined;
  if (!selected || selected.state !== "connected")
    throw Error(
      "Browser connection is unavailable in this tool catalog; refresh",
    );
  return {
    key: browserConnectionScopeKey(selected.connectionId),
    label: selected.label,
    generation: selected.generation,
  };
}
class ProjectionUnavailable extends Error {}
function projectBrowserResult(
  name: string,
  value: unknown,
  args: Record<string, unknown>,
  raw: ToolExecutionResult,
  refs: ModelReferenceScope,
  epoch: string,
  connections?: BrowserModelConnections,
  history: readonly {
    namespace: string;
    kind: string;
    value: unknown;
    ref: string;
    ownerThreadId: string;
    epoch?: string;
  }[] = [],
): Record<string, unknown> {
  const op = operation(name),
    bind = (kind: string, value: unknown) =>
      refs.bind("browser", kind, asJson(value), epoch);
  if (op === "connections") {
    if (!Array.isArray(value)) throw new ProjectionUnavailable();
    return {
      connections: value.map((entry) => {
        const v = object(entry),
          selected =
            typeof v.connectionId === "string"
              ? connections?.get(v.connectionId)
              : undefined;
        return {
          ...pick(v, ["browser", "label", "state"]),
          ...(selected?.state === "connected" && v.state === "connected"
            ? {
                ref: bind("connection", {
                  connectionId: selected.connectionId,
                  generation: selected.generation,
                }),
              }
            : {}),
        };
      }),
    };
  }
  const metadata = readBrowserModelTargets(raw),
    consumed = readBrowserModelRoute(args),
    base = metadata?.route ?? consumed;
  if (!base) throw new ProjectionUnavailable();
  const sessionRoute = { ...base };
  delete sessionRoute.tabId;
  delete sessionRoute.targetId;
  const session = bind("session", { route: sessionRoute });
  const project = (input: unknown) => {
    const v = object(input),
      out = pick(v, [
        "title",
        "url",
        "loading",
        "control",
        "agentActionsInFlight",
        "agentActionOutcomeUnknown",
        "requiresFreshObservation",
        "mutationsRequireObservation",
        "automaticPresentation",
        "visibleText",
        "visibleTextChange",
        "coverage",
        "search",
        "view",
        "inputViewport",
        "focusedInputAvailable",
        "inputPolicy",
        "actionCompleted",
        "observationError",
        "nextAction",
        "closed",
        "closedTabs",
        "status",
        "error",
        "applicationEffect",
        "dispatch",
      ]);
    let route = consumed;
    if (typeof v.tabId === "string") {
      const target = metadata?.targets.find((t) => t.tabId === v.tabId);
      if (target) route = { ...sessionRoute, ...target };
      if (!route || route.tabId !== v.tabId || v.sessionId !== route.sessionId)
        throw new ProjectionUnavailable();
      out.tab = bind("tab", { route });
    }
    out.session = session;
    if (record(v.grouping))
      out.grouping = pick(object(v.grouping), ["status", "reason"]);
    if (record(v.observation))
      out.page = pick(object(v.observation), [
        "format",
        "identityKind",
        "capturedAt",
        "continuation",
        "resetReason",
        "unchanged",
      ]);
    if (typeof v.observationId === "string") {
      if (!route?.tabId) throw new ProjectionUnavailable();
      out.observation = bind("observation", {
        route,
        observationId: v.observationId,
      });
      const page = record(out.page);
      const nativePage = record(v.observation);
      if (page && typeof nativePage?.baseObservationId === "string")
        page.base = bind("observation", {
          route,
          observationId: nativePage.baseObservationId,
        });
      if (record(v.screenshot)) {
        const screenshot = object(v.screenshot);
        out.screenshot = {
          ...pick(screenshot, [
            "artifactPath",
            "status",
            "reason",
            "width",
            "height",
            "bytes",
            "expiresAt",
          ]),
          observation: bind("observation", {
            route,
            observationId: screenshot.observationId,
          }),
        };
      }
      if (Array.isArray(v.targets))
        out.targets = v.targets.map((item) => {
          const target = object(item);
          return {
            ref: bind("target", {
              route,
              observationId: v.observationId,
              targetId: target.targetId,
            }),
            ...pick(target, [
              "role",
              "name",
              "actions",
              "value",
              "checked",
              "selected",
              "options",
              "optionsTruncated",
            ]),
          };
        });
      if (record(v.targetChanges)) {
        const changes = object(v.targetChanges);
        const bindTarget = (targetId: string, observationId: string) =>
          bind("target", { route, observationId, targetId });
        const projectTarget = (
          target: Record<string, unknown>,
          observationId: string,
        ) => {
          return {
            ref: bindTarget(target.targetId as string, observationId),
            ...pick(target, [
              "role",
              "name",
              "actions",
              "value",
              "checked",
              "selected",
              "options",
              "optionsTruncated",
            ]),
          };
        };
        const baseId = nativePage?.baseObservationId;
        if (typeof baseId !== "string") throw new ProjectionUnavailable();
        const oldIds: string[] = [];
        for (const binding of history) {
          if (
            binding.namespace !== "browser" ||
            binding.kind !== "target" ||
            binding.ownerThreadId !== refs.ownerThreadId ||
            binding.epoch !== epoch
          )
            continue;
          const old = record(binding.value);
          if (
            old?.observationId !== baseId ||
            typeof old.targetId !== "string" ||
            !record(old.route) ||
            JSON.stringify(old.route) !== JSON.stringify(route)
          )
            continue;
          // Candidate provenance is still checked by the typed ref resolver.
          refs.resolve(binding.ref, "browser", "target", epoch);
          if (!oldIds.includes(old.targetId)) oldIds.push(old.targetId);
        }
        const itemCoverage = record(record(v.coverage)?.items);
        const returned =
          typeof itemCoverage?.returned === "number"
            ? itemCoverage.returned
            : oldIds.length;
        out.targetChanges = projectTargetChanges(
          changes,
          oldIds,
          returned,
          baseId,
          v.observationId,
          bindTarget,
          projectTarget,
        );
      }
    }
    if (typeof v.nextCursor === "string") {
      if (!route?.tabId) throw new ProjectionUnavailable();
      out.nextCursor = bind("cursor", { route, cursor: v.nextCursor });
    }
    return out;
  };
  return Array.isArray(value)
    ? { session, tabs: value.map(project) }
    : project(value);
}
export function browserSidebarDescriptor(
  ref: unknown,
  kind: unknown,
  refs: ModelReferenceScope,
  epoch: string,
) {
  const route = routeFrom(object(refs.resolve(ref, "browser", "tab", epoch)));
  if (
    !route.targetId ||
    (kind === "external-browser") !== !!route.backend?.startsWith("connected")
  )
    throw Error("Browser sidebar kind does not match its exact native target");
  return {
    route,
    tab: { kind, id: route.targetId, resourceThreadId: route.ownerThreadId },
  };
}
export async function invokeBrowserModelToolFacade(options: {
  invocation: ModelFacadeInvocation;
  epoch: string;
  references: ModelReferenceRegistry;
  connections?: BrowserModelConnections;
  dispatch(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}): Promise<ToolExecutionResult> {
  const { invocation, epoch, references, connections, dispatch } = options;
  const refs = references.scope(
    invocation.threadId!,
    invocation.modelReferences,
    CAPABILITY_REFERENCE_BUDGET,
  );
  const args = decodeBrowserArguments(
      invocation.name,
      invocation.arguments,
      refs,
      epoch,
      connections,
    ),
    used = refs.newBindings;
  if (namespace(invocation.name) === "connected" && connections) {
    const expected = browserApprovalScope(args, connections);
    if (
      invocation.approvalScope?.key !== expected.key ||
      invocation.approvalScope.generation !== expected.generation
    )
      throw Error("Browser approval scope changed; prepare and inspect again");
  }
  await invocation.traceOutput?.recordInvocation?.({
    captureLayer: "model-reference-resolved-dispatch",
    tool: invocation.name,
    modelArguments: invocation.arguments,
    backendArguments: args,
  });
  await invocation.traceOutput?.recordReferenceBindings?.(used);
  invocation.signal.throwIfAborted();
  const raw = await dispatch(
    copyBrowserModelContext(args, { ...invocation, arguments: args }),
  );
  const capture = record(
    await invocation.traceOutput?.recordResult(
      raw,
      "capability-result-before-model-projection",
    ),
  );
  // The successful compact projection is the preview; raw IDs stay in the file.
  const {
    preview: _preview,
    previewTruncated: _previewTruncated,
    ...resultFile
  } = record(capture?.resultFile) ?? {};
  const retained = refs.newBindings;
  const receipt = (output: string, bindings = refs.newBindings) =>
    attachModelReferenceBindings(
      {
        output,
        exitCode: raw.exitCode,
        ...(raw.sourceTruncated === undefined
          ? {}
          : { sourceTruncated: raw.sourceTruncated }),
      },
      bindings,
    );
  let value: unknown;
  try {
    value = JSON.parse(raw.output);
  } catch {
    return receipt(raw.output);
  }
  try {
    return receipt(
      JSON.stringify({
        ...projectBrowserResult(
          invocation.name,
          value,
          args,
          raw,
          refs,
          epoch,
          connections,
          invocation.modelReferences,
        ),
        ...(capture?.resultFile ? { raw_result_file: resultFile } : {}),
      }),
    );
  } catch (error) {
    if (
      !(error instanceof ModelReferenceBudgetError) &&
      !(error instanceof ProjectionUnavailable)
    )
      throw error;
    const facts = pick(record(value) ?? {}, [
      "status",
      "dispatch",
      "applicationEffect",
      "actionCompleted",
      "observationError",
      "closed",
      "closedTabs",
      "error",
    ]);
    return receipt(
      JSON.stringify({
        projection: "projection_unavailable",
        toolReturn: { exitCode: raw.exitCode },
        outcome: {
          classification: Object.keys(facts).length ? "known" : "unclassified",
          ...facts,
        },
        ...(capture?.resultFile ? { raw_result_file: capture.resultFile } : {}),
        safeNextStep:
          (capture?.resultFile
            ? "Read raw_result_file with shell/file tools, or current state. "
            : "Raw result file unavailable; read current state. ") +
          "Never repeat a mutation merely because projection is unavailable.",
      }),
      retained,
    );
  }
}
