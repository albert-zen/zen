# PR286: read-state and throughput correction

## Primary-source references

Checked 2026-10-12:

- [Matrix Client-Server API: receipts](https://spec.matrix.org/latest/client-server-api/#receipts) ties read acknowledgement to a specific event and requires evidence that it was displayed; delivery alone is insufficient. Adopted: exact message identity, visible loaded surface, and no read advancement on failed or late hidden recovery. We deliberately do not adopt Matrix's server-side receipt synchronization: ZenX's unread state remains a local UI preference, outside canonical Items.
- [Matrix fully read markers](https://spec.matrix.org/latest/client-server-api/#fully-read-markers) identifies a read boundary by event ID. Adopted: a Room's latest message ID, including when timestamps collide or retained history is saturated. IDs are compared for identity, never sorted as clocks. A loaded older tail cannot acknowledge the newer navigation tail.
- [vLLM metrics design](https://docs.vllm.ai/en/latest/design/metrics/) distinguishes end-to-end request latency, time to first token and inter-token/decode measurements. Adopted: an explicit measurement interval, matched output usage and unquantized duration. This UI measures output over completed Turn duration, including tool/wait time inside the Turn, and excludes idle gaps between Turns. It is not provider decode throughput. The label states “Turn duration”; unavailable timing stays Unknown. No token-arrival timing is inferred from UI refresh or whole-second display timestamps.

## Boundaries

- Thread summaries expose an optional read-only final-answer Item ID and canonical position, derived from existing Items. Only the last nonempty complete Agent message of a successfully completed Turn qualifies. Configuration, queued input, tool-only progress, failed/aborted/unfinished Turns and future `incomplete: true` messages do not advance it.
- The latest native summary plus loaded final Item identity handles live projections that omit control Items. No hidden transcript reads, new canonical read receipts or second execution state are introduced.
- Unknown summaries remain unknown; known empty conversations retain an empty baseline. New local storage uses a versioned key because a Thread's content position cannot be compared to the former timestamp. Within that version, read marks survive reload.
- Recovery duration preserves canonical milliseconds. Live events lacking canonical start/end timing report Unknown until a complete recovery provides the facts.

## Verification

Regression coverage includes retained Thread selection on another page, metadata-only updates, initial and empty baselines, reload, failed/pending/late recovery, stale loaded prefixes, live final-Item identity, unknown native summaries, same-second/cross-second subsecond durations, missing/invalid durations, Room same-time distinct IDs, saturated history, failed history, preview-only rows and route changes.

Checks are serial and focused, not an aggregate native product acceptance claim. Hosted CI must be evaluated for the new head, not reused from the original PR head. No other unmerged PR was incorporated.
