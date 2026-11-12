import type { Terminal } from "@xterm/xterm";

/** Treat output as display data, never navigation or clipboard authority. */
export function restrictTerminalOutput(terminal: Pick<Terminal, "parser">) {
  // xterm registers an OSC 8 hyperlink provider even without a link addon.
  terminal.parser.registerOscHandler(8, () => true);
  terminal.parser.registerOscHandler(52, () => true);
}
