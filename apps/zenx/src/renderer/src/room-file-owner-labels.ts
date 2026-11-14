import { restingConversationLabelPlans } from "./workspace-resting-labels.js";

/** Display-only qualification of exact same-path Room files; never a routing identity. */
export function roomFileOwnerLabels(
  tabs: readonly {
    id: string;
    path?: string;
    resourceThreadId?: string;
    descriptor?: { kind: string };
  }[],
  members: readonly { threadId: string; title: string }[] | undefined,
): Map<string, { title: string; marked: string; bare?: string }> {
  const result = new Map<
    string,
    { title: string; marked: string; bare?: string }
  >();
  if (!members) return result;
  const normalize = (value: string) =>
    value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  const groups = new Map<string, (typeof tabs)[number][]>();
  for (const tab of tabs) {
    if (
      tab.descriptor?.kind !== "file" ||
      !tab.path ||
      !tab.resourceThreadId ||
      /^(?:[\\/]|[a-z]:)/iu.test(tab.path) ||
      tab.path.split(/[\\/]/u).includes("..")
    )
      continue;
    const peers = groups.get(tab.path) ?? [];
    peers.push(tab);
    groups.set(tab.path, peers);
  }
  for (const peers of groups.values()) {
    const owners = [...new Set(peers.map((tab) => tab.resourceThreadId!))];
    if (owners.length < 2) continue;
    const titles = owners.map(
      (id) => members.find((member) => member.threadId === id)?.title,
    );
    // A number or raw ID cannot supply a missing human identity. Keep the existing
    // label when the admitted projection is absent, blank or indistinguishable.
    if (
      titles.some((title) => !title?.trim()) ||
      new Set(titles.map((title) => normalize(title!))).size !== owners.length
    )
      continue;
    const ownerTabs = owners.map((id, index) => ({
      id: `thread:${id}`,
      title: titles[index]!,
    }));
    const plans = restingConversationLabelPlans(
      ownerTabs,
      new Set(ownerTabs.map((tab) => tab.id)),
    );
    for (const tab of peers) {
      const index = owners.indexOf(tab.resourceThreadId!);
      result.set(tab.id, {
        title: titles[index]!,
        ...plans.get(`thread:${tab.resourceThreadId}`)!,
      });
    }
  }
  return result;
}
