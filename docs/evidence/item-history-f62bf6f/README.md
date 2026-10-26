# Canonical Item history: final synthetic browser acceptance

These are unmodified Chromium screenshots of the production inspection components, using synthetic history and an in-memory capture/Host bridge. No actual user history, user computer, credentials or paid model API was used. This is not native desktop, live Host or live model acceptance.

## Exact identity

- Public source head: `f62bf6f847cc6607d565d084933f51ec9204b7ab`.
- Frozen local source: `72b2869a34031e8400c05b55ac23f5ae610aee1c`.
- CI test merge: `7eb3b4e70267723c91543caec16822f4935887b9`.
- All three source trees: `77c0082455523022c55f1b48185f0123776a02c8`.
- CI run: https://github.com/albert-zen/zen/actions/runs/40314250284
- Artifact ID: `12646321882` (`zenx-message-debug-7eb3b4e70267723c91543caec16822f4935887b9`).
- Downloaded artifact ZIP SHA-256: `b914de497cad84e383169b91c2357956ea446a9d3bd60a778a3a68763b46221c`.
- `source.json` records all 11 source-file SHA-256 values; each was verified against the frozen local commit. `source-verification.json` also records the SHA-256 of every PNG. Historical "experimental" wording in the fixture's source.json scope string does not indicate a feature gate.

## Reviewed matrix

All fourteen original PNGs were individually inspected with view_image. Both English/light/1100x900 and Chinese/dark/390x844 were reviewed:

1. `canonical-content-*`: readable literal canonical part order, trusted Host metadata label, recorded time, raw Item disclosure and optional capture disclosure. Capture is not needed to view the canonical content.
2. `message-input-*`: retained overview of the expanded optional capture section. Payload below the fold in these two overviews is not treated as standalone proof of payload visibility.
3. `captured-json-start-*`: real dialog scrolling exposes the attributed JSON role and received_at text, with the transport-observation boundary stated above it.
4. `captured-json-end-*`: real inner pre scrolling exposes the remaining synthetic reference and closing JSON. The start/end pair covers the payload, without enlarging or replacing production styles.
5. `canonical-history-*`: canonical append-order Items, operation identity and source links; longer history scrolls vertically rather than horizontally overflowing.
6. `operation-history-*`: explicit read-only operation selection and nested canonical Items.
7. `operation-terminal-*`: actual nested-history scrolling shows terminal `completed` and canonical text output `Blue`, distinct from the input context and status.

No visual blocker was observed in this synthetic matrix. JSON remains intentionally literal and wraps at narrow width. The fixture represents a successful probe, not a Host-error screenshot; Host-diagnostic separation is additionally exercised by the focused tests, not claimed as a separate error-state image here.

## Automated evidence and limits

The capture step passed. `measurements.json` records ten visible-text states (role, metadata, JSON tail, completed status and Blue in each locale), each with rendered Range rectangles inside the viewport and every clipping ancestor, and no page horizontal overflow. It also records bounded dialog geometry, expected canonical/captured content, list/read-only commands, Escape dismissal and focus restoration. Browser cleanup completed successfully.

The eight prior overview images were retained and are byte-identical to the earlier checkpoint's captures; the six added scrolled images close the prior below-the-fold coverage gap. No production source component was changed to make a screenshot pass. Full current-head CI outcome and final merge authorization remain tracked on PR #498; this evidence commit is separate from the production branch and does not merge anything.
