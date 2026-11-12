# Unified Computer target: implemented native macOS draft

This replaces the **either A or B** framing of #486/#487 with two entry points to
one target. It is a production-path integration draft, not a claim that #484's
WeCom incident has been reproduced or fixed. Do not merge before review.

## Model-visible sequence

1. `computer_list_windows` discovers exact app/window targets.
2. Either `computer_select_target({target})` selects that exact window without
   activating it, or `computer_screenshot({target})` selects it and returns the
   private PNG metadata plus `bindingId` and `captureId`.
3. `computer_foreground_key_press({bindingId,key:"tab"})` and
   `computer_foreground_scroll({bindingId,deltaY:100})` use the invoking thread's selected
   target. No screenshot is needed before each key.
4. `computer_foreground_click({captureId,x:120,y:80})` uses **image pixels**, not
   desktop coordinates, and only accepts the current window capture. The host
   maps pixels to captured global bounds, including negative desktop origins.
5. Existing foreground permission, per-tool approval and foreground activity
   arbitration still apply. After that handoff, the native helper activates and
   raises the selected window, verifies actual frontmost app and focused window,
   then repeats the identity/geometry/focus fence immediately before each event.

A full-desktop image never selects a target. This implementation's screenshot
entry point remains window-only. Selection doesn't follow arbitrary OS focus.
Application-only selection requires exactly one accessible on-screen window;
ambiguous applications must supply a specific window title from discovery.

## What is wired

- Native `ElectronMacComputerBackend` creates a serialized JSONL helper session.
- `ComputerZenXCapabilityPackage.invoke` routes select, scoped screenshot and
  foreground click/key/scroll/type/shortcut through that session, with trusted
  `invocation.threadId` ownership, not a user-supplied owner field.
- Native provider discovery advertises version 1.1.0 and the changed click schema.
  Old unbound calls fail, rather than silently retaining unsafe global dispatch.
- The helper retains AX window objects and the process launch identity. A same-PID
  wrong focused window, closed/replaced window, changed capture ID/geometry,
  missing target, cancellation or native failure refuses subsequent input until
  explicit reselection. No assumption that a recycled numeric window ID is the
  original AX object.
- Packaged builds compile and sign the fixed `zenx-bound-target` helper. Packaged
  runs never compile or substitute a development binary.
- Consent and foreground arbitration are not replaced. Selecting a target is not
  a permission grant. The helper checks existing Accessibility access without
  requesting trust or changing OS settings.

## Lifetime, outcomes and bounds

One helper process belongs to one native provider instance, with at most 32
thread bindings. Re-selecting replaces that owner's binding/capture. Capacity
exhaustion refuses selection; it never silently evicts another owner's target.
Package shutdown ends the helper. Cancellation, timeout and broken transport
kill it and await native process closure; all native references disappear.
Only a new explicit selection may start a replacement helper. There is no
background recovery, persisted registry, automatic replay or compensating
release injection.

Native refusal before posting says no input dispatched. Errors after one or
more posts say partial/unknown and prohibit automatic replay. Successful native
receipts mean posted, not verified application acceptance. Focus/geometry checks
and CGEvent posting are **not an OS-atomic transaction**: external focus changes
can still race a final check. This is practical routing protection, not a claim
of perfect input isolation.

Images must have coherent full-window aspect ratio. Real mixed-DPI/decorated
window capture and actual custom-drawn-app delivery require platform acceptance.
Scroll now carries the selected window's center as event location; scroll units
remain pixels and no multiplier was introduced.

Click and scroll additionally check the actual pointer location before **each**
event: the selected window must be the first containing window in the on-screen
front-to-back native window list, and Accessibility hit-testing must resolve the
same retained AX window. Nonactivating overlays, same-process covering windows,
missing hit-test results and ambiguous occlusion refuse input. This deliberately
also refuses transparent or mouse-ignoring overlays rather than guessing their input
behavior. The sole exception is the presenter's currently painted, live,
mouse-ignoring `edges` windows: their exact native IDs come from trusted main
code after arbitration, not model arguments. Native verification additionally
requires their CG owner PID to be the helper's parent. The interactive Stop
card and all other windows remain occluders. After the CG check, app-scoped AX
hit-testing must still resolve the retained target window. Indicator loss uses
the existing cancellation/child-closure path; no durable exemption is stored.
An overlay appearing after a posted event produces partial/unknown,
never an automatic release or retry. These checks still are not OS-atomic.

## Deliberately not claimed

- This draft does not make Peekaboo or Windows inherit native macOS guarantees.
  Their manifests and implementation remain distinct.
