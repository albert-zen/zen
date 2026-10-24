# macOS Computer input investigation (#484)

## Evidence boundary

The issue reports WeCom macOS 5.0.9 clicks/scrolls having no effect, sparse AX
labels and input arriving in a different foreground draft. These are user-reported
observations, not independently reproduced here. Original screenshots and logs
remain on another machine and were not read. All new tests use synthetic inputs;
no WeCom login, user-desktop access or OS permission changes are involved.

## Verified current contracts

The first-party package routes through `ComputerZenXCapabilityPackage` in Electron
main to `MacDesktopComputerBackend`, then to the bundled Swift foreground helper.
Host foreground consent and exclusive shared-desktop ownership are distinct from
recipient verification. The visible non-activating activity indicator and the
one-second cancellation notice precede backend invocation. No activation is
performed by this helper; the overlay uses `focusable: false` and `showInactive`.
This does not establish what changed focus in the reported task.

The three global-input tools currently have **no app/window target argument**.
Key input is delivered to the focused control; scroll has only a delta and no
explicit pointer/region location. Thus neither can reject a mismatch between the
caller's intended application and the actual recipient. Consent alone does not
establish that identity. The shared desktop lock cannot prevent a user or another
application changing focus.

Window screenshots are resized thumbnails (requested maximum 1600 × 1000), while
foreground clicks use global desktop coordinates. The screenshot response has
image dimensions but no captured global-window transform. Directly reusing image
pixels as global coordinates is unsound. This is not evidence of an unconditional
Retina multiplier bug; global coordinates, negative monitor origins, image scale
and window position must be distinguished.

AX inspection has bounded traversal and explicit coverage diagnostics. Missing
labels are not proof of missing visual text. OCR would be a separate observation
source, not an actionable AX selector. An OCR/vision fallback must carry its
capture and coordinate provenance rather than manufacture AX identity.

## Bounded fixes in this patch

1. The helper previously optional-chained failable CGEvent construction. A nil
   event could produce a partial sequence and still exit successfully. Explicitly
   guard each construction while preserving the original construct/post ordering.
   Before any event is posted, a constructor failure reports no dispatch; after a
   prior post it reports partial/unknown effect and forbids automatic retry. The
   existing process-error path carries that wording to the public invocation.
   Input is not transactional; no automatic release or rollback is attempted.
2. A nonzero fractional scroll delta could round to zero. Validate the normalized
   native pixel amount before helper preparation, and reject zero/invalid native
   input in the helper as well. Preserve existing rounding, sign and bounds for
   valid amounts; do not invent repeated scrolls or an automatic fallback.

The recording Swift fixture executes the shipped helper control flow with fake
CoreGraphics constructors/posting. It checks every construction-failure position,
the exact posted prefix on late failure, original ordering and scroll sign. It does not load
ApplicationServices, acquire Accessibility permission or send desktop input.
Native package CI separately compiles the production helper against macOS APIs.

A successful return still establishes only completed event posting, not that an
application accepted it or changed UI. Cancellation/process failure after a post
may have an unknown effect; there is no automatic retry or rollback claim.

## Separate design decisions, not implemented by this patch

- Explicit app/window-bound foreground input versus observation-bound targeting:
  migration, freshness, exact window identity and unsupported backend behavior.
- Preflight global input has a time-of-check/time-of-use race; it cannot honestly
  promise atomic recipient binding. Direct-to-process posting has different
  compatibility and focus semantics and requires owned native fixtures.
- Screenshot coordinates need a single capture-bound transform and geometry
  revalidation. Scroll needs an explicit region or a documented current-pointer
  contract, not an assumption that keyboard focus chooses a scroll container.
- A conservative refusal of unbound input is safer than silently claiming that a
  preflight check fully solves wrong-recipient input. Breaking existing tool
  behavior or replacing tool names is a product/API choice for a separate draft.

## Primary references and limits

- [Apple mouse-event initializer](<https://developer.apple.com/documentation/coregraphics/cgevent/init(mouseeventsource:mousetype:mousecursorposition:mousebutton:)>):
  failable event construction and global coordinates.
- [Apple CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent):
  event posting is not an application-level success acknowledgment.
- [Apple event-source state](https://developer.apple.com/documentation/coregraphics/cgeventsourcestateid):
  nil sources are permitted; changing to HID state is not a proven WeCom fix.
- [OpenAI public computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use):
  screenshot/action loops and coordinate mapping. No claim about private Codex
  implementation follows from this public API contract.
- [Anthropic computer-use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool):
  explicit screenshot-coordinate and pointer/scroll semantics.
- [Playwright mouse](https://playwright.dev/docs/api/class-mouse) and
  [actionability](https://playwright.dev/docs/actionability): explicit coordinate
  spaces and dispatch-versus-observed-outcome distinction. Browser DOM guarantees
  do not automatically extend to AX or native event injection.

Real acceptance still needs an owned macOS fixture with independently observed
button effects, input receipts, two scroll panes and foreground switches, then
separate WeCom verification if authorized. Include offset/Retina/secondary-display
geometry and the activity overlay. Fixture success is not WeCom certification.

## Native allocation-state evidence and remaining gate

[Apple's CGEventFlags contract](https://developer.apple.com/documentation/coregraphics/cgeventflags)
associates modifier flags with event creation time. Preallocating a release before
posting a press cannot promise bit-for-bit equivalence if physical modifiers
change during the existing 20/30 ms interval. The patch therefore preserves the
original construction/post ordering instead of introducing preallocation. The
current allowlist has no synthetic modifier keys; no intended modifier transition
is added. Apple's [keyboard API documentation](<https://developer.apple.com/documentation/coregraphics/cgevent/init(keyboardeventsource:virtualkey:keydown:)>)
shows preconstructed sequences, but that is not proof of nil-source mouse-event
metadata equivalence. Native defaults and concurrent physical input remain an
acceptance boundary, not a justification for speculative flag/source changes.

Mature public implementations differ: [PyAutoGUI's macOS helper](https://github.com/asweigart/pyautogui/blob/master/pyautogui/_pyautogui_osx.py)
uses nil-source mouse events without explicitly overriding click count;
[Hammerspoon's event constructors](https://github.com/Hammerspoon/hammerspoon/blob/master/extensions/eventtap/libeventtap_event.m)
use an explicit private source and modifier handling. Their ordinary click
wrappers construct/post down before constructing/posting up. These precedents
support investigation, not proof of preallocation equivalence or a WeCom fix.
No source, modifier, click-count or coordinate policy is changed here.

Chromium's public [macOS event builder](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/input/web_input_event_builders_mac.mm)
reads NSEvent click count, modifiers and window/view coordinates; Blink's
[mouse click dispatch](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/input/mouse_event_manager.cc)
requires a positive click count among its conditions. Thus an actual zero count
could suppress a DOM click. This is conditional evidence, not a finding that
ZenX's constructor emits zero or that WeCom uses that exact Chromium revision.

The added macOS construction probe uses **real CGEvent constructors but never
posts**. Its bounded JSON records types, click counts, flags, button/key fields
and coordinates, including a negative fractional point. It asserts only explicit
constructor arguments and types, not an undocumented default click count or zero
modifiers. CI retains that receipt separately. This observes constructor metadata,
not delivered NSEvent fields, application event receipt, modifier transitions after
posting or WeCom behavior. Real receiver/application acceptance is still separate.
