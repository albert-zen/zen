# Sidebar: concurrent approval and question

This is a **scene-specific comparison**, not a whole-app grade or a claim that the required CI suite passed. The product before `a5d26300bad72bcf1da0880df65d1c72b7b79bc1` and after `99f713abab81d077a6f5241de7eaf57c84f82573` used the same evidence harness and synthetic conversation. Each captures actual production components in desktop Chrome 157.0.8103.50, 1280×900, with matching Noto family lists, no renderer errors or external requests, across both themes and locales at rest and with native Tab focus on Project and Recent rows. Different GitHub runners; this is not Electron or full-app verification.

| Scenario                                        | Baseline PNG                                      | Candidate PNG                                   |
| ----------------------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| English, light, Project keyboard focus          | [Before](./EN-Light-Project-1-before-a5d2630.png) | [After](./EN-Light-Project-2-after-99f713a.png) |
| Simplified Chinese, dark, Recent keyboard focus | [Before](./ZH-Dark-Recent-1-before-a5d2630.png)   | [After](./ZH-Dark-Recent-2-after-99f713a.png)   |

The four files here are unmodified originals. Full 12-image sets and receipts: [before](https://github.com/albert-zen/zen/actions/runs/43706624728/artifacts/14158875981), [after](https://github.com/albert-zen/zen/actions/runs/43708053433/artifacts/14158803966). The two pictured cases are not a controlled comparison of theme alone. Inspect the actual combined-attention step and artifact, not just the enclosing workflow status.

| Independent blind review | Before | After |
| ------------------------ | -----: | ----: |
| Hierarchy                |    7.2 |   7.5 |
| Readability              |    6.7 |   7.2 |
| Attention                |    7.1 |   7.5 |
| Consistency              |    7.3 |   7.0 |
| Interaction cues         |    7.0 |   7.2 |
| Overall for this scene   |    7.1 |   7.3 |

Both notices were already visible. The compact approval is easier to scan on the focused row (English 110.73→84.06 px; Chinese 72.02→36.02 px); the full title and model remain in details. Asking and title budgets were unchanged, as were the menu center hit, the draft, and Recent detail clearance over the Composer (8.03 px). Menu activation was not tested. Matching-prefix titles are still hard to distinguish, the Project focus outline still looks interrupted, and the row changes copy/density when focus leaves. Keep the direction, resolve rest/focus inconsistency first, and test title recognition separately.

No matched concurrent approval/question screenshot is available in this evidence set for Codex, Claude Code, Linear, T3 Code, or DeepSeek Harness: all five dimensions **N/O** for each. No score or ranking is inferred from a different task. Zen's existing Room filename disambiguation is a design lead, not proof that the sidebar titles are solved.
