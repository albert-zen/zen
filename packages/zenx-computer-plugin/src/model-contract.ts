/** Computer model presentation. This package owns no Core or native authority. */
export interface ComputerReferencePort {
  bind(kind: string, value: unknown): string;
  resolve(ref: unknown, kind: string): unknown;
}

export interface ComputerModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const REF = {
  type: "string",
  pattern: "^r[1-9][0-9]*$",
  description: "Exact owner-scoped reference; refresh a retired reference.",
};
const names = new Set([
  "computer_environment",
  "computer_list_windows",
  "computer_select_target",
  "computer_inspect",
  "computer_press",
  "computer_set_value",
  "computer_screenshot",
  "computer_ocr",
  "computer_background_click",
  "computer_foreground_click",
  "computer_foreground_key_press",
  "computer_foreground_type",
  "computer_foreground_shortcut",
  "computer_foreground_scroll",
]);
const targetTools = new Set([
  "computer_inspect",
  "computer_select_target",
  "computer_screenshot",
]);
const semanticActions = new Set(["computer_press", "computer_set_value"]);

export const computerModelDocument =
  "Read computer_environment for current session availability; native macOS AX may work while locked using fresh controls, but actual native failures remain failures. Locked actions include a fresh native readback; only explicitly disclosed native exact-window capture/input may work while locked; foreground input requires an active session. Session changes never unlock or auto-replay input. List windows where supported and use exact window refs for inspect, screenshot or target selection. Inspect is a bounded capture: query/limit narrow only captured controls and coverage names the scope. Strict Windows native UIA inspect omits the current text Value, including passwords; do not infer text from a control name. Keep a full first-page baseline before requesting since; omit since or use full:true after compaction or lost context. Follow cursor alone for immutable continuation. A diff supplies explicit old-to-new control replacements and current order; retained controls may instead use their old ref with the explicit latest observation ref, subject to native freshness checks. Semantic actions default to a small self-contained follow-up; use since for an exact diff or full:true for a full first page. Native macOS and strict Windows set_value may report valueReadback.matchesRequested after exact native AXValue or ValuePattern readback without echoing the text; this verifies the immediate control value, not save or submit. Confirm broader application effects through a fresh app-visible state. actionCompleted with observationError means inspect again without repeating the action. Foreground tools may take focus and require the selected exact binding/capture; dispatch never proves application effect. Native macOS background_click consumes one exact screenshot capture ref and left-clicks its image-pixel x/y without desktop takeover; it requires fresh full-window SCK capture, a known console session and separate window-input permission. Application-internal focus may change. Use a fresh screenshot after every click; never retry an uncertain action.";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function object(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (!result) throw Error("Expected a Computer reference object");
  return result;
}
function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}
function sameTarget(a: unknown, b: unknown): boolean {
  const first = windowTarget(a),
    second = windowTarget(b);
  return (
    JSON.stringify(
      pick(first, ["pid", "applicationId", "bundleId", "windowTitle"]),
    ) ===
    JSON.stringify(
      pick(second, ["pid", "applicationId", "bundleId", "windowTitle"]),
    )
  );
}
function windowTarget(value: unknown): Record<string, unknown> {
  const target = object(value);
  if (
    (typeof target.pid !== "number" ||
      !Number.isSafeInteger(target.pid) ||
      target.pid <= 0) &&
    typeof target.applicationId !== "string" &&
    typeof target.bundleId !== "string"
  )
    throw Error(
      "Computer window reference lacks an exact native target; list windows again",
    );
  if (typeof target.windowTitle !== "string" || !target.windowTitle)
    throw Error(
      "Computer window reference lacks an exact window title; list windows again",
    );
  return pick(target, [
    "pid",
    "applicationId",
    "bundleId",
    "windowTitle",
    "applicationName",
  ]);
}
function rename(
  schema: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const properties = record(schema.properties);
  if (!properties || !(from in properties)) return;
  delete properties[from];
  properties[to] = structuredClone(REF);
  if (Array.isArray(schema.required))
    schema.required = schema.required.map((field) =>
      field === from ? to : field,
    );
}

export function isComputerModelTool(name: string): boolean {
  return names.has(name);
}

