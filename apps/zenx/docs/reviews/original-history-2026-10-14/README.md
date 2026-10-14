# Original history after compaction

The compaction event exposes its enabled logical reference through an inline public Item reader. The reader preserves the exact cutoff, pages at most 50 previews, and reads complete original public JSON in explicit chunks. It does not create or link a second history file.

These screenshots use the checked-in synthetic `original-history-visual.tsx` fixture and the actual ThreadView conversation and renderer components in the cloud browser. They contain no user history. The fixture supports a 420px narrow component container, not a native mobile app.

Messages and tool output are readable by default. The logical locator and canonical public JSON remain available through explicit disclosure controls, without exposing raw IDs in ordinary rows.

- [Conversation entry](entry.png)
- [Expanded readable history](wide.png)

The expanded capture is vertically cropped. The current narrow screenshot could not be completed because the cloud browser began timing out on CDP operations; an obsolete standalone-card capture is deliberately not included.

Automated tests cover the model-to-native-protocol tool path, exact public tool-result reconstruction, opaque data exclusion, pagination, invalid boundaries/cursors, repeated compaction, fork, journal reload, GUI close/retry and stale navigation.
