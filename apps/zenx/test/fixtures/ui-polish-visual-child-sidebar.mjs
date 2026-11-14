/** Disposable synthetic preference only. No Host, account, disk or network access. */
export function createChildSidebarPreference() {
  let visible = ["test-child"];
  const changes = [];
  const read = () => ({
    visibleSubagentThreadIds: [...visible],
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  });
  return {
    read,
    setVisible(...args) {
      const [threadId, next] = args;
      if (
        args.length !== 2 ||
        threadId !== "design-child" ||
        typeof next !== "boolean" ||
        changes.length >= 2 ||
        next !== (changes.length === 0)
      )
        throw Error("Unsupported synthetic child visibility preference");
      visible = next
        ? [...new Set([...visible, threadId])]
        : visible.filter((id) => id !== threadId);
      changes.push({ threadId, visible: next });
      return read();
    },
    receipt: () => ({
      scope: "synthetic-in-memory-preference-only",
      changes: changes.map((entry) => ({ ...entry })),
      ...read(),
    }),
  };
}
