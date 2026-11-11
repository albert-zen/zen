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

Default coverage is desktop light/dark (1280 × 900) and narrow light (760 × 900).
Pending additionally covers narrow dark and compact light/dark (390 × 900), all
with a fine pointer and hover. The 390px cases exercise the <=480px CSS rule;
760px is not a substitute, and none of these cases proves touch/coarse input.
The pending-only selection produces 18 PNGs; all three scenes produce 24.

Each pending image records actual row/body/action rectangles, body width ratio,
horizontal overflow, action line count, scroll offsets, rows geometrically inside
the tray, and per-control center hit tests. A row geometrically inside the tray
can still be partly occluded by a sticky header, so do not label that count as
fully readable without inspecting the PNG and hit tests. These are observations,
not minimum-density or design-quality assertions. The observer distinguishes
Queue rows from Steer rows, which share `.queue-row` but do not share a body or
action-group structure. Text and image-only Steer rows use their actual bubble or
image container; absent body/action measurements remain `null`. Unknown or
incomplete structures retain explicit observation warnings, not fabricated zero
measurements. Executed structural tests render production Queue and Steer
components, then run the same observation expression with explicitly synthetic
boxes. This catches DOM-shape errors but does not simulate browser geometry.
Compare matched viewports,
input media, text, state and focus targets. A wider action group can reduce action
wrapping while also narrowing message text; inspect both rather than approving
only the smaller action line count.

This is a layout feedback matrix, not an exhaustive journey or accessibility
suite. After choosing a change, run the affected focused interaction tests;
keep broader, native and integration acceptance separate before merge.

## Initial implementation measurement

On the development workspace with existing dependencies, all three bundles took
21.2 seconds total: main 11.4 s, pending 5.7 s, information 3.9 s. Three lightweight
infrastructure contract tests took 0.11 s. This measures build only, not capture,
remote dependency installation or runner queueing. Actual remote timings belong
to each run's receipts; a configured workflow alone is not screenshot evidence.

## Verified hosted run

The first independent run,
[42971059510](https://github.com/albert-zen/zen/actions/runs/42971059510), captured
15 PNGs from commit `9fdddf7ce8eae212938903bec78eaf371713b59d` (tree
`9141c42cd8194b5d141984c80fa8a737d5cecc96`). From job startup to artifact upload it
took **58.0 seconds**, including npm installation and CJK fonts. The renderer
build took **12.47 seconds** and capture **20.39 seconds**. This does not include
runner queue time and is a measured run, not a future SLA.

All 265 recorded project source hashes, three HTML hashes and 15 PNG hashes were
verified after download. There were no renderer exceptions or external requests;
the browser sandbox remained enabled. The initial run did not record pointer
media capabilities, so its hover images do not prove the fine-pointer CSS branch.
The follow-up capture explicitly emulates and asserts desktop pointer/hover
capabilities, records them per case, and requires the target to match `:hover`.
Native Tab already establishes and verifies `:focus-visible` before focus shots.
