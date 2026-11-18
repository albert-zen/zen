# Final combined native reading-flow validation

**Passed for the bounded flow below.** The parent operator used the actual Linux
Electron app on the final isolated integration build. This readback inspected all
eight original screenshots, the persisted receipts, and the source/build hashes;
it performed no UI actions and changed no integration files.

## Exact version and evidence

- Commit: `7c5813f474c3bace74fd30fed9fd0f0b75abe431`
- Tree: `4a24efab6c84e0880fe4214a295414979cc60438`
- Fresh synthetic profile: `live-native-final-integration` under the evidence root.
- [Manifest](final-integrated-native-manifest.json): eight original image hashes,
  dimensions, timestamps, observations, receipts and terminal-state references.
- Full inventory: `live-native-final-integration-fingerprints.json` under
  `/workspace/shared/ui-quality-evidence/`. Its file hash is recorded in the
  manifest; the inventory is referenced rather than duplicated here.
- All **640 production source files** match the recorded hashes and exact commit.
  Source fingerprint: `2a79663950fd2d0b1f132f3034d68bd8f4a48638c71ddf286f81869249b96664`.
- All **58 built JS/CSS/HTML files** match the recorded hashes.
  Build fingerprint: `d666eecdfc2fe45e1b4d87f9a28967ea8ac3d5f2302b759ca020b84dd92efd55`.
- All seven fixture files also match. The integration worktree remains clean.
- The lead reports GitHub still showed main `d7f93b83` and #748 `0d6a1066` unchanged;
  this documentation readback did not repeat that remote query.

## Observed sequence

The originals are in `final-integrated-native-captures/` under the evidence root.
All eight are **JPEG, 1188 × 848**, despite their `.png` names, and remain unchanged.
Times below are preserved file modification times in UTC, not instrumented click
or capture timestamps. The manifest separately records actual control receipts.

1. **01, 17:49:28:** live checkpoints **012–017** are visible; Stop is available
   and Back to live is absent.
2. **02, 17:49:52:** after operator-reported wheel scrolling, **Reading checkpoint
   28** is visible in both history messages, with Back to live above Composer.
3. **03, 17:50:18:** checkpoint **28** retains the same visible vertical placement
   while progress receipts have advanced through **30 and 40**.
4. **04, 17:50:54:** after the reported switch to Provider failure and return,
   checkpoint **28** and Back to live remain in place. Progress has reached **70**.
   The image shows the returned state, not the intervening Thread.
5. **05, 17:51:02:** collapsing the Sidebar preserves checkpoint **28** vertically
   while horizontally recentering the conversation.
6. **06, 17:51:15:** after the reported Back to live click, checkpoints **086–091**
   are visible and the jump control disappears.
7. **07, 17:51:23:** following continues to **094–099**, without the jump control.
8. **08, 17:51:34:** after explicit Stop, the UI reads **“Stopped Progress kept.”**
   and Composer returns to its idle action. The lead then closed the isolated host
   with Ctrl+C; that host shutdown is operator-reported.

## Persisted Stop result

The fixture records **`model_interrupted`**, not an event named `model_aborted`:
`17:51:24.396Z`, emitted **100**, “The operation was aborted.” The durable Trace
journal then records a cancelled model sample at `17:51:24.405Z`, retains partial
text containing **001–100**, and records `turn_aborted`, reason **“Interrupted by
user”**, created at `17:51:24.442Z` and observed at `17:51:24.505Z`. The current
summary is `idle` with `lastTurnEnd.status = aborted`. Exact identities, sequence
numbers and journal hashes are in the manifest. The semantic ItemList is not
misrepresented as a second control-state authority.

## Scope

This supplements [the integration verifier](fourth-scroll-integration.md) only for
live following, manual reading hold, Thread switch/return, Sidebar collapse,
Back to live and Stop on this exact combined build. Native actions belong to the
lead operator; the screenshots corroborate their resulting states. Visible
anchor stability is not a claim of measured DOM scroll offsets.

No native fullscreen/resource-tab hiding, OS fullscreen, hidden-window,
cross-platform, full aggregate, CI or release acceptance is claimed. Other
Fork/pending/caption flows were not repeated in these eight images. The provider
and history are controlled local synthetic data, not an online-provider test or
an OS sandbox. Original automated-test scope and earlier limitations remain
unchanged except for this explicitly bounded native addendum.
