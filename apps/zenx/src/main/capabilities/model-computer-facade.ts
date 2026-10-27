import type { ModelTool } from "../../../../../src/model.js";
import type { ModelReferenceScope } from "../../../../../src/model-references.js";
import { asJson } from "./model-facade-fields.js";
import {
  isComputerModelTool,
  computerModelDefinition as definition,
  decodeComputerArguments as decode,
  projectComputerResult as project,
  type ComputerReferencePort,
} from "../../../../../packages/zenx-computer-plugin/src/model-contract.js";

export { isComputerModelTool };

/** The Host adapts existing trusted rN provenance to the package contract. */
function port(refs: ModelReferenceScope, epoch: string): ComputerReferencePort {
  return {
    bind: (kind, value) => refs.bind("computer", kind, asJson(value), epoch),
    resolve: (ref, kind) => refs.resolve(ref, "computer", kind, epoch),
  };
}

export function computerModelDefinition<T extends ModelTool>(source: T): T {
  return definition(source);
}
export function decodeComputerArguments(
  name: string,
  input: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  return decode(name, input, port(refs, epoch));
}
export function projectComputerResult(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  return project(result, args, port(refs, epoch));
}
