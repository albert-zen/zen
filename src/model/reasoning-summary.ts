/**
 * Summary opt-in is a verified OpenAI route/model capability, not a property of
 * the Responses wire format. Unknown models, aliases and gateways stay unchanged.
 * https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries
 */
export function supportsOpenAiReasoningSummary(
  endpoint: string,
  model: string,
): boolean {
  const url = new URL(endpoint);
  const officialRoute =
    (url.origin === "https://api.openai.com" &&
      url.pathname === "/v1/responses") ||
    (url.origin === "https://chatgpt.com" &&
      url.pathname === "/backend-api/codex/responses");
  return (
    officialRoute &&
    [
      "gpt-5.4",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-astra",
      "gpt-6.1-sol",
    ].includes(model.trim())
  );
}
