/** Presentation only. Canonical titles and persisted tab identities stay intact. */
export function restingConversationLabels(
  tabs: readonly { id: string; title: string }[],
  overflowingIds: ReadonlySet<string>,
  desktop = true,
): Map<string, string> {
  const result = new Map(tabs.map((tab) => [tab.id, tab.title]));
  if (!desktop || typeof Intl.Segmenter !== "function") return result;
  const normalize = (value: string) =>
    value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const split = (value: string) =>
    [...segmenter.segment(value)].map((part) => part.segment);
  const conversations = tabs.filter((tab) => tab.id.startsWith("thread:"));
  const parts = new Map(conversations.map((tab) => [tab.id, split(tab.title)]));
  for (const tab of conversations) {
    if (!overflowingIds.has(tab.id)) continue;
    const own = parts.get(tab.id)!;
    const peers = conversations.filter((other) => {
      if (other.id === tab.id) return false;
      const peer = parts.get(other.id)!;
      return (
        own.length > 12 &&
        peer.length > 12 &&
        own.slice(0, 12).every((value, index) => value === peer[index])
      );
    });
    if (
      !peers.length ||
      conversations.some(
        (peer) =>
          peer.id !== tab.id && normalize(peer.title) === normalize(tab.title),
      )
    )
      continue;
    const group = [tab, ...peers].map((peer) => parts.get(peer.id)!);
    let prefix = 0;
    while (
      group.every(
        (value) => value[prefix] !== undefined && value[prefix] === own[prefix],
      )
    )
      prefix++;
    const remainder = own.slice(prefix).join("").trimStart();
    if (!remainder) continue;
    // Shortest unique whitespace-delimited trailing segment, otherwise the
    // complete differing suffix (also supports titles without word separators).
    // All choices are exact suffixes of the canonical name, not invented labels.
    const choices = [
      remainder,
      ...[...remainder.matchAll(/\s+/gu)].map((match) =>
        remainder.slice(match.index! + match[0].length),
      ),
    ]
      .filter((value) => value && /[\p{L}\p{N}\p{S}]/u.test(value))
      .sort((a, b) => split(a).length - split(b).length);
    const suffix = choices.find(
      (value) =>
        !tabs.some(
          (peer) =>
            peer.id !== tab.id &&
            normalize(peer.title).endsWith(normalize(value)),
        ),
    );
    if (suffix) result.set(tab.id, `… ${suffix}`);
  }
  // Check all proposed labels simultaneously, not in iteration order. Also
  // reject collisions with canonical names, including non-conversation tabs.
  const rejected = tabs.filter(
    (tab) =>
      result.get(tab.id) !== tab.title &&
      tabs.some(
        (peer) =>
          peer.id !== tab.id &&
          (normalize(result.get(peer.id)!) === normalize(result.get(tab.id)!) ||
            normalize(peer.title) === normalize(result.get(tab.id)!)),
      ),
  );
  for (const tab of rejected) result.set(tab.id, tab.title);
  return result;
}

export interface RestingLabelPlan {
  marked: string;
  bare?: string;
}

/** Reserve every canonical and proposed form so independent fit decisions cannot collide. */
export function restingConversationLabelPlans(
  tabs: readonly { id: string; title: string }[],
  overflowingIds: ReadonlySet<string>,
  desktop = true,
): Map<string, RestingLabelPlan> {
  const marked = restingConversationLabels(tabs, overflowingIds, desktop);
  const normalize = (value: string) =>
    value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  const proposed = new Map(
    tabs.map((tab) => {
      const label = marked.get(tab.id)!;
      const suffix = label.startsWith("… ") ? label.slice(2) : undefined;
      // A literal ellipsis in an unchanged canonical name is not a proposal.
      const bare =
        label !== tab.title && suffix && tab.title.endsWith(suffix)
          ? suffix
          : undefined;
      return [tab.id, { marked: label, bare }] as const;
    }),
  );
  return new Map(
    tabs.map((tab) => {
      const plan = proposed.get(tab.id)!;
      const collision =
        plan.bare &&
        tabs.some((peer) => {
          if (peer.id === tab.id) return false;
          const other = proposed.get(peer.id)!;
          return [peer.title, other.marked, other.bare].some(
            (value) =>
              value !== undefined && normalize(value) === normalize(plan.bare!),
          );
        });
      return [
        tab.id,
        { marked: plan.marked, bare: collision ? undefined : plan.bare },
      ];
    }),
  );
}

export function restingLabelFitMode({
  desktop,
  available,
  full,
  marked,
  bare,
}: {
  desktop: boolean;
  available: number;
  full: number;
  marked?: number;
  bare?: number;
}): "canonical" | "marked" | "bare" {
  if (
    !desktop ||
    !Number.isFinite(available) ||
    available <= 0 ||
    !Number.isFinite(full) ||
    full <= available + 1
  )
    return "canonical";
  const fits = (width: number | undefined) =>
    width !== undefined &&
    Number.isFinite(width) &&
    width > 0 &&
    width <= available;
  if (fits(marked)) return "marked";
  if (fits(bare)) return "bare";
  return "canonical";
}
