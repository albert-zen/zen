# Native selection segments: isolated mechanism checkpoint

This is a disposable mechanism prototype, not a ZenX implementation or native
acceptance result. Source identity: public ZenX `572fe27e`, tree prefix `bbe3`.
No product files, Legend dependency, existing diagnostic, default, publication,
clipboard handler, or native command path are changed.

## First checkpoint

- `segments.mjs`: canonical partition, static host-DOM clone/prune candidates,
  incremental interior replacement, endpoint-containing segment protection.
- `segments.test.mjs`: seven JSDOM structural/Range tests.
- `README.md`: boundary and integration notes.

From the repository root, run:

```sh
node --test apps/zenx/scripts/selection-segments-prototype/segments.test.mjs
```

The test resolves the existing installed JSDOM from the repository root.
No new dependency or browser is installed.
The tests pass. They do **not** measure Chromium layout, rendered Selection text,
Cocoa Select All/Copy, paint/highlights, Electron IPC, or actual control mount cost.

## What the mechanism establishes

Keep the first and last real rows and the visible/focused real rows mounted in
canonical order. Represent the remaining contiguous ranges as gap segments.
When the reading window changes, insert replacement interior segments, remove
superseded interior segments, and never move a retained DOM node. With native
Selection endpoints in permanent boundary rows, interior replacements preserve
both endpoint node identity and offsets in these DOM tests. No call rebuilds or
sets Selection during replacement. The native browser still must validate that
its rendered string and clipboard serialization remain unchanged.

If a narrowed selection endpoint enters a gap, keep that exact gap intact.
Trying to replace it throws before mutation. This avoids destroying a native
endpoint but is **not** yet a solution for interacting with a newly visible
control inside that pinned gap. This needs integration design, not a silent
selection rebuild or copy substitution.

## Projection candidates

1. **Host clone**: retain exact host markup/classes/text and clone into the gap.
   `cloneNode` does not mount React control state/effects/listeners. It remains
   O(total host elements) and O(total selected characters), so it is not bounded
   DOM. Producing this markup for never-mounted product rows is still unsolved.
2. **Pruned host**: remove SVG and text-empty buttons; keep text-bearing buttons
   and all text ancestors. Equal textContent is verified; exact native rendered
   text and clipboard are **not**. Changing even empty layout boxes can change
   browser boundary behavior. This candidate is not safe to enable yet.
3. **Flat gap text** (next fixture): one rendered pre-wrapped text node per gap,
   using a captured baseline native string solely to isolate boundary behavior.
   This is an oracle-driven experiment, not a proposed product serializer.

## Product constraints discovered

- TurnBlock includes input order, disclosure state, expanded trace/history,
  status/fallback/error text and final output; canonical body strings are not
  the full selected text contract.
- MessageActions adds time, cache, and fork-error labels. Opacity zero is not a
  reason to omit text. Text-bearing turn-toggle buttons must remain represented.
- Markdown code has language and Copy/Open-file header labels. GFM tables/lists,
  blockquotes, whitespace, reference capsules and current image/disclosure state
  add host-specific serialization. A generic Markdown-to-plain-text function is
  not an exact substitute.
- The installed Legend `useDOMOrder` sorts unknown direct children after real
  indexed containers and defers reordering during active Selection. A real
  integration needs an explicit segment ordering/freeze seam, not direct DOM
  insertion into today's unmodified Legend list.
- Ordinary editors must keep the existing ownership gate. The fixture checks
  unrelated editor focus/range retention, not Electron native menu routing.
- All text to be selected must exist in the document. A genuinely bounded number
  of nodes can still require O(total selected characters) memory and native
  serialization time. This prototype makes no constant-time claim.

## Required acceptance, unchanged

Use the existing product native menu handler → Cocoa chain, same state full DOM
reference, exact whole Selection string and exact native clipboard string.
Never trim, dedupe, normalize, remove status/time labels, or alter the existing
owned empty-composer-placeholder + LF contract. Exercise top/middle/bottom,
scroll while selected, repeated Select All, narrowing, cancel/editor focus,
sidebar/multiple transcript selection, anchor restoration, and visible native
highlights. If a presentation has no exact projection, preserve the existing
full-DOM path rather than silently changing text or order.
