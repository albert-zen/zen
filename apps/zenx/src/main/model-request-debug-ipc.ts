import { validateModelRequestDebugCommand } from "../../../cli/src/model-request-debug.js";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
} from "../../../cli/src/model-request-debug-types.js";
import { isTrustedImZenXSetupSender } from "./imzenx-setup-ipc.js";
/** Full local evidence is only available to an owned ZenX main frame, never a webview. */
export function createModelRequestDebugHandler<Event>(options: {
  rendererUrl: string;
  sender(event: Event): {
    ownedWindow: boolean;
    mainFrame: boolean;
    url: string;
  };
  read(command: ModelRequestDebugCommand): Promise<ModelRequestDebugResult>;
}): (event: Event, input: unknown) => Promise<ModelRequestDebugResult> {
  return async (event, input) => {
    if (!isTrustedImZenXSetupSender(options.sender(event), options.rendererUrl))
      throw new Error("Trace reading requires the trusted ZenX main frame");
    return options.read(validateModelRequestDebugCommand(input));
  };
}
