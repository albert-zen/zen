/** Opt-in synthetic fixture only; no filesystem, network, protocol or product capability. */
export const RESULT_FILE_OWNER = "thread-1";
export const RESULT_FILE_PATH = "RESULT.md";
export const RESULT_FILE_TEXT =
  "# Synthetic review result\n\nThis in-memory document is the exact linked artifact.\n\nNo command or file operation was executed.\n";
export const RESULT_FILE_MARKDOWN = [
  "## Synthetic review complete",
  "The existing document is ready to inspect. This is an invented layout scenario, not a completed real task.",
  "[Open the synthetic review result](RESULT.md)",
  "Keep this paragraph as the reading-position marker while inspecting the document. Return here to continue the conversation.",
].join("\n\n");
export function createResultFileFixture() {
  const reads: Array<{ threadId: string; path: string }> = [];
  let activeReads = 0;
  let maxConcurrentReads = 0;
  return {
    async read(threadId: string, path: string) {
      if (threadId !== RESULT_FILE_OWNER || path !== RESULT_FILE_PATH)
        throw new Error("Synthetic result fixture rejected owner or path");
      reads.push({ threadId, path });
      activeReads++;
      maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
      try {
        await Promise.resolve();
        return { path, text: RESULT_FILE_TEXT, revision: "synthetic-result-0" };
      } finally {
        activeReads--;
      }
    },
    receipt() {
      return {
        synthetic: true,
        owner: RESULT_FILE_OWNER,
        path: RESULT_FILE_PATH,
        reads: reads.map((r) => ({ ...r })),
        activeReads,
        maxConcurrentReads,
      };
    },
  };
}

export function resultFileSceneEnabled(params: URLSearchParams): boolean {
  if (params.get("resultFile") !== "1") return false;
  const conflicting = [
    "results",
    "inlineTrace",
    "nestedOutput",
    "codeWrap",
    "tableKeyboard",
    "childQuestions",
    "streaming",
    "pending",
    "busyChild",
    "conversationTabs",
    "launchers",
  ];
  if (
    params.get("scene") !== "reading" ||
    conflicting.some((key) => params.has(key))
  )
    throw new Error("Result-file evidence requires an exclusive reading scene");
  return true;
}
