# Round-six source-derived contrast inspection

Source: `e75a1db1a3457057a23b40a0bf1e8ae6a9feceab`, `/workspace/scratch/72527d3ea90a/ui-quality-iteration`.

## Result

**The suspected faint ordinary dark secondary copy is not a demonstrated contrast defect.** General, Account and the new provider cards use opaque text on known opaque surfaces; their relevant normal text pairs exceed 4.5:1 in every inspected mode/preset/accent/contrast combination.

There are narrower, measurable source-level gaps worth validating after the frozen native capture:

1. Selected Appearance preset/accent supporting descriptions in Dark / Graphite / Standard: 4.10–4.26:1.
2. Actual dark select backgrounds, unlike the inset surface tested today, have some boundary ratios below 3:1.
3. Light error banners composite the danger tint under danger text, producing 4.25–4.49:1 in the inspected Settings placements. High contrast does not change these colors.

These are mathematical source-pair observations, **not native computed-style measurements, visual scores, WCAG conformance determinations or assistive-technology certification**. Border ratio alone is not classified as a WCAG failure: text, chevrons, thumb position, checkmarks and other identification cues must be considered.

No source edits, broad tests/typechecks, CUA, capture-build changes, real accounts or external requests were made. No other reviewer scores were read.

## Method and scope

- Read current `theme.css`, matching `styles.css` selectors and current SettingsView / SubscriptionUsageCard markup. Resolve root declarations in source order for all 36 combinations: Light/Dark × Graphite/Cobalt/Ember × Azure/Iris/Jade × Standard/High. High overrides muted text/control borders after presets; it does not replace all colors.
- Resolve compatibility aliases: `--text`/`--text-1` → primary; `--text-2` → secondary; `--text-3` → muted; `--surface` → surface; `--surface-inset` → inset; `--main` → main; `--border-control` → control border; `--border-soft` → subtle border; `--accent-soft` → translucent accent tint.
- For opaque values use exact sRGB hex channels. For alpha layers calculate `C = alpha × foreground + (1-alpha) × background` in sRGB channel space, then linearize channels with the 0.04045 breakpoint and luminance weights 0.2126/0.7152/0.0722. Contrast = `(Lmax + .05)/(Lmin + .05)`. Ratios use unrounded composite channels; displayed composite hex is rounded for readability.
- `color-mix(in srgb, danger 55%, border)` uses its explicit sRGB weighted mix. Accent-soft / danger-soft values are alpha colors, not opaque token strings.
- Visible non-disabled content is considered, with opacity 1. Disabled buttons/selects intentionally use .45/.5 opacity; they are not treated as enabled text failures. System resolves to Light or Dark and is not an additional palette.
- Font anti-aliasing, display brightness/color management, scaling, font substitution, actual pointer/focus state and native form drawing are not simulated. Explicit focus colors are measured, not focus-ring thickness/area or occlusion. UA input placeholder color is not claimed as resolved by this source analysis.

Reproduction files (read-only calculation, not a product test run): `round-six-contrast-calc.py`, full 36-state `round-six-contrast-values.json`, and `round-six-contrast-values.txt`, beside this report.

## Actual selector/background mapping

All paths below are under `apps/zenx/src/renderer/src/`.

- `styles.css:1429–1434` `.workspace` paints `--color-surface-main`. The Settings `.page-scroll`/`.settings-panel` are transparent. Section titles inherit body primary (`299`); header descriptions (`3545`) use muted on main. Footer `.settings-view > .settings-apply-bar` (`8999–9007`) explicitly paints main, overriding the earlier dirty alpha background. Do not calculate the visible footer against that obsolete earlier background.
- `.settings-card` (`3552–3559`) and `.provider-profile-card` (`3807–3817`) paint surface. `.settings-card h3`, `.settings-row strong` inherit primary; `.settings-card p`, `.settings-row span`, `.settings-card-head span` (`3598–3604`), `.settings-note` (`4426`), `.status-muted` (`4439`), `.field` / `.field small` (`3259–3277`) use muted. General explanatory disclosures (`9353`) use secondary, while their card paragraphs can still receive the more specific muted paragraph rule.
- Account uses those card/row rules. Signed-in `.status-good` (`4431`) uses success with `!important`, overriding the generic muted header-span rule. Quota error `.settings-card .quota-error` (`7393`) uses danger on the opaque card, with no danger-soft fill. This is different from the tinted error-banner case below.
- Provider full names (`3844`) use primary on surface. Type badges, local/API-key status and “more” text use muted. Model count summary (`3870`) uses secondary on surface. Full ID preview/list (`3885–3894`) uses secondary on inset. Provider Default/Title pills (`3928–3932`) use accent text on accent-soft over surface, not muted text. These role labels pass the text target in every inspected state.
- General native inputs (`3278` + Settings override `3619`) use primary on inset with control border. The Default project `.readonly-field` (`3298`) instead uses secondary on code. Shared Select/Combobox triggers `.ui-select` (`8797`) use primary on control; `:hover:not(:disabled)` (`8822`) paints control-hover. Therefore the existing test's border-versus-inset measurement does not fully cover actual selects.
- Secondary buttons use secondary on elevated and strong border (`3072–3092`). Primary buttons use on-accent over accent (`3093`). Quiet buttons are transparent with secondary text. General/Account/Models focus uses focus-ring at `319`; Settings input focus also replaces the border (`3650`). Open `.ui-select` uses focus-ring (`8828`).
- Appearance unselected preset/accent/contrast controls use muted on inset. Selected controls paint accent-soft over the enclosing surface and primary label text (`4310–4316`). However `.appearance-preset-options small` (`4305`) and `.appearance-accent-options small` (`4353`) explicitly remain muted, even inside selected controls. Their specificity overrides inherited selected primary text.

