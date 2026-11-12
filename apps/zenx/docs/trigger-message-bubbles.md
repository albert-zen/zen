# Trigger messages: same conversation grammar

This bounded change implements message presentation and source navigation, not trigger scheduling or the separate management-page redesign/debug experiment.

- Completed/admitted trigger input uses the existing inbound message row, source link, Markdown bubble and timestamp/copy action rail. No special 180-character excerpt or expand-to-read control.
- Registered trigger name is a historical display label from the known Host formatter. The source target is always canonical `sourceId`, never a name or ID parsed from prose. Duplicate names still open the exact definition.
- Only the exact formatter prefix, matching canonical Trigger ID and recognized ordered metadata fields are projected out. Full prompt and every following context block remain intact, including embedded delimiter-like text. Unknown/legacy/malformed envelopes fall back to the full original text. Ordinary copy matches this visible text; canonical/model input is untouched and remains available to existing raw history and the separate debug experiment.
- Source click opens the existing right-side Trigger panel, binds the message's owning Thread, and selects the exact definition. It does not navigate to the global manager, resume another Thread, or execute/edit the definition on behalf of the user. The normal form is opened for inspection; saving remains explicit. Missing or mismatched definitions show an error.
- Room companion and side-conversation origins pass their real source Thread to the scoped panel, while the outer conversation stays selected. Viewport changes retire the presentation request.
- Queued inputs, remote Fleet excerpts, other Host message kinds, and scheduling semantics are unchanged.

## Evidence boundaries

Tests use real Host wakeup formatting, production ThreadView, App, and TriggersPanel with synthetic data. The screenshot fixture uses actual ThreadView/TriggersPanel and styles, a synthetic in-memory source navigator, no Host, no scheduling, and no private profile/network. App navigation is separately covered by the mounted integration test. Screenshot acceptance is pending CI capture and pixel inspection; component/unit success alone is not visual or native Electron acceptance.
