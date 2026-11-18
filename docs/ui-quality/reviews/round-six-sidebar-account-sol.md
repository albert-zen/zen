# Round six independent review: Sidebar and Account

## Result

- **One actionable P2 in Sidebar commit `5413b8d948a272a3c99682ccb11689b807da0214`**: hovering a Room/PAW row after its management menu has opened creates a newer name-preview popover, so the first Escape fails to dismiss the still-focused management menu.
- **No actionable P1/P2 in the frozen Account change.** The independent full Settings interaction suite passed **158/158**.
- This is a code and synthetic interaction review. No real authentication, credential access, subscription-provider request, actual sign-in/sign-out, CUA, visual scoring, repository source edit, or commit was performed. No screenshots were supplied to this reviewer; native appearance and real pointer geometry remain unverified.

## P2: Room name preview can intercept management-menu Escape

**Location:** `apps/zenx/src/renderer/src/room-conversations.tsx:530–532,596–600,672–674` in `5413b8d948a272a3c99682ccb11689b807da0214`.

`ActionMenu.onOpen` calls `hideName`, but `showName` has no menu-open exclusion. A subsequent row pointer entry reopens the name Popover while the separate ActionMenu Popover still owns keyboard focus. Radix then dismisses only the topmost, newer name preview on Escape.

**Reproduction, synthetic and bounded:**

1. Render a Room row such as Design team.
2. Activate its Manage Design team / More button. Rename conversation is focused and the menu is present.
3. Move the pointer back over the same Room navigation button.
4. Press Escape while the menu item still owns focus.
5. The name preview closes, but the management menu remains open. A second Escape is needed.

**Observed:** `previewOpen: true`, `menuRemains: true`, focus `Rename conversation` after the first Escape. The independent assertion that one Escape closes the management menu failed. The same sequence against an outside-repository copy of the exact baseline `3a444ed1d946154bfe116fa556478c884e162797` passes. This is introduced by the name-preview slice, not an existing ActionMenu failure.

**Impact:** ordinary keyboard dismissal of the active management menu regresses after a normal pointer movement. This also means the supposedly retired name overlay can coexist with the open menu.

**Suggested fix:** prevent the name preview from opening while this row's management menu is open; preserve normal row hover/focus reopening after the menu closes. Add the hover-after-menu-open plus one-Escape sequence as a regression.

Independent probe: `/tmp/review-room-behavior.mts`.
Exact baseline module used by the probe: `/tmp/review-room-baseline.tsx`.
Command: `node --import tsx --test --test-name-pattern='review:' /tmp/review-room-behavior.mts`.
Result: **1 pass (baseline), 1 fail (new commit)**. The baseline helper's separate react-i18next import emits a missing-instance warning, but the tested menu handlers, focus and dismissal are active and the bounded menu assertion passes. This does not affect the failing production-module probe.

## Sidebar scope and non-findings

Compared all five files of immutable `5413b8d948a272a3c99682ccb11689b807da0214` to `3a444ed1d946154bfe116fa556478c884e162797`. Confirmed those five working-tree files were byte-identical to the reviewed commit when the ordinary tests ran.

- Project chevrons read the existing open/dragging state; no new disclosure, Project identity, sorting, drag, selection, or preference authority is introduced. The guide is CSS-only.
- Room full text stays exact in the row accessible name and preview. Grapheme splitting preserves combining marks and emoji sequences. Preview open/close remains renderer-local; no rename, navigation, read receipt, Thread, journal or Host mutation is added.
- Focus opens the name preview without navigating or stealing focus; Escape closes it and retains row focus. Rapid row changes and old close timers preserve the newer row preview. Tab to More retires the old preview. Opening the menu initially hides it, but the P2 above covers the missing ongoing exclusion.
- `aria-current`, unread badge count/bounds, Asking positive-count/revision projection and exact navigation route remain in the same logical row and unchanged authority paths.
- Project reorder, temporary drag collapse, saved expansion, row focus restoration, current selection and running/Pin state passed the focused regressions.

## Account scope and non-findings

Reviewed the uncommitted three-file diff against `5413b8d948a272a3c99682ccb11689b807da0214`, independently of implementation notes. Frozen files:

- `apps/zenx/src/renderer/src/SettingsView.tsx`: `0baff1981e4c1ededbda9238b0f8c99f208a75d74d7d10248ddb538579255255`
- `apps/zenx/src/renderer/src/i18n/settings.ts`: `2e260581815ecf3735313e9e997c428fdac9aea028e7fcd689de86c655f7a4e3`
- `apps/zenx/test/settings-interaction.test.ts`: `6b044095484ad614a916661e78b377d5be3450e77fecfd03a81a25dccfd1e2e2`

Relevant implementation locations: `SettingsView.tsx:197–265,623–629,1243–1351` and localized `settingsView.signingOut` in both languages.

