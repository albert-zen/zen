import type { UserInput } from "../item.js";
/** Serialization reads only supplied semantic parts. Timestamps/instructions belong to the compiler. */
export function contextUserContent(
  message: { text: string } | { content: UserInput },
): UserInput {
  return "content" in message
    ? message.content
    : [{ type: "text", text: message.text }];
}
