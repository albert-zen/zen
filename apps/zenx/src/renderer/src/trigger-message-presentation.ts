/** UI-only projection of the Host's exact wakeup formatter. Never grants source authority. */
export function triggerMessagePresentation(
  text: string,
  sourceId?: string,
): {
  text: string;
  name?: string;
  envelope?: string;
} {
  const fallback = { text };
  if (!sourceId || /[\r\n]/u.test(sourceId)) return fallback;
  const prefix = `[ZenX trigger wakeup]\nTrigger ID: ${sourceId}\n`;
  if (!text.startsWith(prefix)) return fallback;
  const separator = "\n\nInjected prompt:\n";
  const boundary = text.indexOf(separator, prefix.length);
  if (boundary < 0 || text.slice(0, boundary).includes("\r")) return fallback;
  const lines = text.slice(prefix.length, boundary).split("\n");
  if (!lines.shift()?.startsWith("Reason: ")) return fallback;
  const registered = lines.pop();
  if (!registered?.startsWith("Registered trigger: ")) return fallback;
  const name = registered.slice("Registered trigger: ".length);
  if (!name.trim() || name.includes("\r")) return fallback;
  const fields = [
    "Source device: ",
    "Source workspace: ",
    "Source Thread: ",
    "Source Turn: ",
    "Source Room: ",
    "Source Room message: ",
  ];
  let previous = -1;
  for (const line of lines) {
    const index = fields.findIndex((field) => line.startsWith(field));
    if (index <= previous || line.includes("\r")) return fallback;
    previous = index;
  }
  const start = boundary + separator.length;
  return { name, text: text.slice(start), envelope: text.slice(0, start) };
}
