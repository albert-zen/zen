/** Pure discovery metadata. Methods always dispatch the original tool, never native IO. */
export interface ComputerObjectBinding {
  kind: "computer";
  provider: string;
  path: readonly string[];
  reference?: { kind: string; argument: string };
}

/** Called only for tools actually exposed by the installed provider's catalog. */
export function computerObjectBinding(
  name: string,
  provider: string,
  inputSchema: Record<string, unknown>,
): ComputerObjectBinding | undefined {
  const bind = (
    path: string[],
    kind?: string,
    argument?: string,
  ): ComputerObjectBinding => ({
    kind: "computer",
    provider,
    path,
    ...(kind && argument ? { reference: { kind, argument } } : {}),
  });
  switch (name) {
    case "computer_environment":
      return bind(["environment"]);
    case "computer_list_windows":
      return bind(["windows", "list"]);
    case "computer_inspect":
      return bind(["inspect"], "window", "target");
    case "computer_screenshot":
      return bind(["screenshot"], "window", "target");
    case "computer_select_target":
      return bind(["select"], "window", "target");
    case "computer_press":
      return bind(["press"], "control", "control");
    case "computer_set_value":
      return bind(["setValue"], "control", "control");
    case "computer_ocr":
      return bind(["extensions", "vision", "ocr"], "capture", "capture");
    case "computer_background_click":
      return bind(["background", "click"], "capture", "capture");
    case "computer_background_type":
      return bind(["type"], "appCurrentFocus", "binding");
    case "computer_background_key_press":
      return bind(["keyPress"], "appCurrentFocus", "binding");
  }
  const foreground: Record<string, string> = {
    computer_foreground_click: "click",
    computer_foreground_drag: "drag",
    computer_foreground_key_press: "keyPress",
    computer_foreground_type: "type",
    computer_foreground_shortcut: "shortcut",
    computer_foreground_scroll: "scroll",
  };
  const method = Object.hasOwn(foreground, name) ? foreground[name] : undefined;
  if (!method) return undefined;
  const properties = inputSchema.properties;
  const bound =
    properties !== null &&
    typeof properties === "object" &&
    ("bindingId" in properties || "binding" in properties);
  // Legacy providers expose desktop-wide input; never label it exact-window input.
  if (!bound) return bind(["foreground", method]);
  return name === "computer_foreground_click" ||
    name === "computer_foreground_drag"
    ? bind(["foreground", method], "capture", "capture")
    : bind(["foreground", method], "binding", "binding");
}
