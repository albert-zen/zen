# Reading-state behavior and source comparison

Checked 2026-10-12 while correcting #267 and #280. These are design inputs, not claims that another product's defaults are right for ZenX.

## Primary-source findings

- [T3 Code's current MessagesTimeline](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/MessagesTimeline.tsx) keeps disclosure/position state under a thread-specific list identity, including when the list stays mounted. Its `liveFollowEnabled` gate explicitly prevents near-bottom proximity from re-pinning a history reader. It disables end-follow while restoring a non-end position or settling a disclosure. Its active-run smooth-follow choice also considers reduced motion. ZenX uses the same separation between remembered reading intent and physical distance from the bottom, without adopting that virtualizer.
- [T3 Code's merged restoration change #145](https://github.com/pingdotgg/t3code/pull/145) treats stable row identities, image-preview continuity and Composer measurement as part of scroll correctness. That supports preventing an absent-image interval rather than compensating with a delayed bottom jump.
- [assistant-ui's viewport implementation](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts) distinguishes pending navigation/initialization scroll, live-follow and reader anchors. It cancels pending work on gestures and clears thread-specific anchors on thread changes. Its late-media/prepend handling tracks a visible message rather than confusing content growth with user movement. Explicit bottom requests remain a distinct action. ZenX similarly treats selection, keyboard, wheel and disclosure inspection as reader intent. We do not adopt automatic thread-switch/run-start bottom resets for previously visited threads.
- [use-stick-to-bottom's implementation](https://github.com/stackblitz-labs/use-stick-to-bottom/blob/main/src/useStickToBottom.ts) separates user escape, near-bottom geometry, programmatic scroll events and ResizeObserver deltas. Upward wheel intent is recorded before competing scroll updates can consume it. It offers a cancellable spring animation for streaming growth. Its shrink/near-bottom re-arming policy is deliberately **not** copied: that would contradict the reported idle-snap requirement. No third-party scrolling dependency or new animation loop is introduced here.

## Applied ZenX contract

1. A new thread can open at its live edge. Returning to a visited thread restores that exact thread's reading position and disclosure choices. Cached same-DOM navigation and loading/Settings remounts must both work.
2. Initial or destination-thread Composer geometry is published before restoration. A layout event cannot independently start following.
3. Native image references are projected synchronously from the exact canonical Items already provided to the renderer. Host and renderer share the same pure projection. Existing fixed-size thumbnails/placeholders remain mounted while payload reads or redundant Host media refreshes are pending. Bytes, authorization and payload validation still belong to the existing Host API.
4. Canonical replacement/deletion removes obsolete references synchronously. No second attachment cache, timer-based restore, cross-thread reference merge or durable reading state is added. Legacy callers without canonical Items keep their existing supplied projection.
5. Manual reading intent takes precedence over subsequent content/media changes. New gestures replace the saved position. Late results from a previously selected thread cannot move the current reader. Back to live is the explicit opt-in to follow again.
6. Streaming growth follows only while follow intent remains active. Stream completion does not re-enable it, and selection/focus protection around terminal trace folding remains covered. Idle media/layout changes do not imply a new message.

## Evidence boundary

Regression tests cover actual App cached navigation, asynchronous attachment refresh, newer manual input, navigation away, canonical edits/deletion and reused Item IDs. Browser replay uses synthetic production components with native input and delayed image payloads. It is not an installed-Electron or arbitrary touchpad-hardware validation. Smooth spring animation and virtualized message anchoring are separate possible designs, not changes justified by this bug fix.
