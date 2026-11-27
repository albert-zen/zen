# Delivered message source navigation

Post-merge visual verification of [#761](https://github.com/albert-zen/zen/pull/761), main `9e65c3493b668e25d34c3942974716b7360b2e7e` (renderer tree `4fbbd32831037b11e0a9fb418d54fd2badccfcf9`). Offline Chromium 131 on cloud Linux, 1280×850 light originals. The real ZenX App renderer and message source router were used; the preload bridge and message data were synthetic. These compare interaction states of the same build, not versions. No native window, real Host transport, personal information, or runtime logs.

1. [Tab to From Planning assistant](01-keyboard-source.png) in the transcript of Release checks. The synthetic unsent draft is already present.
2. [Press Enter to open Planning assistant](02-opened-source.png). Its own transcript is shown and its composer is empty.
3. [Return via the Release checks sidebar row](03-returned-with-draft.png). The original composer keeps its unsent draft.
4. [Separate run with a rejected source read](04-source-unavailable.png). The current conversation and draft stay in place; focus remains on the source button and the status is linked to it for assistive technology.

Repeated the successful path by mouse at 1024×850 dark. Each path made one synthetic source read and no send or fork requests. The received message in this fixture contains conversation provenance but no canonical originating message anchor: this proves opening the named conversation, not jumping to an individual message across a long history.

Reference: [Mattermost forwards and previews](https://docs.mattermost.com/end-user-guide/collaborate/forward-messages) and its [official static preview](https://docs.mattermost.com/assets/images/permalink-previews-9961a5813ef171374c4b5f825a1f169b.png); [message permalinks](https://docs.mattermost.com/end-user-guide/collaborate/share-links#deep-links) document a related, message-level target. This is product documentation, not an independently operated same-state benchmark. No historical Zen baseline or comparable score in this pack.
