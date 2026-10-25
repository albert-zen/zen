# Unified Computer target: implemented native macOS draft

This replaces the **either A or B** framing of #486/#487 with two entry points to
one target. It is a production-path integration draft, not a claim that #484's
WeCom incident has been reproduced or fixed. Do not merge before review.

## Model-visible sequence

1. `computer_list_windows` discovers exact app/window targets.
2. Either `computer_select_target({target})` selects that exact window without
   activating it, or `computer_screenshot({target})` selects it and returns the
   private PNG metadata plus `bindingId` and `captureId`.
3. `computer_foreground_key_press({key:"tab"})` and
   `computer_foreground_scroll({deltaY:100})` use the invoking thread's selected
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
  existing foreground click/key/scroll through that session, with trusted
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

## Deliberately not claimed

- This draft does not make Peekaboo or Windows inherit native macOS guarantees.
  Their manifests and implementation remain distinct.
- Existing native keyboard exposes the established allowlisted navigation keys;
  new arbitrary text typing and arbitrary shortcut tools are not added here.
  Existing semantic `computer_set_value` remains explicitly control-targeted.
- The original remote WeCom artifacts and live app have not been accessed.
- No user computer, local Codex, OS settings or personal desktop were used.
- Source-level fixtures do not prove real native event delivery or custom-drawn
  application acceptance. The two old design draft PRs are not merged or closed.

## Verification contract

Local tests exercise the actual package route, owner isolation, capture mapping,
old capture rejection, geometry incoherence, consent, native transport death and
no replay. A macOS-only test executes the shipped Swift Binding/dispatch flow
against controlled platform API doubles for focus theft, same-PID wrong window,
closed/reused window identity, process restart, resize and partial effects.
The packaging test typechecks the complete real Swift helper on macOS. These
fixtures do not activate apps, request OS permission, capture desktops or post
real events. CI must be checked on the exact published head before acceptance.