- Unicode keyboard events are not equivalent to semantic `computer_set_value` or
  paste. Application frameworks may ignore the Unicode override. Acceptance must
  be observed; no success or automatic retyping is inferred from event posting.
- Shortcut support is deliberately bounded to logical a-z/0-9 plus the existing
  navigation keys, not arbitrary function keys, dead-key sequences or IME text.
  There is no ANSI fallback when the current layout cannot resolve a key.
- The original remote WeCom artifacts and live app have not been accessed.
- No user computer, local Codex, OS settings or personal desktop were used.
- Source-level fixtures do not prove real native event delivery or custom-drawn
  application acceptance. The two old design draft PRs are not merged or closed.

## Verification contract

Local tests exercise the actual package route, owner isolation, capture mapping,
old capture rejection, geometry incoherence, consent, native transport death and
no replay. The existing macOS packaged-capability job explicitly runs a test that executes
the shipped Swift Binding/dispatch flow
against controlled platform API doubles for focus theft, same-PID wrong window,
closed/reused window identity, process restart, resize and partial effects.
The packaging pipeline compiles the complete real Swift helper on macOS.
The generic ZenX test job runs on Linux and skips the native fixture; it is not
evidence of executing that fixture. These
fixtures do not activate apps, request OS permission, capture desktops or post
real events. CI must be checked on the exact published head before acceptance.

Recovery review also covers helper shutdown during executable preparation and
malformed native receipts: no helper may start after retirement, and broken
transport only settles after child closure. Tests assert process death before
rejection; an invalid receipt never permits automatic replay.

Run `40182544245` on the earlier published `39b4cfa9` passed seven of eight jobs.
Its macOS browser parallel-input job failed before input scenarios, during
`startup-agent-inspection`: `Page.createIsolatedWorld` timed out after dispatch
with 1124ms remaining in the existing shared setup budget. The retained artifact
`12595230257` records completed cleanup and no diagnostic artifact errors. This
is not a bound Computer failure or acceptance result; no assertion, deadline or
retry policy is weakened here. Main's #505 preview-capture changes do not alter
that browser-provider path.

## Native keyboard extension (separate commit)

`computer_foreground_type({bindingId,text})` accepts 1–1024 well-formed Unicode scalars.
It posts Unicode down/up pairs in chunks of at most 16 UTF-16 units, never
splitting a scalar/surrogate pair. It does not access the clipboard. Receipts
report only scalar count and posted/unverified; no new text/key logging or
payload echo is added. Ordinary canonical tool-call arguments remain subject to
the existing tool history policy. Partial/cancelled typing is never resumed or
replayed automatically.

`computer_foreground_shortcut({bindingId,key,modifiers})` accepts a logical lowercase
letter/digit or navigation key, with 1–4 distinct command/control/option/shift
modifiers. For character keys, native TIS/UCKeyTranslate resolves the current
layout (the Command mapping when Command is present). Shift/Option/Control are
then applied separately; this describes a shortcut's unshifted key label, not
Option/dead-key text output. Missing/ambiguous mappings fail closed. Before every
post the current source, layout and mapping are re-resolved and must agree.
No hardcoded ANSI letter keycodes are used. Navigation keys use their stable
non-character virtual-key identities.

These API semantics follow Apple's documented Unicode override and layout
translation boundaries:

- https://developer.apple.com/documentation/coregraphics/cgevent/keyboardsetunicodestring(stringlength:unicodestring:)
- https://developer.apple.com/documentation/coreservices/1390584-uckeytranslate

Synthetic native cases cover surrogate boundaries, a non-ANSI logical key
mapping, ambiguous mappings, source/mapping changes between down/up, and focus
loss during a text chunk. They are not real recipient application acceptance.

The bindingId on keyboard and scroll requests is mandatory: it is copied from
select/screenshot and reused, not obtained through a new screenshot each time.
This pins intent before Host approval. If another same-thread selection occurs
while approval is pending, the old input refuses rather than following it. Click
already has this property through its mandatory captureId. The provider also
freezes selection again before foreground arbitration, and stale failures never
revoke a newer selection belonging to the same thread.

Approval display limitation: this draft pins the exact binding in tool arguments,
but does not yet enrich approval cards with trusted app/window names. The existing
Core approval-scope preparation hook is synchronous in the Host child, while
native Computer metadata currently lives in Electron main; there is no Computer
binding projection in the Host snapshot. Supplying a model-written label would
not be a trusted replacement. No screenshot/activation is performed merely to
resolve an approval label.