## Graphite / Azure exact pairs

S = Standard; H = High. Ratios below are source-derived.

| Pair                                      | Light S | Light H | Dark S | Dark H |
| ----------------------------------------- | ------: | ------: | -----: | -----: |
| Primary text / card                       |   15.89 |   15.89 |  15.87 |  15.87 |
| Secondary text / card                     |    7.51 |    7.51 |   8.85 |   8.85 |
| Muted explanatory text / card             |    5.44 |    7.18 |   5.34 |   8.37 |
| Muted header/footer text / main           |    5.17 |    6.82 |   5.75 |   9.01 |
| Muted text / inset                        |    4.90 |    6.46 |   5.58 |   8.74 |
| Provider model IDs (secondary / inset)    |    6.76 |    6.76 |   9.25 |   9.25 |
| Primary select text / control             |   15.23 |   15.23 |  15.39 |  15.39 |
| Control border / input inset              |    3.08 |    4.31 |   3.02 |   4.60 |
| Control border / select control           |    3.28 |    4.59 |   2.81 |   4.27 |
| Control border / hovered select           |    3.05 |    4.27 |   2.44 |   3.71 |
| Focus ring / card                         |    7.51 |    7.51 |   8.85 |   8.85 |
| Secondary button text / elevated          |    6.88 |    6.88 |   8.41 |   8.41 |
| Primary button text / accent              |    4.85 |    4.85 |   8.20 |   8.20 |
| Selected Appearance supporting small text |    4.63 |    6.10 |   4.26 |   6.67 |
| Default/Title pill text / accent-soft     |    5.41 |    5.41 |   8.54 |   8.54 |

Corresponding Graphite values:

- Light: main #f5f6fa; surface #fbfcff; inset #eef0f5; control #f6f7fb; control-hover #eceff6. Primary #1c2029; secondary/focus #4d5361; muted S #616878, H #4f5665; control-border S #7f899f, H #667187.
- Dark: main #0d0e11; surface #15171c; inset #101217; control #181a20; control-hover #222630. Primary #f0f1f3; secondary/focus #b4b6bd; muted S #898c96, H #aeb1ba; control-border S #5b6170, H #777e8d.
- Azure accent-soft: Light rgb(82 111 185 / 13%), composite over card ≈ #e5eaf6. Dark rgb(142 169 255 / 13%), composite over card ≈ #252a3a.
- High changes neither the primary/secondary text values nor these surfaces/alpha backgrounds; it strengthens muted text and the control/subtle borders.

Across all 36 states: primary/card minimum 15.35; secondary/card 7.38; muted/card 5.34; muted/main 5.17; muted/inset 4.88; model-ID secondary/inset 6.60; focus/card 7.43; focus/inset 6.54. Thus no source evidence supports globally brightening ordinary General/Account/Models description text.

## Narrow source-level issues and exact affected combinations

### 1. Selected Appearance descriptions

Dark / Graphite / Standard only; all three accents:

- Azure: muted #898c96 over composite ≈ #252a3a → **4.2592:1**.
- Iris: same text over 14% Iris tint → **4.1631:1**.
- Jade: same text over 13% Jade tint → **4.0981:1**.

