# Computer inspection and scrolling follow-up (Refs #484)

This is source analysis and synthetic-fixture work, not a reproduction of the reported WeCom incident. No user desktop, real WeCom session, original report artifacts, or operating-system permissions were accessed.

## Bounded defect: value-only static text loses its display label

`MAC_ACCESSIBILITY_SOURCE.displayLabel` previously queried only AXTitle, AXDescription, AXHelp and AXIdentifier. A node with AXRole=AXStaticText and AXValue="群聊消息 中文", but none of those four labels, therefore produced an empty title and entered `fallbackControls` rather than `semanticControls`. It can lose the native 120-control selection priority even when its text was supplied by the application. This does not establish that WeCom exposes its missing rows in this form.

Apple's [NSAccessibilityStaticText.accessibilityValue](<https://developer.apple.com/documentation/appkit/nsaccessibilitystatictext/accessibilityvalue()>) defines that value as the displayed text. [NSAccessibilityProtocol.accessibilityValue](https://developer.apple.com/documentation/appkit/nsaccessibility-c.protocol/accessibilityvalue) also distinguishes static string values from numeric role values.

The patch adds only an AXStaticText string-value fallback after the existing label order. Existing nonempty labels retain precedence. It does not read editable/secure-field values, synthesize actions, add a value to identity selectors, join child labels into rows, introduce OCR, or change capture budgets. Existing observation-page limits still apply. Static text may naturally contain private text already visible in the explicitly selected window; this is inspection content, not a promise to redact visible text.

`computer-static-text-label.test.ts` extracts the shipped Swift function and compiles it against synthetic attributes, including Chinese text, empty/missing/non-string values, editable/secure fields, and existing-label precedence. It uses Foundation only: no AX connection, AppKit application, event posting, or permission request. It runs in the existing macOS CI job; Linux skips it. This is not a native application acceptance test.

## Verified gaps, not bundled fixes

- No OCR implementation was found in the built-in Computer capability source. `computer_inspect` is scoped AX inspection; screenshot capture is an image, not OCR rows or semantic controls. The Peekaboo adapter consumes its provider's labeled elements separately. Adding OCR needs an explicit provenance and coordinate/observation contract; it must not silently create AX selectors or claim AXPress support.
- The native foreground scroll tool accepts deltaY only. The helper creates a one-axis `.pixel` CGEvent with inverted vertical sign and posts globally; it neither sets an event location nor chooses a scrollable AX region. It cannot distinguish a document from a conversation/member pane. The public [CGEvent scroll constructor](<https://developer.apple.com/documentation/coregraphics/cgevent/init(scrollwheelevent2source:units:wheelcount:wheel1:wheel2:wheel3:)>) distinguishes pixel/line units, but creation/posting is not proof of application scrolling. Zero-rounding and allocation handling belong to separate PR #485.
- The Peekaboo scroll adapter maps abs(deltaY)/100 to a bounded integer amount. That is not pixel-equivalent to the native adapter. Changing cross-provider units or adding an anchor is a schema/compatibility choice, not a justified hard-coded wheel multiplier. Explicit region location versus an observed capture-bound location is already part of the separate target-design drafts #486/#487.

## Bounded native read contract

Native inspection now distinguishes unsupported/no-value attributes from actual AX read errors. Its `diagnostics.nativeRead` records bounded error codes/counts, read count and deadline state; `cannotComplete` is preserved as an AX error code, not asserted to be exclusively a timeout. An unresolved exact target or permission failure returns a failure, not an empty successful tree.

The existing 10-second helper-process limit is unchanged. Inspection receives the original Host deadline minus a 250ms result-encoding reserve and converts its remaining time to one monotonic read budget. Every AX read configures the specific element's messaging timeout from the remaining budget; application-object timeout settings do not apply to equal or child objects. This uses [Apple's object-local messaging timeout contract](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout). It does not change OS permissions, retry failed reads, or extend an expired deadline.

Children are fetched with a bounded `AXUIElementCopyAttributeValues` count before copying, limited by the traversal's remaining queue capacity. The depth boundary checks child counts without fetching their arrays. Existing limits remain 1024 visited nodes, depth 24, 120 native output controls and 32 first-page controls; cursor pages still read one immutable capture and cannot recover omitted native content.

After resolving the exact target, a read failure or deadline can return earlier fully read rows as an explicitly partial, observation-only result. Native and Host both remove actions from those rows, and the semantic observation ledger rejects attempted mutations even with copied/forged selectors. This is distinct from deterministic visit/depth/output truncation, whose existing action policy is unchanged. No OCR, automatic screenshot, foreground input or provider fallback is introduced.

A new native inspection revokes only that exact target's future semantic grants before reading. Its pending token remains in the existing transient ledger, not a second state store or user permission credential. Older inspection success/failure cannot overwrite a newer grant or read-only partial. A mutation that already consumed its observation retains its local fingerprint and original helper completion; inspection does not cancel it, roll it back, replay it or restore its consumed grant.

`computer-native-inspect.test.ts` checks Host enforcement, pagination, exact-target isolation and overlapping completion order with an injected driver. On macOS, the shipped Swift budget/read/traversal/inspection functions run against Foundation-only AX API doubles and a fake monotonic clock. Those tests perform no real application access, input, capture or permission requests. Actual native compilation remains a separate packaging gate; these fixtures are not DingTalk/WeCom or locked-screen acceptance.

## Remaining validation

The synthetic Swift cases and production native compilation require macOS CI. Actual AX exposure from a controlled native/Chromium fixture, wheel routing and accepted scroll amount, and WeCom-specific behavior remain unverified. None of these changes closes #484 or fixes focus/coordinate/target ownership.
