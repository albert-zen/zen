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
