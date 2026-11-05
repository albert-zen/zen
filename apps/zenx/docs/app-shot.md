# App Shot

Use the computer icon beside the Composer attachment button, or press Cmd/Ctrl+Shift+2 while the Composer has focus. Select a window, review the screenshot and captured context, then choose **Attach to draft**. Sending remains a separate action. Review captures are staged only in bounded process memory (four previews per renderer and 40 MiB across the Host, expiring after five minutes). Cancel or leave the Composer to discard them; only explicit Attach writes to the existing attachment store.

On macOS, the optional checkbox reads bounded accessibility text from the exact selected window. This can include text outside the screenshot. A failed or unavailable read is marked screenshot-only; the application is never clicked, activated or typed into by this capture path. macOS Screen Recording and, for text, Accessibility permission are controlled by the OS.

The macOS global Cmd+Shift+2 checkbox binds capture to that Composer only. Switch to an external app and press the shortcut; ZenX identifies and captures the foreground window before returning to the review dialog. Leaving or disabling that Composer releases the shortcut. This setting does not persist across restarts. Existing global shortcut conflicts fail visibly.

## Upstream reference and scope

The reference is T3 Code `337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17`:

- [Setup and user behavior](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/docs/user/snap-shot.md)
- [Native capture](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot/DesktopSnapShot.ts)
- [Draft delivery](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/web/src/components/desktop/SnapShotCoordinator.tsx)

T3 uses direct active-window capture on macOS/Windows, a default both-Shift shortcut, optional accessibility trees/text, and Linux compositor helpers/picker support. Its `RegionSnapShot` class captures the Windows active-window bounds; it is not an interactive crop tool. T3 may upload an attachment to a connected server before Send. ZenX keeps this feature's capture local until ordinary Send and uses its existing attachment transfer path.

This implementation is deliberately not full platform parity. Windows/Linux use Electron's window selection and screenshot support; they do not have new native AX readers or global shortcut capture. macOS uses bounded text rather than a rich control tree. There is no double-Shift key hook, persistent shortcut preference, pending-capture recovery store, sound/flash animation, or own-ZenX-window capture. None of these omissions are silently emulated with full-desktop or current-focus fallback.

## Verification

Focused checks: `node --import tsx --test apps/zenx/test/app-shot*.test.ts`.

Offline actual-component preview: `node apps/zenx/scripts/build-app-shot-preview.mjs /tmp/zen-app-shot-preview`, then open its `app-shot.html` (add `?mode=preview` for the captured state and `&theme=dark` for dark mode). All content and images in this fixture are synthetic. It does not use the capture backend or inspect real applications.

The `App Shot synthetic UI and native bridge` workflow adds two independent checks:

- Ubuntu Chromium captures the real component in light/dark and desktop/narrow layouts, with authenticated CJK fonts. It checks picker, review, expanded image, cancel, reopen, explicit Attach without Send and Escape. PNGs, source SHA, geometry and browser lifecycle receipts are retained. Run after the builder with `node apps/zenx/scripts/capture-app-shot-preview.mjs /tmp/zen-app-shot-preview` in GitHub Actions. The existing preview helper uses a disposable profile and disables its browser sandbox; this is synthetic CI evidence, not a user browser.
- macOS executes the exported production JXA directly using `/usr/bin/osascript`, within the production two-second command budget. The null-window test requires the script's own expected refusal, so an invalid ObjC/CoreGraphics bridge fails instead of hiding behind the wrapper's generic error. Foreground metadata is checked only when the runner provides an exact title; missing foreground/title or a retired window is recorded as blocked. No arbitrary runner titles or PIDs are retained. Run with `ZENX_APP_SHOT_JXA_SMOKE=1 ZENX_APP_SHOT_JXA_EVIDENCE=/tmp/app-shot-jxa.json node --import tsx --test apps/zenx/test/app-shot-native-smoke.test.ts` on the macOS Actions runner.

Neither check grants or resets Screen Recording/Accessibility permission. JXA metadata success does not establish screenshot capture, AX text, a native shortcut or full macOS acceptance. The native smoke does not create a controlled external window, so its positive metadata result is only an observation of the disposable runner; release acceptance still needs the controlled-window checks below. Embed reviewed Chromium screenshots from the matching commit in the PR before merge and label their synthetic data boundary.

Before release, perform native macOS acceptance with a disposable external window: deny permission, grant permission, capture with and without text, switch foreground during capture, close/rename the selected window, change Composer while capture is pending, repeat the shortcut, cancel review, attach and remove, then send to a test provider and inspect the admitted input. Repeat the picker on each supported Windows/Linux desktop. These native checks cannot be established by injected tests on a Linux build host.
