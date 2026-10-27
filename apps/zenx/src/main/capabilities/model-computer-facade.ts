import type { ModelTool } from "../../../../../src/model.js";
import type { ModelReferenceScope } from "../../../../../src/model-references.js";
import {
  MODEL_REF,
  object,
  asJson,
  renameField,
} from "./model-facade-fields.js";
const names = new Set([
  "computer_list_windows",
  "computer_select_target",
  "computer_inspect",
  "computer_press",
  "computer_set_value",
  "computer_screenshot",
  "computer_foreground_click",
  "computer_foreground_key_press",
  "computer_foreground_type",
  "computer_foreground_shortcut",
  "computer_foreground_scroll",
]);
export const isComputerModelTool = (name: string) => names.has(name);
export function computerModelDefinition<T extends ModelTool>(source: T): T {
  const tool = structuredClone(source),
    schema = tool.inputSchema,
    fields = object(schema.properties ?? {});
  renameField(schema, "bindingId", "binding");
  renameField(schema, "captureId", "capture");
  if (tool.name === "computer_press" || tool.name === "computer_set_value") {
    delete fields.target;
    fields.control = structuredClone(MODEL_REF);
    schema.required =
      tool.name === "computer_press" ? ["control"] : ["control", "value"];
  }
  if (tool.name === "computer_inspect") {
    delete fields.baseObservationId;
    delete fields.full;
    if (fields.cursor) fields.cursor = structuredClone(MODEL_REF);
    schema.required = [];
    schema.oneOf = [{ required: ["target"] }, { required: ["cursor"] }];
  }
  tool.description =
    tool.name === "computer_inspect"
      ? "Inspect an exact semantic window target. Returns self-contained bounded controls with exact refs; follow cursor alone for immutable continuation without recapture. Coverage retains native omissions."
      : tool.description;
  if (tool.name === "computer_press" || tool.name === "computer_set_value")
    tool.description =
      "Act on the exact scoped control ref from inspection. The ref binds the original request target and observed control pair; native action support and freshness are revalidated.";
  if (tool.name === "computer_foreground_click" && fields.capture)
    tool.description =
      "FOREGROUND TAKEOVER: click image-pixel x/y on the exact screenshot capture ref. Existing native selected-window, focus and geometry checks run immediately before posting.";
  tool.description +=
    " Use exact control/binding/capture refs, never the newest observation implicitly. Existing native owner, target, freshness, geometry and permission guards still run. Dispatch is not proof of application effect; never replay an uncertain action automatically.";
  return tool;
}
export function decodeComputerArguments(
  name: string,
  input: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  const args = structuredClone(input);
  for (const key of ["bindingId", "captureId", "baseObservationId", "full"])
    if (key in args)
      throw Error(
        "Use the exact compact Computer reference from a fresh inspection",
      );
  if (name === "computer_press" || name === "computer_set_value") {
    const bound = object(
      refs.resolve(args.control, "computer", "control", epoch),
    );
    if (args.target !== undefined)
      throw Error("control already binds its exact target");
    args.target = bound.target;
    args.control = bound.control;
  }
  if (name === "computer_inspect") {
    if (args.cursor !== undefined) {
      const bound = object(
        refs.resolve(args.cursor, "computer", "cursor", epoch),
      );
      if (args.target !== undefined)
        throw Error("cursor binds the exact target; omit target");
      args.target = bound.requestTarget;
      args.cursor = bound.id;
    } else args.full = true;
  }
  if (args.binding !== undefined) {
    const bound = object(
      refs.resolve(args.binding, "computer", "binding", epoch),
    );
    delete args.binding;
    args.bindingId = bound.id;
  }
  if (args.capture !== undefined) {
    const bound = object(
      refs.resolve(args.capture, "computer", "capture", epoch),
    );
    if (args.bindingId !== undefined && args.bindingId !== bound.bindingId)
      throw Error("Capture belongs to a different selected binding");
    delete args.capture;
    args.bindingId = bound.bindingId;
    args.captureId = bound.captureId;
  }
  return args;
}
export function projectComputerResult(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  const output = { ...result };
  delete output.observationId;
  if (Array.isArray(result.controls))
    output.controls = result.controls.map((value) => {
      const { selector, ...details } = object(value);
      const pair = object(selector);
      return {
        ref: refs.bind(
          "computer",
          "control",
          asJson({
            target: args.target,
            control: {
              observationId: pair.observationId,
              targetId: pair.targetId,
            },
          }),
          epoch,
        ),
        ...details,
      };
    });
  if (typeof result.nextCursor === "string")
    output.nextCursor = refs.bind(
      "computer",
      "cursor",
      asJson({ id: result.nextCursor, requestTarget: args.target }),
      epoch,
    );
  if (typeof result.bindingId === "string") {
    delete output.bindingId;
    output.binding = refs.bind(
      "computer",
      "binding",
      { id: result.bindingId },
      epoch,
    );
    if (typeof result.captureId === "string") {
      delete output.captureId;
      output.capture = refs.bind(
        "computer",
        "capture",
        { bindingId: result.bindingId, captureId: result.captureId },
        epoch,
      );
    }
  }
  if (result.control !== undefined)
    output.control = refs.bind(
      "computer",
      "control",
      asJson({ target: args.target, control: args.control }),
      epoch,
    );
  return output;
}
