# Delivery check feedback implementation

Scope: renderer delivery-check feedback and exact-identity reconciliation. Native final-version validation and independent recheck are recorded separately when available.

## Result

- Each exact pending input now exposes Checking delivery progress, then a qualified completed/unavailable/failed result. Completed unknown reads say “Check completed. Delivery is still unconfirmed.” Admitted rows retain admission wording instead.
- Feedback is local to the mounted input and its admission state. Same-frame repeat checks are fenced. Row removal, thread changes and late admission retire older feedback; errors are announced only on the requested input.
- The renderer callback explicitly distinguishes a usable read from unavailable/stale results. It previously returned void for both success and skipped reads.
- An independent review exposed a pre-existing full-read/window-cache issue. A same/newer cached 20-turn window can omit the exact older client ID in a full read. The callback now reconciles that full read's exact pending-copy identities without replacing the newer cached projection. It uses the existing exact-only reducer, not concatenated history or a new compaction/submission authority.
- No backend protocol, persistence, automatic resend, generic absence-based removal, or late canonical outcome authority changed. The full-read supplement only removes exact pending copies; other composer fields still reconcile from the existing selected projection.

## Owned file manifest

1. `apps/zenx/src/renderer/src/PendingSendRows.tsx`: local keyed check action/feedback.
2. `apps/zenx/src/renderer/src/App.tsx`: read-result signaling and full-read exact-copy reconciliation.
3. `apps/zenx/src/renderer/src/composer-state.ts`: export the existing exact-only pending-copy reconciliation function; reducer logic unchanged.
4. `apps/zenx/src/renderer/src/ThreadView.tsx`: callback return type only; Fork label edits preserved.
5. `apps/zenx/src/renderer/src/i18n/shell.ts`: English and Chinese progress/result/error strings.
6. `apps/zenx/test/pending-send-check.test.ts`: nine semantic/lifecycle/authority tests.
7. `apps/zenx/test/app-project-picker-interaction.test.ts`: three real App callback/window regressions.
8. `apps/zenx/test/thread-view-component.test.ts`: align the existing stale-thread test callback type.
9. `apps/zenx/docs/ui-ux.md`: five-line clarification in Immediate ordinary Send feedback.
10. `ARCHITECTURE.md`: disposable delivery-check feedback boundary paragraph.

CSS changes belong to the readability worker. App.tsx was identical to the requested #748 comparison commit before this scoped change. No sidebar, read-position or fullscreen hunk was changed.

## Verification

- Initial TDD: 7 failures / 1 pass before feedback implementation; 8/8 after.
- Window authority TDD: both same-watermark and newer-cache App tests failed before the scoped fix; both passed after, preserving the newer canonical output and bounded window.
- Final bounded production App regression: 8/8 passed.
- Delivery/composer/immediate-send/compaction regression after final authority change: 40/40 passed.
- ThreadView/composer/delivery regression before the final narrow App/helper-export change: 142/142 passed.
- Final ZenX node and web TypeScript checks passed.
- Formatting and git diff whitespace checks passed.
- Full App run did not complete: it passed 112 tests then its process received SIGKILL at the existing 5000-turn performance case. A diagnostic repeat confirmed SIGKILL. This is not an identified assertion/product failure, and no full-suite success is claimed.
- No CUA, commit, push or full repository aggregate check performed by this worker.

## Evidence files

All beneath `/workspace/shared/ui-quality-evidence/`:

- `delivery-check-before.tap`, `delivery-check-after.tap`
- `delivery-check-window-before.tap`, `delivery-check-window-after.tap`
- `delivery-check-app-bounded.tap`, `delivery-check-authority-regression.tap`
- `delivery-check-regression.tap`
- `delivery-check-typecheck-final.log`, `delivery-check-format-final.log`
- `delivery-check-app-regression.tap`, `delivery-check-app-regression-repeat.tap` (incomplete full-run diagnostics)

## Frozen production hashes

- App.tsx: `24c6dd569c4bed05c8a9d99d4cca17f4e1282d7ca989785be6f543e1376f78ca`
- PendingSendRows.tsx: `7b840faf88e5ec16d33d93c9f8b3918fda03d02b884e878b477178d853073494`
- composer-state.ts: `12029d3de5740daa97c121adf8f76b5b1dd1db13cdbce261d13b61c7363d39db`
- ThreadView.tsx: `4b4d86f975466e56419e203a074afaeec01405ce2c689bd519ab7309bd64ca5a`
- i18n/shell.ts: `e7dab053ca6143202413d22d091fb8f5742ae7742a7871cfa0483893a727e67d`
