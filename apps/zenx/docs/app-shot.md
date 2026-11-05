# App Shot

Use the computer icon beside the Composer attachment button, or press Cmd/Ctrl+Shift+2 while the Composer has focus. Select a window, review the screenshot and captured context, then choose **Attach to draft**. Sending remains a separate action. Review captures are staged only in bounded process memory (four previews per renderer and 40 MiB across the Host, expiring after five minutes). Cancel or leave the Composer to discard them; only explicit Attach creates an owner-bound lease in the existing draft attachment staging store. Permanent attachment publication remains part of ordinary Send; cancelled late Attach results retire their draft lease.

On macOS selected-window captures and macOS/Windows foreground captures, the optional checkbox reads bounded accessibility name/value text from the exact window (up to 32,000 characters and 10,000 visited nodes). This can include text outside the screenshot. A failed or unavailable read is marked screenshot-only; the application is never clicked, activated or typed into by this capture path. macOS Screen Recording and, for text, Accessibility permission are controlled by the OS.

Global capture must be explicitly enabled for the current Composer. On macOS/Windows the default choice is **Both Shift**: simultaneously hold physical left and right Shift, not a double tap. It uses T3’s 50ms modifier-state polling and rising-edge latch, without recording typed keys or exclusively reserving Shift. Cmd/Ctrl+Shift+2 is an alternative. Switch to an external app and press the chosen shortcut; ZenX identifies and captures the foreground window before returning to review. Leaving or disabling that Composer cancels pending startup/work and releases the shortcut. This setting does not persist across restarts. Failures visibly disarm; there is no restart loop. On Niri 25.11+ the same Composer opt-in registers a Zen-namespaced session-bus action. The dialog shows a manual Ctrl+Shift+2 binding for the user's existing Niri binds block; registering the action does not reserve keys or edit configuration. Other Wayland sessions use the desktop GlobalShortcuts portal for an explicit consent-aware binding. Unassigned shortcuts remain visibly disabled; Configure is a separate user action and the actual desktop-assigned chord is shown. Closing/disabling the Composer closes its session, but the desktop may remember its user-granted choice. X11 retains the explicit chooser.

Windows follows T3’s Win32 identity → screen-to-DIP rectangle → isolated xa11y region capture path. These are visible desktop-region pixels, not an HWND surface: overlapping windows can appear. Target HWND/PID/title/bounds are checked around capture and optional text. Mac accessibility uses the same pinned xa11y worker path with PID/title/geometry checks. No capture path grants OS permissions or enables accessibility. Native packages are pinned to ffi-rs 1.3.2 and xa11y 0.13.0 and explicitly staged in portable packages.

## Upstream reference and scope

The reference is T3 Code `337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17`:

- [Setup and user behavior](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/user/snap-shot.md)
- [Native capture](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot/DesktopSnapShot.ts)
- [Draft delivery](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/web/src/components/desktop/SnapShotCoordinator.tsx)

T3 uses direct active-window capture on macOS/Windows, a default both-Shift shortcut, optional accessibility trees/text, and Linux compositor helpers/picker support. Its `RegionSnapShot` class captures the Windows active-window bounds; it is not an interactive crop tool. T3 may upload an attachment to a connected server before Send. ZenX keeps this feature's capture local until ordinary Send and uses its existing attachment transfer path.

This is a staged port toward T3 parity, not a claim of completion. Remaining gaps: native GNOME/KDE/Hyprland capture and their explicit setup/config flows; Niri config proposal/save and AT-SPI text; persistent shortcut preferences; rich control trees; pending-capture recovery; sound/flash feedback; and own-ZenX-window capture. Windows explicit picker captures remain screenshot-only; native text is available for foreground capture. No denied/cancelled backend silently falls back to full-desktop or another target. Linux helper installation, extension enabling, or compositor config changes must be separate explicit actions.

The adapted native source preserves the upstream MIT notices and algorithms rather than substituting PowerShell or synthetic keyboard input. A hosted CI pass cannot establish real desktop permission, multi-monitor DPI, RDP-disconnected, or Wayland compositor behavior.

## Niri transport and setup boundary

Niri capture preserves T3's subscription-before-command order, exact caller-owned output path, window ID, completion event and metadata recheck. Identity drift retains pixels but omits metadata. Known ZenX process IDs are excluded before capture; null PIDs remain unknown. No compositor failure silently falls back to another target.

The action exists only while explicitly enabled for the current Composer. Production and development use distinct Zen-owned bus/interface/path names. Same-session bus callers are not authenticated physical key presses. Disable or leaving the Composer unregisters the action. ZenX never reads or changes the user's compositor configuration in this stage. Manual binding removal is the user's action; disabling the action is separate.

