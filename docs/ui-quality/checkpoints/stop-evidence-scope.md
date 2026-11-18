# Final Stop verification: explicit evidence boundary

This clarification accompanies the unchanged, frozen native validation report,
manifest and field-only assertion summary for combined source
`bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`.

The native operator clarified from existing records, without another UI action:

- Checkpoints 71 and 87 were visible streamed text in the main conversation
  before Stop, not text inside the Activity disclosure.
- `final-live-stopped.jpg` shows Stopped, the “Progress kept” label, collapsed
  Activity and an idle composer. It does not show the streamed text after Stop.
  Activity was not expanded during this final check.
- The local model receipt `model_interrupted` after 88 chunks proves generation
  was interrupted. The persisted Trace event `turn_aborted` proves the interruption
  event was recorded. Neither establishes that all 88 text chunks were persisted.

**Verified:** live follow, held reading position during new generation, thread
return, sidebar collapse, resumed follow, stopping, and interruption recording.

**Not verified:** post-stop text visibility, complete streamed-text retention,
content revealed by expanding Activity, or text recovery after restart. The
“Progress kept” product label alone is not evidence for those properties. This
is a coverage limit, not a reproduced content-loss defect.

No screenshot pixels or earlier source manifest were changed. Read this
clarification together with `settings-native-validation.md`, the final Sol visual
review and `settings-native-manifest.json`. Earlier shorthand saying “Stop
preserved progress” should be read as the visible status label, not as a completed
persistence acceptance test.
