import {
  restingConversationLabelPlans,
  type RestingLabelPlan,
} from "./workspace-resting-labels.js";

/** Presentation-only plans for already-visible siblings; no identity changes. */
export function sidebarChildTitlePlans(
  rows: readonly { id: string; title: string; parentId?: string | null }[],
): ReadonlyMap<string, RestingLabelPlan> {
  const result = new Map<string, RestingLabelPlan>();
  const groups = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    if (!row.parentId || row.parentId === row.id) continue;
    const group = groups.get(row.parentId) ?? [];
    group.push(row);
    groups.set(row.parentId, group);
  }
  const normalized = (value: string) =>
    value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  for (const group of groups.values()) {
    const tabs = group.map((row) => ({
      id: `thread:${row.id}`,
      title: row.title,
    }));
    const plans = restingConversationLabelPlans(
      tabs,
      new Set(tabs.map((tab) => tab.id)),
    );
    for (const row of group) {
      let plan = plans.get(`thread:${row.id}`)!;
      if (plan.marked === row.title) continue;
      // An explicit extension already states the meaningful distinction. Keep
      // that whole phrase instead of reducing "alternate review" to "review".
      const extended = group
        .filter(
          (peer) =>
            peer.id !== row.id && row.title.startsWith(`${peer.title} · `),
        )
        .sort((a, b) => b.title.length - a.title.length)[0];
      if (extended) {
        const phrase = row.title.slice(extended.title.length + 3);
        if (
          !phrase.trim() ||
          rows.some(
            (other) =>
              other.id !== row.id &&
              normalized(other.title).endsWith(normalized(phrase)),
          )
        )
          continue;
        plan = { marked: `… ${phrase}`, bare: phrase };
      }
      const collides = (label: string) =>
        rows.some(
          (other) =>
            other.id !== row.id &&
            normalized(other.title) === normalized(label),
        );
      if (collides(plan.marked)) continue;
      result.set(row.id, {
        marked: plan.marked,
        bare: plan.bare && !collides(plan.bare) ? plan.bare : undefined,
      });
    }
  }
  // Recent may show siblings from several parents. Reserve proposals globally
  // too, so independent group decisions cannot create matching short labels.
  const proposed = [...result];
  for (const [id, plan] of proposed) {
    const collides = (label: string) =>
      proposed.some(
        ([otherId, other]) =>
          otherId !== id &&
          [other.marked, other.bare].some(
            (value) =>
              value !== undefined && normalized(value) === normalized(label),
          ),
      );
    if (collides(plan.marked)) result.delete(id);
    else if (plan.bare && collides(plan.bare))
      result.set(id, { marked: plan.marked });
  }
  return result;
}
