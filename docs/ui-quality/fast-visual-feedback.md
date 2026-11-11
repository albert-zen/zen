# Fast visual feedback, separate from acceptance

Do not wait for the aggregate CI run to inspect a UI change. The independent
**Main UI preview (fast visual feedback)** workflow produces actual Chromium PNGs
from three production-renderer fixtures:

- `main`: production App, Sidebar and ThreadView, opened with pointer input.
- `pending`: production Sidebar, ThreadView and expanded unified pending shelf.
- `information`: production editable information panel and cards, in an explicitly
  synthetic outer chat scaffold. This is not a full-App navigation assertion.

All bridge responses, conversations and files are synthetic. No user profile,
credentials, live Host, model request or native desktop operation is used. Do not
call these screenshots native Electron or full application acceptance.

## Inner loop

With existing repository dependencies, build only the surface being edited:

```sh
node apps/zenx/scripts/build-main-ui-preview.mjs /tmp/zenx-preview pending
# Select main, pending, information, or all.
```

Open its self-contained HTML in an authorized browser. A denied local browser or
socket operation is a boundary, not a reason to disable the sandbox or spoof
`GITHUB_ACTIONS`. The automated capture intentionally runs only in Actions:

```sh
node apps/zenx/scripts/capture-main-ui-preview.mjs /tmp/zenx-preview
```

PR source changes trigger the standalone workflow immediately. It does not wait
for static checks, native builds, packaging, or aggregate tests. Manual workflow
runs can select one scene. Latest runs supersede older runs on the same ref.
Existing runner Chrome keeps its sandbox; the runner installs only repository
npm dependencies and, if absent, official Ubuntu CJK fonts. The whole job has a
six-minute ceiling, with a two-minute capture ceiling. These are stop limits,
not measured performance promises. Queueing and dependency installation remain
part of remote wall time.

`source.json` records the exact commit/tree, worktree changes, bundled project
source hashes, lockfile hash and each HTML hash. `evidence.json` records viewport,
scene URL, geometry, actual visible text, PNG hashes, Chrome version, renderer
errors and build/capture timings. Dirty local builds are explicitly identified,
not mislabeled as committed evidence. Capture refuses source or bundle drift.
Artifacts retain PNG, HTML and bounded diagnostics for seven days.

Default coverage is desktop light/dark (1280 × 900) and narrow (760 × 900).
This is a layout feedback matrix, not an exhaustive journey or accessibility
suite. After choosing a change, run the affected focused interaction tests;
keep broader, native and integration acceptance separate before merge.

## Initial implementation measurement

On the development workspace with existing dependencies, all three bundles took
21.2 seconds total: main 11.4 s, pending 5.7 s, information 3.9 s. Three lightweight
infrastructure contract tests took 0.11 s. This measures build only, not capture,
remote dependency installation or runner queueing. Actual remote timings belong
to each run's receipts; a configured workflow alone is not screenshot evidence.