- A synchronous operation ref blocks same-turn duplicate activation before React can publish disabled state. Sign-in and sign-out share the exclusion; failure unlocks for explicit retry, with no automatic retry.
- Ownership is published in a layout commit and includes API reference, subscription Provider, account ID and authenticated state. Retained handlers must match the committed token and current active Account view. A→B→A gets a new token, so old handlers do not revive.
- Accepted actions remain owned above Account's Activity and can complete across tab navigation / Settings hide. The completion path uses the existing `acceptHostSettings` and draft rebase, preserving unrelated General edits and newer input without navigating or stealing focus.
- Pending Sign out has native disabled, `aria-busy` and translated Signing out text. Errors are in Account's Activity, so they do not appear as General failures while hidden; returning to the same account exposes the failure.
- Provider/account/API replacement and root unmount retire late success/failure/finally effects. Newer owners are not overwritten or unlocked by the old operation.
- `expired` is deliberately not used as a logged-out predicate or ownership boundary. `authenticated: true` with an expired access token still offers Sign out; the synthetic identity regression covers this.
- The changed provider retry test repairs the pre-existing broad-toast expectation and adds independent proof of dirty General preservation and zero General saves. It is not treated as an auth lifecycle test.
- All added authority is ephemeral renderer ownership; the patch does not add Host protocol, credential, account storage, journal, persistent recovery, timeout or retry semantics.

## Exact checks run

1. Read `AGENTS.md`, relevant authority/Sidebar/Settings/interaction sections of `apps/zenx/docs/ui-ux.md`, `LESSONS.md`, the software-engineering skill, actual changed source and shared Popover/ActionMenu implementation. No checkout `.agents` or `.codex` skill files were present.
2. `git diff --stat 3a444ed1d946154bfe116fa556478c884e162797 5413b8d948a272a3c99682ccb11689b807da0214` and full five-file diff. `git diff 5413b8d... -- <the five files>` was empty.
3. Initial tsx CLI attempt failed before tests because its incidental `/tmp/tsx-1000/2.pipe` Unix IPC socket received sandbox EPERM. No permission escalation or network/auth workaround was used. The equivalent Node loader runner below does not need that CLI IPC socket.
4. `node --import tsx --test apps/zenx/test/room-conversations.test.ts apps/zenx/test/sidebar-ordering-interaction.test.ts apps/zenx/test/sidebar-question-attention.test.ts apps/zenx/test/sidebar-question-summary.test.ts apps/zenx/test/sidebar-presentation-interaction.test.ts` — **45/45 pass**, exit 0, 7.28 seconds. Two existing ThreadRow act warnings appeared in the pin reorder tests; no failed assertions.
5. Outside-repository targeted menu/Escape probe described above — baseline **pass**, reviewed new source **fail**. No repository files modified.
6. `node --import tsx --test apps/zenx/test/settings-interaction.test.ts` — **158/158 pass**, exit 0, 191.07 seconds. The seven Account tests use explicitly settled synthetic replies. Existing suite profile persistence tests use temporary local directories; no actual auth flow ran.
7. SHA-256 was captured before Account review and rechecked after source inspection; exact values are recorded above.

No independent aggregate check, build, TypeScript run, native-app screenshot review, or platform accessibility-tree/assistive-technology test was run by this reviewer. Those are not claimed as passed. The P2 was reported to the lead immediately and to the Sidebar implementation worker with the probe paths; remediation/retest is a separate later source snapshot.

## Independent follow-up review (Sol)

**Verdict: the reported P2 is fixed in the exact frozen bytes below. No new actionable P1/P2 found in this bounded two-file change.**

Compared to committed `e75a1db1a3457057a23b40a0bf1e8ae6a9feceab`. Reviewed `room-conversations.tsx:530–540` and the new same-row/sibling regression. `showName` clears its temporary close timer, checks the current Room navigation's existing expanded management trigger, and returns without opening a competing Popover. After ActionMenu closes, its existing `aria-expanded` changes back, so future focus/hover can open the preview normally. No independent menu state, persistent/domain authority, shared controls or CSS changes are introduced.

Checks run by this reviewer, with exact hashes captured before and after:

1. `node --import tsx --test --test-name-pattern='review:' /tmp/review-room-behavior.mts` — **2/2 pass**, exit 0. The independently reproduced regression now reports `previewOpen=false`, `menuRemains=false` after the first Escape. The same exact-baseline comparison remains green. The outside-repository baseline helper emits its previously documented react-i18next-instance warning; production-module interaction assertions pass.
2. `node --import tsx --test --test-name-pattern='long Room names|Room name edges|Room management owns' apps/zenx/test/room-conversations.test.ts` — **3/3 pass**, exit 0, 4.02 seconds. Covers exact Unicode text, keyboard inspection/Escape, rapid preview ownership, menu opening, same/sibling hover suppression, retained Rename focus, one-Escape menu dismissal, More focus return and preview recovery after dismissal.

Frozen source SHA-256:

- `apps/zenx/src/renderer/src/room-conversations.tsx`: `50e3ecf9eea99a5aac4c91d02a45d42ed78f5ea5d5495b559a86b534de73e29a`
- `apps/zenx/test/room-conversations.test.ts`: `6d7a7b2cc19ceb3bc5ce8483d4d4af895fcec324877539d3d7f1a06cb3dc2083`

No repository edits, commit, CUA, real auth, broad Settings rerun, new TypeScript/build process or visual score by this reviewer. Native-app geometry and visual acceptance remain outside this bounded review.
