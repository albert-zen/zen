# Native Agent / Information journey

## Scope and build

Ten actual native Electron captures were visually inspected, together with
one separately retained diagnostic frame. The normal app used an isolated profile,
unmodified local FakeModel, real installed bundled Subagents plugin, native child
Threads, and canonical Agent communication. There was no DOM-injected card or
fabricated transcript. The task text and deterministic model output are synthetic;
this is not evidence of autonomous research or an external provider run.

The captured build was based on
`a7c36125a85f48c0d84b9783e1038893a05b2ff2` plus uncommitted fourth-slice changes.
The recorded build hashes precede the later full-recovery callback fix. This
checkpoint does **not** validate that later fix, identify a final commit SHA, or
claim a clean source tree. The exact recorded main/renderer hashes are in
`agent-information-native-manifest.json`.

All ten acceptance images are **1188 × 848**. Their bytes are JPEG despite their
`.png` filenames; they were inspected as stored, without transcoding. The narrow
case is a roughly **416px main-conversation allocation in a split workspace**,
not a narrow OS window or a mobile-size claim.

## Observed journey

1. `01-native-information-hidden.png`: the parent is selected. Information mounts
   the real Subagents lineage card, showing the native child as Idle and Hidden.
   Show archived is unchecked. There is no child in Projects or Recent.
2. `02-sidebar-child-shown.png`: after pointer activation, the control reads Shown
   and the same child appears in Projects and Recent. The parent remains selected.
3. `03-keyboard-hidden-focused.png`: Space turns the control back to Hidden,
   removes those child entries, and leaves a visible focus outline on the switch.
4. `04-child-native-companion.png`: the child row opens the normal companion tab
   beside the still-selected parent. Its actual `zenx_subagents_send` input and
   Exit code 0 result are visible.
5. `05-canonical-sender-link.png`: the parent's received synthetic report displays
   the normal **From QA reviewer · native child** source link. This is native
   Agent-message provenance, not a link parsed from the report's body.
6. `06-source-opens-child.png`: activating the source link selects that same child
   as the main conversation. Its ancestor breadcrumb and send history are visible.
   This verifies Thread navigation, not exact tool-Item scrolling or highlighting.
7. `07-child-no-parent-card.png`: the child's Information panel shows its empty
   information state, without leaking the parent's lineage card.
8. `08-archived-lineage-visible.png`: back on the parent, explicitly selecting Show
   archived reveals the archived sibling with Archived status. Opening the archived
   conversation was not part of this capture sequence.
9. `09-narrow-allocation-popover.png`: with the normal workspace open beside the
   parent, Information uses a popover within the narrower conversation allocation.
   The child control and archived checkbox remain visible and usable.
10. `10-escape-restores-toggle-focus.png`: Escape dismisses the popover and visible
    focus returns to the Information toggle. The parent and workspace remain in
    place.

The interaction sequence is from the native operator's report. The named visible
states were independently checked in all ten capture files. The app was closed
with Ctrl+C after the run.

## Authenticity and receipts

The seed's real production path is:

`AgentRuntime → ZenXHostToolBundle / model facade → installed ZenXCapabilityService
→ bundled ZenXSubagentsCapabilityPackage → loopback ZenXProtocolClient → Core`.

The seed-only capability transport forwards production HostToolBundle messages
in-process; it does not pretend to test Electron IPC. The later native operator
journey uses the ordinary built app and its normal renderer/plugin path.

Synthetic exact identities are retained in the manifest:

- Parent: `73fa35a2-4eb5-4158-bb1c-19799644d031`.
- Fresh child: `bab7f001-b808-4653-bee6-7dbb56b6f84c`.
- Archived fork: `8157ec45-0f1d-4e6f-8cd2-91aac0621cef`.
- Received message: `a4bd2097-71b1-49cd-82c7-0f1a51589afa`.
- Sender's canonical send tool Item: `b4bcc852-fdbf-42ff-904a-290c6e8dcdf7`.

Two real create calls and one real send returned Exit code 0. The received message
points to that exact sender tool Item. A fresh host and installed-plugin reopen
restored both descendants, the archived state, and the received message. The
reproducible seed and launcher are in `../scripts/agent-information/`; no raw
profile, package generation, Item log or Trace is included in this checkpoint.

The lineage provider and switch come from `ConversationInformationCards.tsx` and
`subagents-ui.tsx`; durable visibility uses
`ZenXSettingsService.setSubagentThreadSidebarVisible`. Canonical sender navigation
comes from `ThreadView.tsx` and `message-source-navigation.tsx`. This checkout's
production creation API is `zenx_subagents_create`, not `agent_spawn`.

## Retained anomaly, excluded from acceptance

`diagnostic-black-frame.png` shows a blank dark client area with window controls.
The native operator observed it on the first attempt after closing a child tab,
hiding the workspace, and scrolling. No corresponding log error was reported.
After restarting only the isolated QA app, the later workspace-close operation
succeeded and the recorded journey continued.

The cause is **unknown**. The frame remains in the manifest's diagnostics section,
not its acceptance images. This is neither a claimed regression nor proof of a
harmless capture artifact. Reproduction and diagnosis remain separate work.

## Verification and remaining limits

- Preparation: 48/48 focused Subagents capability/UI, source-navigation and
  Information-layout tests passed.
- Sidebar persistence: 4/4 focused settings tests passed, including concurrent
  writes, failed-write preservation and invalid inputs.
- Seed assertions and close/reopen checks passed; native-launch preflight passed.
- The copied portable seed was rerun in a second fresh root: all eight assertions
  passed, launch preflight passed, and an existing-root attempt was refused.
- Shell/JavaScript syntax, scoped formatting, diff checks, and all 11 recorded
  image hashes passed. No existing profile was modified by documentation work.
- The native capture sequence covers the ten states above. It does not cover live
  external model behavior, a running child, plugin-disable failure, archived-child
  opening, true narrow-window rendering, or the later callback fix.
- These are scoped journey results, not a full application, accessibility, platform
  or regression-suite acceptance claim.
