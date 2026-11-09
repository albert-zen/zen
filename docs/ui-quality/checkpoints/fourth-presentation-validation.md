# Fourth presentation slice: native verification

Status: the scoped pending-tray overflow cue and running-send panel presentation
were verified in eight native Electron component captures on November 9, 2026.
All original images and four launcher measurement files were inspected. The
exact source, HTML, image and telemetry hashes are in
[pending-readability-native-manifest.json](pending-readability-native-manifest.json).

## Observed results

- **01–02, pending overflow:** the native thin thumb is visible before interacting.
  The single tray contains two held steer inputs above three queued inputs. Native
  wheel scrolling changes `scrollTop` from 0 to 83 and exposes all three queued
  rows and their existing controls. Measured tray client/content heights are
  238/321px; no second pending-list scroll region was added.
- **03–05, desktop send controls:** all five choices, descriptions, actual
  Enter/Ctrl+Enter hints and footer Select remain legible in a contained 380×452px
  panel. After fixture focus setup, native Escape then Arrow Up reopen it. Five
  native Tabs reach the Select; opening it and using Arrow Up/Enter changes Next
  turn to Steer now. The fixture reports “Preference: soft; no send”, and the draft
  remains. Native Escape closes the panel and leaves visible focus on the orb.
- **06, narrow Chinese/dark:** the actual iframe viewport is 390×680 CSS pixels.
  The 366×505px panel, all five choices and the 44px footer control fit. The same
  unchanged production bundle runs inside the iframe; this is not full-app mobile
  or narrow OS-window acceptance.
- **07–08, native 200% zoom:** Electron reports zoom factor 2 and a 590×406 CSS
  viewport. The panel stays inside it at x=182, y=10, width=380, height≈331px.
  The body has 261px visible height and 384px content height. Footer focus is
  visible at body scroll offset 123; four native Shift+Tabs reach the first
  alternative and return the body to offset 0. Local clipping of other choices
  is expected while scrolling; the two images establish access to both ends.

All recorded open-panel samples report containment, and all recorded samples
report no page-level horizontal overflow. These are geometry observations, not
formal contrast or assistive-technology compliance findings. Image 08 visibly
shows first-option focus; its generic telemetry `focused` field is null because
that button lacks a class/ARIA label used by the fixture's compact focus reporter.

## Evidence boundary

The captures render real production `ThreadView`, `ComposerSendControl`, pending
components and shared CSS in native Electron. Canonical history, the surrounding
QA header, fixed clock, initial focus setup and callbacks are synthetic. There is
no real Host, provider, durable mutation, private history or delivery assertion.
Native input sequences above come from the operator report, with screenshots and
telemetry corroborating the resulting states. Programmatic fixture setup alone
is not claimed as trusted native keyboard input.

The window manager overrode the requested 1188×848 size. Actual outer/content
bounds and screenshot bounds are **1180×812**. All eight `.png`-named originals
are verified **JPEG** bytes and remain unchanged. The optional 390×300 iframe at
200% (`narrow-zoom200`) was **not run**. Screen readers, touch hardware, native
forced colors/reduced motion and formal contrast measurement were not tested.

The frozen bundle was built from `a7c36125a85f48c0d84b9783e1038893a05b2ff2`
plus working-tree changes, before the later App full-recovery callback fix. The
captured presentation CSS still matches:

- `ComposerSendControl.css`:
  `7ebf25135317403431c026c934d58a6d74fe57a7413e20916c42882e7e4b8e29`
- `queued-messages.css`:
  `0f726a271a5cad5f27ddb223448eb7a594ee2453e22bc70cedbbed2813db988f`

This is not verification of final App recovery behavior or a final clean commit.
The component preparation passed six EN/ZH content/focus cases. Earlier scoped
regression runs passed 134 and 28 tests respectively, with overlap; those counts
are not a unique aggregate or a repository-wide pass.

## Reproduction

The portable [source package](../scripts/pending-readability/README.md) accepts an
explicit repository, new output directory and existing Electron executable.
Its builder does not start an app; read-only launch preflight checks artifact
hashes. Native launch measures actual bounds and zoom. Generated HTML,
dependencies, profiles and captures remain outside the repository. A new build
records its own source hashes and must not be mislabeled as the historical bundle
reviewed here.

The portable package's fresh-output build passed all six functional cases.
Read-only launch preflight verified all three HTML hashes, JavaScript/shell syntax
checks passed, and rebuilding into the existing output correctly failed before
altering its HTML. No app was launched during these reproducibility checks.
