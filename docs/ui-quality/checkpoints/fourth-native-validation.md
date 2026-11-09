# Fourth slice: final native pending and delivery validation

Five original native captures were inspected and fully decoded. They validate the
settled delivery-check feedback and pending-tray overflow cue in the normal ZenX
application built from production commit
`0a72293a9f60c2e48671da0dbd580fdfa7b01ac3`. Exact source, build, image and bounded
readback fingerprints are in
[fourth-native-manifest.json](fourth-native-manifest.json).

The captures use the fresh isolated `live-native-fourth` profile and the corrected
[portable QA fixture](../scripts/live-native/README.md). Canonical history,
protocol, renderer and local persistence are production code. The model and
pre-admission rejection are synthetic and local. The operator performed the native
input sequence; this documentation pass inspected the resulting images and
recorded data without launching the application or changing production code.

## Observed native results

1. **01, pending tray:** the native vertical thumb is visible before interacting
   with the tray. Two held steer messages sit above the three-message pending-send
   section in the same bounded container. Lower rows visibly extend beneath its
   edge. This capture does not independently demonstrate scrolling through every
   row; that interaction has separate
   [component-native evidence](fourth-presentation-validation.md).
2. **02, rejected request shown conservatively:** the local `QA_REJECT` copy says
   **Delivery not confirmed**, retains the warning that it may already have been
   accepted, and offers Check delivery. The injected error is known to the fixture
   to precede admission, but the native IPC presentation correctly retains
   uncertainty. No completed-check label is present yet.
3. **03, explicit check settles visibly:** after the operator's first Check
   delivery action, the row reads **Check completed. Delivery is still
   unconfirmed.** The recovery copy and its warning remain. This is the lasting
   captured difference that was absent from the earlier native review.
4. **04, repeat check preserves new input:** after typing **Keep this newer draft
   unsent.** and explicitly checking again, that draft remains in the editor. The
   original recovery row and qualified settled result remain. Readback below
   corroborates that no additional input was accepted or model sample started.
5. **05, navigation retires only check feedback:** after navigating to the pending
   thread and back to Admission and retry, the original uncertain copy and newer
   draft remain. The old completed-check label is gone; Check delivery is again
   available. This is mounted-view feedback, not a restart-persistent receipt.

All five `.png`-named originals contain **JPEG** bytes at **1188×848**. They were
preserved unchanged and hashed after full decode. Images show settled states;
click count, before-interaction ordering and the navigation sequence come from
the native operator's report, not an uninterrupted screen recording.

## Bounded readback

The synthetic controls and split journal were read after the native journey:

- `live-controls.jsonl` contains only `admission_waiting` at
  `2026-11-09T17:36:37.113Z` and `admission_rejected` at
  `2026-11-09T17:36:40.117Z`, both for the one `QA_REJECT` attempt. The rejection
  record says `committed: false`.
- The admission thread's native-period Trace has one send activation, one
  `zen/turn/send` request and its rejected completion. It has no added runtime
  Item or model sample. Read-only check clicks are not individually logged by
  these records.
- Its semantic ItemList still has only the seeded guide and response, plus their
  two context entries. All four precede the native launch. Neither the rejected
  client ID nor **Keep this newer draft unsent.** appears in that ItemList.
- Across all five seeded thread traces from `17:35:00Z` onward, there are no added
  runtime Items or model samples. The seed has 35 model-sample starts and 35
  finishes, with 33 latest completed Turn states and two aborted Turn states.
- The operator reports stopping the isolated application with Ctrl+C after
  capture, with no active generation left. The journal independently contains no
  unresolved recorded seed sample; it is not a process-liveness probe.

This supports **no additional recorded acceptance, resend or model run in this
bounded synthetic journey**. It does not make missing input a general proof of
non-delivery or turn fixture knowledge into renderer delivery authority. Raw
profiles, credential material, ItemLists and Trace payloads were not copied into
the repository; the manifest contains only scoped counts, identities and hashes.

## Exact source and build

The source snapshot reports a dirty worktree because its scope includes the
portable QA fixture. Independently comparing all **640 production source/package
entries** in that snapshot against commit `0a72293a` found no missing or changed
entry. The recorded combined source fingerprint is
`4c1541116dad4cef374805e02c4416aae62b9856c5048b5f245b6b82ccd42b2e`.

The protected `fourth-final-build.sha256`, recorded before native launch, names:

- Main `index.js`:
  `3c3927332a1352aa8d07b832bdd3c8a87742d7508278e4a3663e5ed059b7778f`.
- Renderer `index--4Kvjr_j.css`:
  `af2d130ca2d1c888aad6fe8350d5971d5c6fc653aef9af6506e7166236e8b24f`.
- Renderer `index-DKjf5wXV.js`:
  `d9314d2eb1421d7540cf619214f7819746822979376f7db870130e32733f5a69`.

All three hashes were checked against the actual artifacts at the start of this
documentation pass. The operator subsequently rebuilt for the separate sidebar
caption commit `58df4ea3`, replacing the output directory. That later build has its
own `sidebar-caption-build.sha256`; the current output directory is **not** claimed
to represent these five captures. The earlier `fourth-build-source.sha256` also
names a different renderer bundle and is not the final capture fingerprint.

## Independent review and limits

[Terra's report](../reviews/fourth-delivery-terra.md) is copied verbatim, preserving
both original findings and the independent rereview. The full-read/history-window
identity issue and overstated fixture isolation are marked **resolved within the
reviewed scope**. The rereview passed three focused App checks and twelve QA guard
checks. Native visual validation was explicitly outside that review; this document
adds only the five native observations above.

The following are **automated-only, not covered by these native captures**:
transient Checking delivery and its announcement, unavailable/failed reads,
same-frame activation fencing, equal/newer-watermark full-window reconciliation,
stale-thread/epoch and late-outcome races, and Chinese delivery labels. Automated
scope and the incomplete memory-heavy App run are recorded in
[fourth-delivery-validation.md](fourth-delivery-validation.md).

There is no screen-reader, measured-contrast, touch, reduced-motion, forced-colors,
dark-mode or narrow-window claim for this set. Local recovery copies remain
restart-volatile. The corrected model adapter emits text/usage only and rejects
shell/tool command forms, but does not globally isolate manual application,
plugin or OS actions. This is not a remote-provider reliability test or a full
product acceptance claim.
