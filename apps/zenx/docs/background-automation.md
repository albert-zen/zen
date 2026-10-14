# Background automation and Agent pointer

Design: 2026-10-05. Scope: Browser and Computer execution/observation in ZenX.

## Problem and decision

The user wants to keep working while the Agent operates, and see where the Agent
acts. Browser already uses hidden Electron pages, a shared WebContentsView, or
targeted Chrome/CDP connections. Computer already separates targeted semantic
actions from explicit foreground takeover. Preserve these execution boundaries
and add a separate visual Agent pointer. Do not move the physical pointer to
produce an animation.

The pointer marks actual semantic action destinations. A line between successive
destinations is a visual aid, not a recording of an OS mouse movement. Tool
results remain authoritative; a marker is not proof that a business workflow
completed. No typed text, control titles, credentials or selectors enter the
visual payload.

## Research and alternatives

| Approach                                   | Fit and boundary                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Targeted DOM/CDP and hidden Electron pages | Existing Browser path. No activation is needed. Use the same target and document checks for actions and visuals.                                                          |
| AX/UIA semantic controls                   | Existing Computer path. Supports controls exposing press/value operations; availability depends on the target app.                                                        |
| Global pointer/keyboard injection          | Affects the shared desktop. Keep the existing explicit foreground opt-in and cancellation contract.                                                                       |
| Dedicated VM/remote interactive desktop    | Necessary for arbitrary pixel-level desktop automation without using the user's desktop. Separate future product work: significant OS, login, file and capture lifecycle. |

