# Native Subagent sidebar caption validation

## Scope and provenance

This checkpoint covers the display-only sidebar scope caption at source commit
`58df4ea3852e4826d3aa31a931c3383258bc0c47`. The five source/test/design file hashes
in `sidebar-caption-native-manifest.json` were checked after capture and still
match the production freeze. Documentation files are a separate checkpoint;
this is not a blanket clean-tree claim.

The caption adds one localized **Sidebar / 侧栏** label above the child switches,
only when actual child rows and the trusted sidebar context exist. It does not
occupy child-title/status row width or widen the switches. It uses shared muted
text and caption-size tokens. Existing switch labels/tooltips, profile mutation,
synchronous in-flight fence, focus, exact navigation and archive behavior were
not edited. No runtime, authority or permission semantics were added.

The normal native Electron app used the existing isolated Agent / Information
synthetic profile, unmodified local FakeModel and real bundled Subagents plugin.
The data/tasks and deterministic output are synthetic. There was no injected
renderer card or fabricated screenshot. This is not an external-provider or
autonomous-research result. The earlier seed/journey context remains separately
documented in `native-agent-information.md` and `../scripts/agent-information/`.

## Exact build

The parent operator completed `npm run build:prepared --workspace @zen/zenx` and
launched that output. The saved log independently shows successful main, preload
and renderer production builds. All three fingerprints were checked against the
current files after capture:

| Artifact                                           | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/zenx/out/main/index.js`                      | `3c3927332a1352aa8d07b832bdd3c8a87742d7508278e4a3663e5ed059b7778f` |
| `apps/zenx/out/renderer/assets/index-BqwwMrta.js`  | `dac0e998f84a9e60ad1d8db112be4cedef3376e0d08d64582d87ee7440ecaa45` |
| `apps/zenx/out/renderer/assets/index-D6yBphsh.css` | `2eb3e067ad842c043ff92e27073df53c67d44ed06e37c62b30914add1a6f3195` |

Evidence root: `/workspace/shared/ui-quality-evidence`.

- Build record: `sidebar-caption-build.sha256`, SHA-256
  `7dc16472cd85cf4a5336483115f6512526d05610918d3945558f5fcec8208b56`.
- Build log: `build-sidebar-caption-final.log`, SHA-256
  `450358905012c4cd271ca98e4a0677d344a01e1b1ac870410f064c5d2cf7c8b4`.

This build replaced the output directory used for the earlier fourth-native
capture sequence. The fourth-build images and fingerprints remain historical
evidence in their own checkpoint. Neither their native results nor their bundle
hashes are relabeled as this caption-build run.

## Original captures and observed states

All four originals under `sidebar-caption-captures/` were visually inspected and
fully decoded. Each is **1188 × 848**, with actual **JPEG encoding despite its
`.png` filename**. Bytes were retained unchanged. Exact file sizes and SHA-256
hashes are in the adjacent manifest.

1. **01-split-sidebar-caption.png:** The parent remains selected with the ordinary
   workspace open alongside it. The Information popover shows one **Sidebar**
   caption directly above **Hidden**. The complete child title and **Idle** status
   remain visible. The child is absent from Projects and Recent; Show archived is
   unchecked. The visible main allocation runs approximately from x=264 to x=680,
   or **416px**. This is a split allocation, not a narrow OS-window claim.
2. **02-split-shown-sidebar-child.png:** The caption remains above **Shown**. The
   child appears in Projects and Recent while the parent stays selected and the
   main conversation title is unchanged. The operator reports that a pointer
   activation produced this state.
3. **03-docked-sidebar-caption.png:** With the workspace hidden, Information is
   docked at the right. The visible card spans approximately x=836 to x=1176,
   consistent with the **340px** dock. **Sidebar** remains above **Hidden**; the
   complete child title, Idle status and unchecked archive control remain
   visible. The child is absent from Projects and Recent.
4. **04-chinese-sidebar-caption.png:** The same dock now shows **侧栏** above
   **已隐藏**, distinct from the card-level **隐藏** action. The child title stays
   complete, its status reads **空闲**, and **显示已归档** is unchecked. The parent
   remains selected.

There is no visible overlap or truncation of the scope caption, child title,
status or visibility control in these four captures. These observations do not
declare a quality score or replace independent visual review.

Between 02 and 03, the native operator reports using Space to turn the switch
off, Escape to dismiss the popover, hiding the workspace and reopening
Information. Before 04, the operator changed language through Settings General
and returned to the parent. The stable screenshots corroborate the resulting
states; this set does not separately capture the individual keystrokes,
transient focus, or Settings interaction. The operator reports stopping the
isolated app with Ctrl+C after the run.

## Automated verification

- **50/50 focused tests passed**, exit 0:
  `node --import tsx --test apps/zenx/test/subagents-ui.test.ts apps/zenx/test/sidebar-responsive-style.test.ts apps/zenx/test/plugin-information-layout.test.ts`.
- **138/138 sidebar tests passed across 20 selected files**, exit 0:
  `node --import tsx --test --test-concurrency=4 apps/zenx/test/sidebar-*.test.ts apps/zenx/test/sidebar-*.test.mjs apps/zenx/test/thread-sidebar-state.test.ts apps/zenx/test/trigger-sidebar-projection.test.ts`.
  The responsive suite appears in both selections, so those counts are not
  disjoint. Saved output: `sidebar-caption-regression.tap`, SHA-256
  `e1e4921287de9c17f9eb7a1a5a194dac2bc6b19812aa7c1b9caeca6ab95f4b0c`.
- **Node and web TypeScript checks passed**, exit 0:
  `npm run typecheck:prepared --workspace @zen/zenx`.
- Scoped source Prettier and `git diff --check` passed.

The three new tests verify the single visible EN/ZH scope caption, preserved
accessible switch names/tooltips/states, actual children without an empty-state
mismatch, absence for empty or unrelated rows, explicit archived-row reveal/hide,
and no caption when trusted sidebar context is absent. Existing tests retain
focus/retry, synchronous duplicate-request suppression, model-setting retention,
exact child navigation and independent sibling/nested/archive behavior.

The first test launch through the tsx CLI stopped before tests because the
sandbox rejects its temporary IPC listener (`EPERM`). The same tests passed
through `node --import tsx --test`, which does not start that CLI IPC server.
No escalation was used. Focused/typecheck/format outputs were returned by the
execution tool; only the sidebar suite output was separately saved as a log.

## Boundaries

- Independent Sol review remains separate; no score or finding-resolution claim
  is made here.
- This final native set covers light-mode English split/docked states and a
  Chinese dock. It does not add native dark-mode, coarse-pointer, running-child,
  failure/retry, archive-reveal or child-navigation coverage.
- Existing scoped source tests are not a full accessibility/platform review or
  a full repository aggregate. No repository-wide aggregate was run by this
  worker for the caption slice.
- No production source edits or additional commits were made while preparing
  this checkpoint. Native operations were performed by the parent operator;
  this worker inspected images, verified bytes/builds and documented results.
