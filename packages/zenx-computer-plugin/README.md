# ZenX Computer

First-party Computer package distributed with ZenX and installed through the ordinary plugin profile.

Start with `computer_environment({})` to read the current desktop availability.
The Host refuses targeted work while the session is locked or suspended and
invalidates observations on a state change. It never unlocks the desktop or
replays input. On Windows and the bundled macOS provider,
`computer_list_windows({})` returns up to 32 open windows with exact, owner-scoped
short `ref` values. Pass a window ref to `computer_inspect`,
`computer_screenshot` or `computer_select_target`. Native callers can still
use the exact target object. Listing does not activate windows or enumerate
installed applications. Use `query` to filter by application name, PID or
title before the result limit.

Titles are preserved exactly, including empty titles and titles longer than 256
characters; targeted operations accept titles up to 4096 characters. Re-list after a window closes or is renamed. Identical titles within
one Windows process remain ambiguous and explicitly fail; do not guess a target.
Discovery supplies windows, not control selectors: inspect the window before
acting. A ref is an exact scoped reference, not a persistent window identity.

The bundled macOS discovery uses its existing Accessibility helper and requires
Accessibility permission. Packaged helpers are precompiled; explicit development
setup requires the Swift compiler. The Peekaboo variant currently
does not advertise window discovery; its existing targeted tools are unchanged.
Windows discovery is verified through WinApp CLI 0.3.1; macOS requires an actual
Mac for live verification.

## Observation pages and diffs

The model-facing `computer_inspect` accepts an exact `target` window ref,
optional `query` and `limit` to narrow the captured controls, `since` with a
retained observation ref for a diff, or `full:true` to rebuild a first page.
The result's coverage names the captured scope; a query miss does not claim
the entire window is empty. Native callers retain `baseObservationId`.

The first reply still contains at most 32 controls. `nextCursor` reads another
page of the same immutable capture using the same exact target, observation
ID and capture time. It does not recapture or renew action authority. Paging
reaches the candidates previously hidden by the public 32-control selection;
it cannot recover anything omitted by native traversal:

- macOS: at most 1,024 visited nodes, depth 24, then 120 retained candidates
- WinApp: depth 8, enabled/on-screen selectable UIA content, up to 512 candidates
- Peekaboo: up to 128 candidates; native completeness can remain unknown

Inspect `coverage.scope`, `sourceComplete`, `reasons` and `items.hasMore`.
Native incompleteness remains explicit after the final page. `full` means a
self-contained bounded view; it does not mean a complete accessibility tree.
Screenshots and foreground scrolling are separate operations, not complete
text/tree retrieval substitutes.

Pass `since` only while retaining that first-page baseline and its applied
diffs. A matching diff contains `controlChanges` with `added`, `updated`,
`removedFromView`, complete `order`, and `replacements` mapping every retained
old ref to its fresh ref. Apply those changes in order; model callers do not
edit selectors. A retained control can be used with an explicit latest
`observation` ref for the same window, subject to native freshness checks.
`computer_press` and `computer_set_value` observe by default and return a small,
self-contained focused view after the action. Pass `since` for an exact diff or
`full:true` for a full first page. If the result says `actionCompleted` with
`observationError`, inspect again without repeating the action.
Discard old continuation pages on each fresh observation/diff and follow its
new cursor for tails. Omit the base or use `full: true` after context compaction
or lost context. Missing/expired bases and scope changes produce a full reset.

Stable Computer references mean unique exact-fingerprint presentation-entry
continuity, never proof of the same native object across captures. Fresh raw
selectors remain private and are revalidated at action time; ambiguous entries
receive fresh references. Observations/cursors/actions are bound to the trusted
thread and exact target. Native actions consume the whole observation,
foreground input invalidates cached captures, and stale/foreign cursors fail.

Host capture limits are five minutes, 64 scopes, 2 MiB per capture and 16 MiB
per presentation store. Pages are byte-aware (normally 32 KiB, hard ceiling
128 KiB); host-budget omissions remain visible in coverage.

Discovery originally shipped in the Windows 1.1.1 and bundled macOS 1.0.1 packages. Existing
profiles keep their installed manifest until the user updates Computer in the
plugin manager (or uninstalls and reinstalls it). A bundled update selects the
current App Resources package for the selected provider, even when the previous
version's tarball is no longer present; the ordinary profile transaction owns
the replacement and preserves plugin data.

## Windows background capture boundary (1.1.3)

Windows UIA discovery, inspection and semantic actions still use the pinned
WinApp CLI. Screenshots use a fixed app-bundled PrintWindow helper launched via
the system Windows PowerShell. WinApp 0.3.1's screenshot command can restore or
activate windows on fallback, so it is not used by the background capture tool.