Electron documents per-page [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view),
[capture and background throttling](https://www.electronjs.org/docs/latest/api/web-contents/)
and [debugger commands](https://www.electronjs.org/docs/latest/api/debugger).
CDP [Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/) uses
viewport CSS coordinates; [Page.bringToFront](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-bringToFront)
explicitly activates a tab. Background work must not call that command or an OS
activation API. Disabling background throttling supports rendering but has a
power cost; retain the existing visibility-limited observation subscriptions.

Apple [AXUIElementPerformAction](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction)
and [AXUIElementSetAttributeValue](https://developer.apple.com/documentation/applicationservices/axuielementsetattributevalue)
address a particular accessibility element. [CGEvent.post](https://developer.apple.com/documentation/coregraphics/cgevent/post%28tap%3A%29)
posts to an event stream. Windows [UIA control patterns](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview)
expose semantic operations, whereas [SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)
changes foreground ownership. Semantic actions can still cause an application
to open a dialog or choose to activate itself; ZenX cannot promise that arbitrary
apps never change focus as a consequence of their own behavior.

This design is inferred from documented APIs and verified ZenX code, not a claim
about Codex's private implementation. The reference is its user experience:
background execution with a distinct Agent pointer.

## Implementation boundaries

Browser paints a bounded, short-lived pointer/trail after target validation.
The shared native WebContentsView sits above the React renderer, so a React
overlay alone cannot cover it. A closed shadow root in the page provides the
same indicator in the interactive workspace and live capture. It is inert,
aria-hidden, has no Host bridge, and does not receive input or enter DOM target
enumeration/text inspection. Page code or policy may remove/hide the indicator;
visualization is best effort and must never fail or retry an action. Navigation,
scroll and viewport changes invalidate old positions. Reduced motion disables
travel/pulse animation. Keep Electron's sandbox, context isolation and disabled
Node integration ([security guidance](https://www.electronjs.org/docs/latest/tutorial/security)).

Computer gets geometry at the validated native control, normalizes it against
the exact capture window, and publishes it only after a successful semantic
action. Host observation owns the bounded transient projection, scoped to
Thread/window/invocation. Missing, invalid, out-of-window, expired or incompatible
geometry produces no invented point. The renderer paints on the contained image
area, not its letterboxing. Hidden panels stop observation and discard visuals.
Foreground actions and providers without trustworthy geometry do not pretend to
have a background trajectory.

Current visual coverage is shared Workspace Browser, dedicated Electron Browser,
and attached Chrome for click/type/select; scrolling clears prior viewport points.
Computer geometry is implemented for the bundled macOS provider. Windows WinApp
does not expose a verified window origin in the current adapter and its preview
is snapshot-only; Peekaboo has no matching geometry contract. Playwright CLI
requires a separate process/evaluation to fetch post-action positions, which can
observe a navigated document and delay the delivered action. These three
providers keep existing background operations but do not draw invented trails.

The macOS live frame carries fresh AX window dimensions separately from scaled
thumbnail pixels, and retains the originally resolved native window ID. Preview
points are rejected if dimensions change, the target is replaced, the frame
predates the action, or the three-second lifetime expires.

No new scheduler, durable history, permission system or automatic foreground
fallback is introduced. Existing foreground control remains explicit and
revocable. Changing DOM actions to CDP physical-like events is a separate
behavioral change and is not required to visualize the existing actions.

## Acceptance

1. With another input focused, Browser click/type/select actions change their
   intended target without activating a window or moving the physical pointer;
   the Agent indicator appears only at validated destinations.
2. Rejected/stale actions do not draw a success marker. Visual failure cannot
   repeat or fail a delivered action. No marker is an inspect target or text.
3. Switch pages/Threads, navigate, scroll, resize, hide/reopen the panel and wait
   past expiry: no obsolete or cross-target trail remains.
4. Computer action geometry is window-relative and bounded; a missing geometry
   result is honest. Native real-world evidence is distinguished from mocked
   provider tests, especially on Windows and applications without AX/UIA support.
5. Inspect light/dark, narrow/desktop and reduced-motion presentation. Pointer
   overlays never intercept user input or receive keyboard focus.

Test/build/review evidence and exact supported provider coverage are recorded in
the PR and delivery report; source implementation is not an installed release.

### Windows dependency correction

The pinned WinApp 0.3.1 screenshot implementation is not a strict-background
primitive: it restores minimized windows and can activate a blank-frame target
without a foreground flag. The Windows adapter now uses a fixed PrintWindow-only
helper for screenshot acquisition, while keeping WinApp UIA actions unchanged.
The helper has no activation/restore/input API, refuses unavailable frames, and
runs in a bounded cancellable child process. Its source is bundled with ZenX;
PowerShell is the system executable and request data is sent only on stdin.
The existing Windows smoke records UIA targeting separately: native evidence found
a focus change during its set-value stage, so UIA is not certified focus-isolated.
Only after that evidence is saved does explicit fixture setup establish an
occluding foreground guard for an independent screenshot epoch, with no focus
reset during capture. That epoch checks continuous native focus/pointer sampling,
valid magenta content, actual native print-callback
observation and minimized-window refusal. If Windows bypasses the fixture's
partial-print callbacks, a successful capture must still contain its exact marker
pixels. Native synthetic bitmap tests always exercise the production sentinel
classifier's unpainted-buffer refusal; they do not replace real PrintWindow
capture acceptance. Ambiguous sentinel-colored pixels alone
are confirmed against a differently initialized second capture within the same
timeout; full-frame stability is not required, and pixels are never composited
across times. Changes at those ambiguous positions fail explicitly.
Windows native execution
is required before this change is certified; cross-platform fixture passes alone
do not establish its native capture behavior.

## Targeted Browser input (1.0.6 / multi-instance 1.0.8)

`browser_pointer_click` and `browser_key_press` add a targeted CDP input path for
Workspace, dedicated Electron, and explicitly attached Chrome/Edge. The registry
qualifies them as `browser_workspace_*` and `browser_connected_*`, keeping exact
connection, session, tab, observation and permission boundaries. Playwright CLI
continues to expose only its implemented tools; these two additions are not
advertised for that backend. Update the installed Browser plugin to expose the
new manifests. Ordinary input is page-targeted and remains available in the
background: it does not depend on the active Chrome tab/window. It never uses a
browser-level shortcut or global input fallback. Native pickers/dialogs are a
separate boundary requiring human control, not a reason to require foreground
control for every normal click or key. Inspect results expose these limits as
machine-readable `inputPolicy`.

The first slice supports a left click and one unmodified named key. It does not
support drag, arbitrary shortcuts, frames, native pickers or OS input. Inspection
publishes `inputViewport` only when a real screenshot and its before/after
viewport/focus snapshots agree. Coordinates are CSS pixels: scale image x/y by
`inputViewport.width / screenshot.width` and the corresponding height ratio.
`deviceScaleFactor` is diagnostic; do not multiply coordinates by it a second
time. Pinch-zoomed visual viewports and fallback images have no input capability,
while their existing DOM inspection remains available.

Key input requires `focusedInputAvailable`, representing a non-body focused
element in the exact observed document. Open shadow roots resolve to their real
focused/hit nodes (at most 32 resolution steps), so moving focus between sibling
shadow inputs invalidates the observation. The existing mutation observer also
tracks discovered open roots (at most 128 per document and 8,192 visited elements
per snapshot), including shadow-local scrolls. Untracked, known closed, ambiguous or
over-depth surfaces are unsupported locally. For a candidate that can host an
author shadow root, the trusted backend resolves its actual isolated-world node
object and asks `DOM.describeNode(depth: 0, pierce: false)` for shadow metadata.
Ordinary div/span/styled-button/contenteditable containers remain supported;
their tag names only determine whether this query is needed, never a denial.
The remote object is released, then the same server-returned backend node ID and
a fresh DOM probe are rechecked on the exact target/session. No object/node ID
comes from model arguments, and absence of a root is never cached across actions.
Known closed-root focus is not advertised as available. The rest of the page and
its existing DOM inspection remain available if optional evidence is missing.

These are bounded checks, not an atomic transaction with renderer JavaScript.
A page may still change after the last CDP response and before native input;
there is no silent JS pause, polling loop, or claim to prevent arbitrary script
side effects. Native platform acceptance remains required. It never chooses the current browser tab
or moves focus implicitly. Page-local Tab/arrow effects are allowed, but a stale
focus, viewport, scrolling, navigation, other trusted input, or human takeover
before dispatch rejects. The pointer probe also rejects identifiable native
picker controls, their associated labels, and embedded surfaces; it directs the
user to human control rather than silently opening a known native picker.
Known local refusals use `BROWSER_INPUT_UNSUPPORTED` with `native-surface` or
`shadow-surface`; the same code/reason is preserved by all three backends.
Unknown evaluation/metadata errors do not count as a classified native refusal. Enter and Space carry their character
payload; the other named keys use raw-keydown followed by keyup.

Every event dispatch checks the captured target, document and control generation.
An acknowledged press authorizes its planned release on the same fenced page.
The DOM trusted-event counter is supplementary evidence, not an authoritative
CDP receipt: window capture handlers can consume events before it sees them.
Zero or one observed event after the acknowledged press therefore permits the
planned release; more than one detected event rejects as concurrent input.
Consumed events do not prove absence of same-tab human input. Exact host control
and ownership fences still apply; independent user work belongs in another tab.
If a press was sent but the release was not confirmed, no release is sent to a
replacement document: the tab is quarantined, mutations stop, and the user is
told to close it to clear possible held input. No action is replayed. If both
events were acknowledged and a later fence changed, the result remains explicit
about the unknown outcome without claiming an input is still held. A fresh
inspection can resume once the ordinary ownership rules allow it.

This path never requests `Page.bringToFront`, `Target.activateTarget`, window
focus, or global pointer/keyboard injection. Trusted page input nevertheless can
cause site code to open dialogs, popups, or request window focus. Known open
JavaScript dialogs block targeted dispatch and require human control; ZenX does
not accept or dismiss them automatically. It is not a
guarantee that arbitrary websites will never affect focus. Native acceptance
must record foreground HWND/app, actual active tab, system pointer and final
page behavior, not rely only on DOM visibility or protocol mocks.

The Windows attached-browser smoke now exercises an inactive real Chromium tab:
canvas click, Space insertion, Enter form submission, Tab focus movement,
ArrowDown scrolling, native file-picker rejection, and foreground/active-tab
preservation. These checks are a pending native release gate until run for the
exact build. Linux protocol fixtures establish target/fence/error behavior only.

New extension-created tabs are grouped under ZenX within their current native
connection and browser window, without activating them. Existing user tabs are
never grouped; moved tabs are not moved back and existing group names/colors
are preserved. Group IDs are presentation, not action authority. A grouping
failure still returns the successfully created target with an explicit
`grouping` status; it must not cause `browser_open` to be replayed. Direct CDP
without the extension reports grouping unavailable. Reload the extension after
updating; its `tabGroups` permission enables this presentation feature.

Extension 3.1.0 adds the `tabGroups` permission. The user must update/reload the
extension and approve any browser permission prompt; this code change does not
install, register, or approve the extension automatically. Group metadata waits
at most 500 ms after creation. A timeout returns the already-created target and
`grouping.status: "unknown"`: an already-sent native group command may still
finish, but ZenX will not follow it with renaming, regrouping, rollback, or a
duplicate create. Never interpret missing group acknowledgement as no tab or no
group having been created.
