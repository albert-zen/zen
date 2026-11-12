# Independent source review: contrast follow-up

Reviewed immutable `e31f0936328ea14d29de3ff4917dce1e96cb2e7e` against
`c4fb90f3a3931195f64384ab088a111e35ddc995` in a separate reviewer context.
No introduced blocking correctness defects were found. No target score or earlier
scorecard was supplied. This is source review, not a visual score or native
acceptance.

## Independently verified

- Exactly three tracked paths changed: `styles.css`, `theme.css`, and
  `appearance.test.ts`.
- Checked Appearance selectors match production `SettingsView.tsx` markup.
  Specificity overrides existing small-description rules without changing
  unchecked text, checkmarks, keyboard focus or layout.
- The new danger-soft foreground is defined in both resolved modes and stays
  within the existing semantic theme system.
- All 36 resolved theme combinations were recalculated. Minimum selected-copy
  contrast is **6.184:1**, Light / Cobalt / Iris. Minimum tested danger-soft copy
  is **4.908:1**, Light / Graphite over main. These are mathematical token-pair
  results, not rendered accessibility certification.
- `AGENTS.md`, relevant `ui-ux.md` Appearance/acceptance rules and `themes.md`
  were read.

## Checks

- `appearance.test.ts`: **11/11 passed**.
- `theme-source-policy.test.ts`: **6/6 passed**.
- Prettier on all three changed paths: passed.
- `git diff --check`: passed.

## Nonblocking evidence limitation

`appearance.test.ts:386–460` verifies source regexes and root tokens, not the
rendered cascade or every `settings-error` context. For example, existing
`.settings-card p` has higher specificity than `.settings-error`, and existing
`.settings-empty` can override color/background on the combined class used in
`SettingsView.tsx:1049`. These are inherited behaviors, not regressions introduced
here. Do not claim every `settings-error` instance uses the new token. A rendered
regression should exercise paragraph/card and combined-class contexts separately.

No browser/Electron operation, screenshot verification, whole-app acceptance or
WCAG conformance is claimed. The reviewer made no edits or commits and rebuilt
no frozen outputs.