The helper contains no window activation, restore or global input calls. It
accepts an exact HWND/PID/title, rechecks identity and physical-pixel geometry,
and returns a bounded PNG to the Host; only the Host writes the expiring artifact.
Minimized, hidden, cloaked, protected, blank or unrendered client regions fail
without takeover. A genuinely black client can be rejected as unverified.
Potential sentinel-colored pixels are checked against a differently initialized
second capture under the same timeout. Only those ambiguous positions must keep
their color; unrelated animation is allowed. If they change, capture fails as
unverified. The first frame is returned intact, with no cross-frame compositing. This
supports PrintWindow-renderable windows, not arbitrary GPU surfaces or a
separate desktop session. If system policy blocks PowerShell/Add-Type, capture
reports the failure; UIA operations remain available. Update Computer in Plugin
settings to receive the revised capture description and capability declaration.

## Windows semantic focus boundary (1.1.5)

WinApp 0.3.1 `set-value` and direct CUIAutomation8 `Invoke` were observed
activating a background WinForms window.
Its CUIAutomation8 client leaves `IUIAutomation2.AutoSetFocus` at its default;
Microsoft documents that this setting can focus controls before `SetValue` and
`Invoke`. Targeted UIA and no global input are not proof of focus isolation.

This revision conservatively requires the existing, explicit Foreground computer
control setting for both WinApp `computer_set_value` and `computer_press`, before resolving or
consuming its observation. Revocation prevents subsequent dispatch and requests cancellation of launched work;
termination requests remain pending until the child process and its pipes close.
It cannot undo a UIA operation already delivered to an application.
It never enables the setting, restores old focus, or substitutes global input.
This is a temporary safety boundary, not a completed background-text-input fix.
Both activating mutation paths stay gated while a verified background transport is developed.

The native smoke includes fixture-only direct CUIAutomation8 `SetValue` and
`Invoke` comparisons with default AutoSetFocus versus FALSE, with independent
continuous focus/pointer samples, provider identity and complete Unicode checks.
No experimental client is exposed as a production background-safe path. A green
screenshot epoch does not certify semantic actions or other apps/providers.

## Local visual-text fallback (native macOS 1.2.0)

For self-drawn apps with empty or partial AX inspection, explicitly call
`computer_screenshot({target})`, then
`computer_ocr({target, captureId, languages: ["zh-Hans", "en-US"]})` with that
same screenshot. There is no automatic fallback after an AX failure. Update
Computer in Plugin settings to receive the native 1.2.0 schema.

OCR runs Apple Vision locally, with no paid API, upload, model download or cloud
OCR. It returns recognized `texts` with confidence and approximate line `box`
geometry in the **original screenshot pixels, origin at top left**. It preserves
`bindingId`, `captureId`, `capturedAt` and the original five-minute expiry; it does
not take a new screenshot or make old pixels fresh. These are visual observations,
not authenticated labels, semantic controls, or evidence that a click will work.
There are no OCR control selectors or `press` actions. Foreground coordinate input
still requires explicit consent and all existing exact-window checks.

The read has its own ten-second budget shared by before/after native binding
checks and OCR, not an extension of the existing AX ten-second budget. Timeout or
cancellation terminates the owned helper and waits for process closure; it never
retries input, activates a window, wakes a display or unlocks a session. Packaged
helpers are compiled before signing; only explicit development setup may compile
once under the existing separate 60-second setup limit. If the existing scoped
capture is unavailable (permissions, locked/off/unrendered desktop, missing
window), OCR cannot bypass that failure.

Only the current thread's current capture is accepted. Reselection, replacement
capture, attempted input, provider retirement, expiry, changed window identity
or geometry, and changed PNG bytes invalidate the read. A screenshot may still
show older app content; the returned capture time is not a promise of live state.

Limits: 4 million pixels, 16 MiB encoded PNG, 96 text boxes, 16 KiB recognized
UTF-8 text; `truncated` reports omitted recognized results. The existing macOS
screenshot path requests a 1600×1000-bounded Electron thumbnail, including on
Retina displays, so its image fits the OCR pixel limit without a second resize.
Image-pixel boxes are not macOS logical points or global desktop coordinates.
An empty `texts` array means no text recognized, not a complete semantic tree.

Vision revision 2 preserves the macOS 12 minimum. Defaults are Simplified Chinese then
English (`zh-Hans`, `en-US`); callers may request 1–4 language tags. Chinese/English
sets are normalized to Chinese-first without dropping any requested language;
the returned `languages` reports the effective order. Chinese can pair only with
English in revision 2; incompatible combinations fail with a correction hint
rather than silently using the Latin-only recognizer.
Native supported-language discovery rejects unavailable languages explicitly,
rather than silently recognizing English alone. Accuracy depends on the source
pixels and installed OS. Windows and Peekaboo do **not** advertise this tool;
local OCR is explicitly unavailable there. Synthetic native CI checks Vision
English/CJK recognition and geometry; it does not certify DingTalk or WeCom.

The Chinese-first requirement follows [Apple’s Vision language guidance](https://developer.apple.com/documentation/vision/recognizing-text-in-images)
and [WWDC21’s explanation of script-model selection](https://developer.apple.com/videos/play/wwdc2021/10041/).
