# Process summaries and compaction views

This source-bound synthetic preview renders production `ThreadView`, its actual
trace groups, and the actual compaction/original-history components. It does not
contact a Host, provider, user profile, or external service. History replies are
synthetic and enforce the fixture's exact Thread/cutoff.

From the repository root:

```sh
node apps/zenx/scripts/build-process-compaction-preview.mjs /tmp/zen-process-compaction-preview
node apps/zenx/scripts/capture-process-compaction-preview.mjs /tmp/zen-process-compaction-preview
```

The self-contained `process-compaction.html` accepts `lang=en|zh-CN` and
`theme=light|dark`. `source.json` pins the commit, changed production-source hashes,
and final HTML hash. Capture verifies those bindings, then checks the real DOM
and keyboard interaction at 1100px and 390px in both languages/themes. Screenshots
cover collapsed, retained context, original history and diagnostics states.
`evidence.json` records the resulting semantic labels, containment and transitions.
The preview uses already-installed Chromium; no browser or font is downloaded.

The compact row has exactly one button. Expanding gives three peer views; history
reads begin only on the Original history tab. Switching away discards pending UI
reads. Diagnostics retains the exact model-message snapshot, original locator and
canonical compaction record. Full history paging, chunking, retry, disabled/legacy
references, stale completion and navigation are covered in
`original-history-ui.test.ts` and `compaction-views.test.ts`.
