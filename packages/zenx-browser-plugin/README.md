# ZenX Browser

First-party Browser package distributed with ZenX and installed through the ordinary plugin profile.

Prefer `observe: true` on `browser_open`, `browser_navigate`, `browser_click`,
`browser_type`, `browser_select` and `browser_scroll`. These calls return a fresh
inspection, including a fresh observation ID and screenshot metadata, with the action result.
This avoids a separate model call to inspect after every action. Omitting the
option preserves the summary-only response. If a follow-up inspection fails,
the result explicitly includes `actionCompleted: true` and `observationError`;
inspect again rather than repeating the completed action. Action failures still
fail normally and are never retried automatically.

## Bounded capture, continuation and diffs

Version 1.0.4 adds immutable capture paging and explicit-baseline diffs. A
`full` response is a self-contained bounded view, not a claim that the whole
DOM, page or accessibility tree was returned. Inspect `coverage.scope`,
`sourceComplete` and `reasons`, plus the separate item/text `hasMore` flags.
`coverage.complete` is true only when that single reply contains the entire
declared captured scope with no native omissions. A final tail page does not
by itself become a complete snapshot.

- `browser_inspect` without a base returns a fresh full first page: at most
  80 targets (128 for Playwright), 8,000 text characters and bounded JSON bytes.
- Use its `nextCursor` as `browser_inspect({ sessionId, tabId, cursor })` to
  read more of that exact immutable capture. The observation ID and capture
  time do not change; no new screenshot or DOM snapshot is taken.
- Captures retain at most 512 targets and 128,000 text characters, subject to
  a 2 MiB host capture budget. Native omissions are still reported on every
  page. Electron/Chrome capture top-document light-DOM viewport controls and
  body text, excluding frame/shadow-root contents. Playwright's depth-12 ARIA
  capture cannot prove complete native coverage.
- Pass `baseObservationId` only when retaining that first page and all applied
  diffs. A matching scope may return `observation.format: "diff"` with
  `targetChanges.added`, `updated`, `removedFromView` and, when changed, the
  complete new reference `order`. Replace `visibleText` only when present.
  `removedFromView` means absence from this bounded view, not DOM deletion.
- Surviving DOM objects present in consecutive retained captures keep their
  presentation `targetId`; leaving the bounded capture and later re-entering
  may allocate a new reference. Navigation or
  actual replacement yields a new identity. Every action still requires the
  latest `observationId` and native object/fingerprint validation. Stable IDs
  are not timeless action capabilities.
- Discard old continuation pages when adopting any new observation or diff;
  its diff covers the first page only. Follow its new cursor for current tails.
  Cursor reads do not change the first-page diff baseline or renew actions.
- Omit `baseObservationId`, or pass `full: true`, after compaction/lost context.
  Missing bases, changed document scope or a larger diff return full with an
  explicit reset reason. Expired/consumed/foreign cursors fail clearly; omit
  cursor to inspect afresh. There is no silent recapture or action retry.

Capture caches are host-local: five-minute lifetime, at most 64 scopes and
16 MiB per presentation store. Byte-aware pages normally target 32 KiB, with a
128 KiB hard page ceiling for a large single control. Host-budget omissions
are explicit. Pages can read only captured data; targeted search/subtree
queries, unbounded extraction and image diffs are not implemented here.

Update the Browser package in Plugin settings to expose the new schema in an
existing profile. Runtime code alone does not replace an installed manifest.

Version 1.0.3 adds native `browser_select`, current non-password control state,
bounded select options, and contenteditable typing. `browser_scroll` requires an explicit `sessionId`, `tabId`,
latest `observationId`, direction (`up`, `down`, `left`, `right`), and integer
`pixels` from 1 to 2000. It scrolls the page viewport and consumes the observation;
inspect again before the next interaction. Nested scroll containers are not yet
supported. Electron and attached CDP observations now identify form fields from
`aria-labelledby` and associated HTML labels, with the same name checked again
before an action. This is a bounded name heuristic, not a complete accessibility
name implementation.

Playwright's ARIA targets can include offscreen controls that its native actions
scroll into view. Electron and attached CDP targets are limited to the viewport.
Independent page scrolling is available in all three providers.
