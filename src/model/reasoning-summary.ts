/** Official OpenAI reasoning requests opt into public summaries by default.
 * This is a request policy, not a claim that every model returns a summary.
 * Third-party endpoints keep their existing request behavior.
 */
export function shouldRequestOpenAiReasoningSummary(endpoint: string): boolean {
  const url = new URL(endpoint);
  return (
    (url.origin === "https://api.openai.com" &&
      url.pathname === "/v1/responses") ||
    (url.origin === "https://chatgpt.com" &&
      url.pathname === "/backend-api/codex/responses")
  );
}
