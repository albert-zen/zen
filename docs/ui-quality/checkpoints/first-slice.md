# First implementation slice

Baseline: d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a.

## Evidence-led changes

- Unconfigured Account now offers an explicit route to existing model settings,
  moving keyboard focus to that settings tab. No sign-in or provider mutation.
- PAW onboarding remains available and dismissible, but uses a secondary action
  and a quieter inset-free composition. Current threads retain visual priority.
- Appearance preset/accent descriptions use the existing caption type token
  rather than 8px text. Selected choices receive a non-color check marker.
- Empty Information retains its heading and explains the existing Customize
  action. The hint requires a fresh matching-owner receipt and no visible cards,
  error, pending edit or edit mode. It does not claim that sources do not exist.

## Verification

259 focused tests passed: 236 UI tests across 18 files and 23 protected composer /
virtual-scroll tests across 5 files. Prepared node/web typecheck and production
build passed. Added behavior tests were observed failing before implementation.
See the adjacent verification report for commands and limits. This is not a full
application-suite pass or proof of every platform integration.

Nine baseline native screenshots were independently reviewed by Sol and Terra.
Frozen production-component fixtures were subsequently rendered in native
Electron to inspect pending steer, process composition and Fork feedback. The
fixture result is not evidence of actual delivery, persistent Fork creation or
real agent communication. Baseline/source manifests preserve that distinction.

Matched candidate screenshots and independent challenge review are the next
checkpoint. Unobserved journeys remain open, including real agent communication,
full-app Fork boundary, narrow settings and comprehensive auto-scroll behavior.

## Protected behavior

No changes to App routing/state, ThreadView, queue/steer/pending logic, scrolling,
Host protocol, providers or stored conversation authority. Concurrent #747/#748
work must be reconciled before any merge. No PR or merge is part of this save.