export function computerModelDefinition<T extends ComputerModelTool>(
  source: T,
): T {
  const tool = structuredClone(source),
    schema = tool.inputSchema;
  if (targetTools.has(tool.name)) {
    const props = object(schema.properties);
    const nativeTarget = props.target;
    props.target =
      nativeTarget === undefined
        ? structuredClone(REF)
        : {
            anyOf: [structuredClone(REF), nativeTarget],
            description:
              "Use the exact window ref from list_windows when available; otherwise supply an explicit native window target.",
          };
    if (tool.name === "computer_inspect") {
      delete props.baseObservationId;
      props.since = structuredClone(REF);
      props.cursor = structuredClone(REF);
      schema.required = [];
      schema.oneOf = [{ required: ["target"] }, { required: ["cursor"] }];
    }
  }
  rename(schema, "bindingId", "binding");
  rename(schema, "captureId", "capture");
  if (semanticActions.has(tool.name)) {
    const props = object(schema.properties);
    delete props.target;
    delete props.baseObservationId;
    props.control = structuredClone(REF);
    props.observation = structuredClone(REF);
    props.observe = {
      type: "boolean",
      description:
        "Return a fresh focused observation after the action; defaults to true.",
    };
    props.since = structuredClone(REF);
    props.full = {
      type: "boolean",
      description:
        "Return a self-contained full first page after the action. Omit for a small focused view.",
    };
    schema.required =
      tool.name === "computer_press" ? ["control"] : ["control", "value"];
  }
  if (tool.name === "computer_background_click") {
    delete object(schema.properties).target;
    delete object(schema.properties).binding;
    schema.required = ["capture", "x", "y"];
  }
  if (tool.name === "computer_ocr") {
    delete object(schema.properties).target;
    schema.required = ["capture"];
  }
  tool.description +=
    " Exact refs bind the original window and native observation. A retained control requires an explicit fresh observation ref before reuse. Native freshness and permissions are checked again; uncertain actions are never replayed.";
  return tool;
}

export function decodeComputerArguments(
  name: string,
  input: Record<string, unknown>,
  refs: ComputerReferencePort,
): Record<string, unknown> {
  const args = structuredClone(input);
  if (
    name === "computer_background_click" &&
    (args.capture === undefined ||
      Object.keys(args).some((key) => !["capture", "x", "y"].includes(key)))
  )
    throw Error(
      "Background click accepts only capture, x and y; omit target, binding and native IDs",
    );
  for (const forbidden of ["bindingId", "captureId", "baseObservationId"])
    if (forbidden in args)
      throw Error(
        "Use the exact compact Computer reference from a fresh inspection",
      );
  if (targetTools.has(name)) {
    if (name === "computer_inspect" && args.cursor !== undefined) {
      if (
        args.target !== undefined ||
        args.since !== undefined ||
        args.full !== undefined
      )
        throw Error(
          "Cursor already binds the exact window and immutable capture; omit target, since and full",
        );
      const cursor = object(refs.resolve(args.cursor, "cursor"));
      args.target = windowTarget(cursor.target);
      args.cursor = cursor.id;
    } else {
      args.target = windowTarget(
        typeof args.target === "string"
          ? refs.resolve(args.target, "window")
          : args.target,
      );
      if (name === "computer_inspect") {
        if (args.since !== undefined) {
          if (args.full === true) throw Error("Choose since or full, not both");
          const since = object(refs.resolve(args.since, "observation"));
          if (!sameTarget(since.target, args.target))
            throw Error("Observation belongs to another exact window target");
          args.baseObservationId = since.id;
          delete args.since;
        } else if (args.full === undefined) args.full = true;
      }
    }
  }
  if (semanticActions.has(name)) {
    if (args.target !== undefined)
      throw Error("Control already binds its exact window target");
    const control = object(refs.resolve(args.control, "control"));
    args.target = windowTarget(control.target);
    args.control = object(control.control);
    if (args.observation !== undefined) {
      const observation = object(refs.resolve(args.observation, "observation"));
      if (!sameTarget(observation.target, args.target))
        throw Error("Observation belongs to another exact window target");
      args.control = { ...object(args.control), observationId: observation.id };
      delete args.observation;
    }
    if (args.since !== undefined) {
      if (args.full === true) throw Error("Choose since or full, not both");
      const since = object(refs.resolve(args.since, "observation"));
      if (!sameTarget(since.target, args.target))
        throw Error("Diff baseline belongs to another exact window target");
      args.baseObservationId = since.id;
      delete args.since;
    }
    if (args.observe === undefined) args.observe = true;
  }
  if (
    name === "computer_ocr" &&
    (args.capture === undefined ||
      args.target !== undefined ||
      args.binding !== undefined)
  )
    throw Error(
      "OCR requires one exact screenshot capture ref; omit target and binding",
    );
  if (args.binding !== undefined) {
    const bound = object(refs.resolve(args.binding, "binding"));
    delete args.binding;
    args.bindingId = bound.id;
  }
  if (args.capture !== undefined) {
    const bound = object(refs.resolve(args.capture, "capture"));
    if (args.bindingId !== undefined && args.bindingId !== bound.bindingId)
      throw Error("Capture belongs to a different selected binding");
    delete args.capture;
    if (name === "computer_ocr" || name === "computer_background_click") {
      if (!bound.target)
        throw Error(
          "This capture ref has no original target; take a fresh screenshot for OCR",
        );
      args.target = windowTarget(bound.target);
      if (name === "computer_background_click")
        args.bindingId = bound.bindingId;
    } else args.bindingId = bound.bindingId;
    args.captureId = bound.captureId;
  }
  return args;
}

