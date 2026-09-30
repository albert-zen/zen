# Context compression contract (candidate)

Current Core has generated compaction via `AppServer.compactThread` / ZAS `thread/compact`, and experimental active-Turn `compact_context({text})`; the latter resets with no retained Items. The existing Core bounded-retention planner (budget/recent-items/selected-items, user and final-message categories, tool closure) is the sole retention authority. The current conversation's external `compact_context` schema is not controlled by this checkout.

This change extends the Core planner with explicit Item IDs/ranges, Turn count and category selections and applies it to both generated and agent-authored compaction. A Host-constructed logical `zen-thread://` reference stores Thread and cutoff Item, not an arbitrary caller path; enabled by default, disabled explicitly, and resolved only through existing authorized Thread reads. It is a locator, **not** permission to read hidden reasoning or queued input. No journal truncation; compaction appends one canonical Item. Generated compaction stays behind the per-Thread mutation lock; active-Turn agentic compaction snapshots at sample boundary, and newer Items remain outside coverage. Budget failures do not append a successful compaction. CAS mapping remains limited; ZAS evolves independently.

ZenX uses the existing `/compact` or toolbar request, both through `thread/compact`;
`/compact --no-reference` explicitly disables the locator. The agent tool schema in
this checkout changes only future locally admitted Zen Runtime turns; it does not
retrofit the external tool offered to this running assistant.
