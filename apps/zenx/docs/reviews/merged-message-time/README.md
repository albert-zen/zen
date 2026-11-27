# Message time and copying controls

Unedited, synthetic renders from the production ZenX ThreadView and virtual
transcript. Source tree is identical to merged PR #761 (main `9e65c349`,
reviewed head `5a259e00`). Linux Chromium 131, 1180 × 780, DPR 1, en-US, UTC,
matching Graphite light/dark. The outer fixture supplies a viewport height,
not the full desktop shell. No native Windows/macOS claim, no actual account,
delivery, real session logs, or provider. All sample messages came through the
native event reducer; the test marks the reply turn complete at Jan 18 09:09.

The control keeps all current time semantics and uses the same renderer bundle
with only the Host-action opacity rules removed. It is a controlled comparison
of indicator visibility, not an archived build of main before #761.

| Interaction | Controlled comparison | Merged behavior |
| --- | --- | --- |
| Pointer away | Ordinary Room/Host time hidden | Jan 17 09:01 remains visible; Copy hidden |
| Pointer on Room/Host row | Neither time nor Copy visible | Time remains; Copy appears |
| Tab until Copy is focused | Focus exists but control is invisible | Time remains; Copy and focus indicator visible |
| Pointer leaves, no row focus | Host controls hidden | Time still visible; Copy hidden |
| Hover completed reply | Jan 18 09:09 | Jan 18 09:09 (Turn end, not prior-day Host time) |

Four runs passed: both variants, both themes. Chromium matched fine pointer.
Normal Tab, not programmatic focus, reached the control. Hover and focus were
observed after the transition; inspected dates were UTC and crossed midnight.
This did not test system clipboard access or source navigation.

[ZCode v3.18.2's assistant action row](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/v4/ConversationRowView.tsx#L1503-L1508)
is an adjacent source-only reference for subdued time metadata. It displays
row creation time, not Zen’s authoritative Turn end, and is not a matched
ordinary Room/Host card. No external matched capture or comparative score (N/O).
