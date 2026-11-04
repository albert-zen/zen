# Browser and Computer restriction audit

This cleanup keeps the current production providers and model-facing routing.
Playwright execution unification and WebView presentation are separate experiments,
not prerequisites for using this cleanup and not default switches.

## Restrictions removed

- HTML `select`, file, color and date/time-family inputs and their associated labels
  no longer fail targeted Browser pointer/key input merely because of their tag or
  type. Existing exact-page CDP dispatch handles the event pair. Opening a file or
  color chooser does not claim to have selected a file or color inside an OS dialog.
- Fixed Browser tab quotas (Workspace 20 globally, isolated 8 per session / 24
  globally) no longer stop an otherwise valid operation. Existing pages are not
  automatically closed to make room. Connected Browser discovery no longer hides
  tabs after the first 24, and Playwright page schema validation no longer treats
  a valid large tab index as malformed.
- Uncertain ordinary page actions are not permanent attachment-ownership failure.
  The original action still reports its unknown result and is never automatically
  replayed. Observation can recover action admission after native settlement.
- Possibly held Browser input does not prohibit unrelated DOM observation or
  programmatic page operations. Its targeted-input restriction follows the actual
  target through detach/re-attach, rather than falsely claiming detach released
  an input that may still be held.

- Computer discovery no longer silently cuts its list at 32 windows. Exact empty
  window titles survive the public reference and native AX targeting paths.
- Native macOS navigation/delete/function keys and printable logical shortcut
  characters are exposed through the existing keycode/layout resolver. Other
  providers retain their own actual vocabulary.
- Foreground Computer input no longer sleeps for an additional second on every
  action. The existing foreground activity indicator must still be painted, with
  approval, cancellation and exact focus checks unchanged.

Native typing retains its 1024-scalar event preparation/operation budget. Background
application keyboard still has no modifier/shortcut API, and background pointer
input remains capture-bound left-click only. Those are explicit implementation
gaps, not evidence that the underlying platform can never support them.

## Actual boundaries that remain

A capability missing an implementation is not a policy that only a human may
operate that class of UI. The current Browser coordinate/focus helper does not
resolve iframe inner targets or closed shadow roots. Removing its identity checks
would send input to an unverified inner document; a frame-aware executor is needed.
Open shadow roots are supported within the existing tracked observation bounds.
The top-level semantic inspector still reports iframe/shadow coverage omissions.
The experimental Playwright path is evaluated separately for these capabilities;
it must not silently replace the default provider or move a user's page.

Native OS dialogs need a matching dialog or Computer capability and its own
permission/target checks. No Browser input operation implicitly grants desktop
input, accepts a dialog, changes a foreground window, or supplies a file.

Generation/owner/session binding, real target identity, current geometry, human
control, cancellation and explicit permissions remain authoritative. Genuine
unknown attachment/cleanup ownership remains distinct from uncertain page effects.
A known pre-dispatch rejection is not an unknown external effect.

Resource protections remain for bounded CDP responses, screenshot bytes/pixels,
observation captures and event serialization. A bounded observation must disclose
coverage and continuation; it must not pretend omitted controls are absent.
Arbitrary JavaScript `evaluate`, including in an isolated world, can modify the
shared DOM or issue requests. Isolation is not read-only execution.

## Verification

Focused Node/JSDOM tests cover ordinary and open-shadow controls, stale identity,
closed/unresolved roots, complete input event pairs and quotas above the old
thresholds. The native Workspace smoke uses synthetic HTML controls with real
trusted clicks; its fixture prevents the picker default action so the test does
not open an OS dialog. Native macOS/Windows delivery and real hosted Browser smoke
must be reported separately from synthetic provider tests.
