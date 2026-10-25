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
- Native AX array access currently returns an empty array for attribute-count/read errors as well as genuinely empty/missing attributes. Traversal completeness is based on visit/depth/output limits only. Consequently an AX messaging failure can be indistinguishable from an empty subtree. A future narrow fix should distinguish unsupported/no-value attributes from transient/error reads and expose incomplete coverage, without retrying native actions or fabricating missing nodes. This is separate from value labeling and has not been changed here.

## Remaining validation

The synthetic Swift cases and production native compilation require macOS CI. Actual AX exposure from a controlled native/Chromium fixture, wheel routing and accepted scroll amount, and WeCom-specific behavior remain unverified. None of these changes closes #484 or fixes focus/coordinate/target ownership.