Examples are Neutral/Cool/Warm and Clear blue/Soft violet/Fresh green (or Chinese translations) within the selected preset/accent options. Labels/checkmarks themselves remain primary and pass. Cobalt/Ember, all Light states, and High states pass this text pair. The current `appearance.test.ts` matrix checks muted against sidebar/main/surface, not selected alpha-composited controls.

**Small next candidate:** use an already-existing readable text role specifically for supporting descriptions in selected Appearance controls, while retaining muted for unselected descriptions, the existing accent tint and primary labels. Avoid globally changing muted text or flattening surfaces. Verify every composite combination before choosing the exact selector/token change.

### 2. Select/control boundaries (not an automatic WCAG failure)

- Dark / Graphite / Standard, any accent: control border #5b6170 against control #181a20 = **2.8065**; against hover #222630 = **2.4415**; against outer card #15171c = **2.8933**.
- Dark / Ember / Standard, any accent: border #7c6659 against hover #302219 = **2.8511**. Resting select passes.
- Light / Graphite / Standard: readonly-field border against code = **2.9688**. This is a read-only value, not automatically a failed interactive-control boundary.
- High resolves the first two select cases above. Focus rings remain strong. Text and chevrons still identify the controls; no conformance claim follows solely from these border numbers.

Existing `appearance.test.ts:197–293,322–394` uses border-control/inset, which passes even in dark Graphite (3.0231), and therefore misses the actual select/control-hover pair. A later bounded candidate can adjust the control-boundary role for affected states or the actual control treatment, keeping backgrounds and semantic hierarchy unchanged; select a value only after reviewing native appearance and both adjacent surfaces.

### 3. Light tinted error banners

`.settings-error` (`4452`) paints danger-soft and danger text. For a plain banner inside a card, e.g. current AccountPanel's inline operation error (`SettingsView.tsx:1338–1342`) or provider editor error, the exact light ratios are Graphite **4.4633**, Cobalt **4.4890**, Ember **4.4193**. For a plain top-level banner over main, e.g. Models/Settings operation errors, ratios are Graphite **4.2511**, Cobalt **4.2984**, Ember **4.3393**. All accents and Standard/High are affected because neither accent nor High changes the danger tokens. This excludes `.settings-empty.settings-error`, whose later empty-state styles change the pair, and excludes quota's unfilled `.quota-error`.

Graphite example: #b74742 over rgb(183 71 66 / 10%) composited with #fbfcff ≈ #f4eaec → 4.4633. On untinted card, the same text is 5.1259:1. A follow-up should test the composed banner, not only danger text on card; preserve error semantics and avoid broad status recoloring without native review.

### Additional low boundary/graphic measurements, not prioritized as text defects

- Subtle card/type-badge borders intentionally range near 1.13–1.57 against Graphite cards; they separate surfaces and are not all required control-identification edges. Do not make every divider 3:1.
- Selected Azure border against its tinted interior can be 2.89 in dark Graphite and 2.71 in dark Cobalt, including High. Visible primary checkmarks and selected labels are separate cues; focus is still strong.
- General `.plugin-switch` checked knob #f4f6ff over dark accent has 2.10:1 (Azure), and as low as 1.628:1 (Jade), unchanged by High; off knob/track is at least 4.52:1. Knob position, track and outer boundary also identify state. This is a source measurement for native/control review, not a declaration that the switch is unusable or nonconformant.
- Light danger-button mixed border is 2.77 against danger surface, but its visible danger text passes 4.81 and the control has other cues.

## Follow-up validation, after current capture is frozen

1. Add deterministic alpha-composited selected-control text assertions to the existing theme matrix: every preset/accent/mode/contrast; assert supporting text >=4.5 while preserving distinct primary/muted roles.
2. Extend control-boundary pairs to actual `surface-control`, `surface-control-hover` and outer card, rather than inset alone. Keep normative classification separate from the numerical guard; investigate the readonly case separately.
3. Add error text against danger-soft composited over main and card. Use source floats until final contrast calculation, rather than rounding intermediate composite RGB.
4. Use controlled component fixtures for selected Appearance and banner errors. In the native candidate, capture/get computed foreground, background, border and opacity for the exact nodes and ancestors, in dark Graphite Standard and High plus light error states. No real sign-in or permissions are needed.
5. Visually inspect focus indicator visibility/area, native checkbox/switch state, text at actual scaling and forced-colors separately. Source ratios do not replace those checks.

Source hashes: theme.css `14dd5b966908bc0a630044169fc7cba7ffcfdc495c09d7a4c85829ca9c4c4497`; styles.css `50e4af7b5679a6217c95863bd85106b70f11dbdfb79a26e3e3709b438fb35b9a`.