Cancellation closes owned request/event sockets and discards output. It cannot retract a ScreenshotWindow request already accepted by Niri; a late compositor write may fail or recreate a private temporary file after cleanup.

The exact dbus-next 0.10.2 dependency is patched during workspace postinstall and portable staging using reviewed original/final Git-blob hashes. The patch is the same as T3's: Node net supports path and abstract session sockets, and optional usocket/Unix-FD passing is removed. Only the pinned 17-package pure-JS closure is staged, with upstream licenses. Clean npm-ci and packaged import validation are required; changing the dependency version fails closed.

## Generic Wayland portal

A read-only support query checks Screenshot version >= 3 and AvailableTargets bit 8 without taking pixels. Explicit capture pins the service owner, subscribes before requesting target 8, handles an early response, and closes unfinished Request objects on cancellation/deadline. Missing capability opens the explicit chooser. Denial, cancellation, malformed replies and transport failures do not fall back.

Generic portal captures are pixels-only: no guessed application/window identity, no accessibility correlation, and no verified exclusion of ZenX itself. The portal owns its result file; ZenX bounded-reads but never deletes that file. Capture and shortcut sessions have separate connection-scoped Registry identities; installed desktop-entry identity and actual compositor permissions still need native acceptance. Production uses `io.github.albert_zen.ZenX`, development adds `.Development`. No desktop entry is installed automatically. Portals that require an installed entry can reject portable launches until the user installs a matching launcher.

GlobalShortcuts consent is requested only when the user explicitly enables the current Composer, and ConfigureShortcuts v2 only on its explicit button. A rejected/unassigned binding is not armed. Disable and Composer changes close owned requests and sessions; no permission is automatically granted or restored. When this ZenX Composer is already focused, its portal trigger opens the explicit chooser instead of taking pixels, preserving the local picker shortcut without interpreting localized shortcut descriptions. The preferred chord remains Ctrl+Shift+2; arbitrary chord preference editing is not implemented, but the desktop may choose another and its actual description is displayed.

## Verification

Focused checks: `node --import tsx --test apps/zenx/test/app-shot*.test.ts`.

Offline actual-component preview: `node apps/zenx/scripts/build-app-shot-preview.mjs /tmp/zen-app-shot-preview`, then open its `app-shot.html` (add `?mode=preview` for the captured state and `&theme=dark` for dark mode). All content and images in this fixture are synthetic. It does not use the capture backend or inspect real applications.

The `App Shot synthetic UI and native bridge` workflow combines focused contracts, production-component synthetic screenshots, and bounded native bridge probes:

- Ubuntu Chromium captures the real component in light/dark and desktop/narrow layouts, with authenticated CJK fonts. It checks picker, review, expanded image, cancel, reopen, explicit Attach without Send and Escape. PNGs, source SHA, geometry and browser lifecycle receipts are retained. Run after the builder with `node apps/zenx/scripts/capture-app-shot-preview.mjs /tmp/zen-app-shot-preview` in GitHub Actions. The existing preview helper uses a disposable profile and disables its browser sandbox; this is synthetic CI evidence, not a user browser.
- macOS executes the exported production JXA directly using `/usr/bin/osascript`, within the production two-second command budget. The null-window test requires the script's own expected refusal, so an invalid ObjC/CoreGraphics bridge fails instead of hiding behind the wrapper's generic error. Foreground metadata is checked only when the runner provides an exact title; missing foreground/title or a retired window is recorded as blocked. No arbitrary runner titles or PIDs are retained. Run with `ZENX_APP_SHOT_JXA_SMOKE=1 ZENX_APP_SHOT_JXA_EVIDENCE=/tmp/app-shot-jxa.json node --import tsx --test apps/zenx/test/app-shot-native-smoke.test.ts` on the macOS Actions runner.

Native smoke checks start/stop the modifier workers without injecting keys and read bounded Windows FFI/macOS JXA metadata. They never grant/reset Screen Recording, Accessibility or Input Monitoring permission. Passing metadata or worker lifecycle checks does not establish screenshot pixels, AX text, physical shortcut activation or full desktop acceptance. The native smoke does not create a controlled external window, so its positive metadata result is only an observation of the disposable runner; release acceptance still needs the controlled-window checks below. Embed reviewed Chromium screenshots from the matching commit in the PR before merge and label their synthetic data boundary.

Before release, perform native macOS/Windows acceptance with a disposable external window: deny permission, grant permission, capture with and without text, switch foreground during capture, close/rename the selected window, change Composer while capture is pending, repeat the shortcut, cancel review, attach and remove, then send to a test provider and inspect the admitted input. Repeat the picker on each supported Windows/Linux desktop. These native checks cannot be established by injected tests on a Linux build host.