export function projectComputerResult(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  refs: ComputerReferencePort,
): Record<string, unknown> {
  const output = { ...result };
  if (record(result.after))
    output.after = projectComputerResult(object(result.after), args, refs);
  if (Array.isArray(result.windows)) {
    output.windows = result.windows.map((value) => {
      const item = object(value),
        target = windowTarget(item.target);
      return {
        ...pick(item, ["applicationName"]),
        ref: refs.bind("window", target),
        ...pick(target, ["windowTitle", "pid"]),
      };
    });
  }
  const target = record(args.target) ?? record(result.target);
  if (target && target.windowTitle !== undefined)
    output.window = refs.bind("window", windowTarget(target));
  delete output.target;
  if (typeof result.observationId === "string" && target)
    output.observation = refs.bind("observation", {
      target: windowTarget(target),
      id: result.observationId,
    });
  if (record(result.observation)) {
    const page = object(result.observation);
    output.page = pick(page, [
      "format",
      "identityKind",
      "capturedAt",
      "continuation",
      "unchanged",
      "resetReason",
    ]);
    if (typeof page.baseObservationId === "string" && target)
      (output.page as Record<string, unknown>).base = refs.bind("observation", {
        target: windowTarget(target),
        id: page.baseObservationId,
      });
  }
  delete output.observationId;
  const controlRef = (value: unknown) => {
    const control = object(value),
      selector = object(control.selector);
    const { selector: _selector, ...details } = control;
    return {
      ref: refs.bind("control", {
        target: windowTarget(target),
        control: pick(selector, ["observationId", "targetId"]),
      }),
      ...details,
    };
  };
  if (Array.isArray(result.controls))
    output.controls = result.controls.map(controlRef);
  if (record(result.controlChanges)) {
    const changes = object(result.controlChanges);
    const page = object(result.observation);
    if (
      typeof page.baseObservationId !== "string" ||
      typeof result.observationId !== "string"
    )
      throw Error(
        "Computer diff lacks exact observation provenance; inspect afresh",
      );
    const bindControl = (observationId: string, targetId: unknown) => {
      if (typeof targetId !== "string" || !targetId)
        throw Error("Computer diff lacks a stable presented control identity");
      return refs.bind("control", {
        target: windowTarget(target),
        control: { observationId, targetId },
      });
    };
    const added = Array.isArray(changes.added) ? changes.added : [];
    const addedIds = new Set(
      added.map((value) => object(object(value).selector).targetId),
    );
    const updated = Array.isArray(changes.updated) ? changes.updated : [];
    const order = Array.isArray(changes.order) ? changes.order : undefined;
    const retained = order?.filter((id) => !addedIds.has(id));
    output.controlChanges = {
      added: added.map(controlRef),
      updated: updated.map((value) => ({
        ...controlRef(value),
        beforeRef: bindControl(
          page.baseObservationId as string,
          object(object(value).selector).targetId,
        ),
      })),
      removedFromView: Array.isArray(changes.removedFromView)
        ? changes.removedFromView.map((id) =>
            bindControl(page.baseObservationId as string, id),
          )
        : [],
      ...(retained === undefined
        ? {}
        : {
            replacements: retained.map((id) => ({
              beforeRef: bindControl(page.baseObservationId as string, id),
              ref: bindControl(result.observationId as string, id),
            })),
          }),
      ...(order === undefined
        ? {}
        : {
            order: order.map((id) =>
              bindControl(result.observationId as string, id),
            ),
          }),
    };
  }
  if (typeof result.nextCursor === "string" && target)
    output.nextCursor = refs.bind("cursor", {
      id: result.nextCursor,
      target: windowTarget(args.target ?? target),
    });
  if (typeof result.bindingId === "string") {
    delete output.bindingId;
    output.binding = refs.bind("binding", { id: result.bindingId });
    if (typeof result.captureId === "string") {
      delete output.captureId;
      output.capture = refs.bind("capture", {
        target: windowTarget(args.target ?? target),
        bindingId: result.bindingId,
        captureId: result.captureId,
      });
    }
  }
  if (result.control !== undefined && target)
    output.control = refs.bind("control", {
      target: windowTarget(target),
      control: result.control,
    });
  return output;
}
