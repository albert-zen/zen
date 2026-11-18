# Sidebar: distinguish same-prefix child thread titles

This comparison is limited to the synthetic desktop sidebar scene, not a full-application grade or a statement that every CI workflow passed. The fixtures are production components rendered at 1280×900 in Chrome 157 with matching Noto families and no renderer errors/external requests.

[Baseline archive](https://github.com/albert-zen/zen/actions/runs/43712228532/artifacts/14161106654) contains exact clean `8e41230d04f0c3136b061b04786fb4f3eac5c5b5`, [candidate archive](https://github.com/albert-zen/zen/actions/runs/43716384083/artifacts/14162192622) exact clean `45ef57fe89f2b15330c73741d1d594ab18f9aebc`. Each has 12 main images. The adapter records canonical and visible label separately; same fixture content and controls.

| Scene                            | Before (original PNG)                      | After (original PNG)                      |
| -------------------------------- | ------------------------------------------ | ----------------------------------------- |
| EN / light at rest               | [PNG](./EN-Light-Same-Prefix-1-before.png) | [PNG](./EN-Light-Same-Prefix-2-after.png) |
| ZH / dark, Recent keyboard focus | [PNG](./ZH-Dark-Same-Prefix-1-before.png)  | [PNG](./ZH-Dark-Same-Prefix-2-after.png)  |

| Independent blind review of 24 originals | Before | After |
| ---------------------------------------- | -----: | ----: |
| Hierarchy                                |    7.5 |   7.5 |
| Readability / visible identification     |    6.5 |   7.5 |
| Attention                                |    7.0 |   7.5 |
| Consistency                              |    7.5 |   7.0 |
| Interaction cues                         |    7.0 |   7.0 |
| Overall for this scene                   |    7.0 |   7.4 |

The second title now exposes “… alternate review” while the first stays canonical. The meaningful suffix fitted without ellipsis in all 24 audited sibling appearances across the two sections and all locale/theme/focus conditions. Both states still show approval, Asking and menu cues; layout receipts preserve title/Asking/row bounds, focused menu hit and Composer clearance. The first title still truncates and the alternate loses its leading project context, reducing beginning-of-label consistency. Canonical actual text is intact, single and separate from the clipped display; no added tab stop. This is not screen-reader acceptance.

The synthetic thread titles themselves are English even in the Chinese UI, and the fixture focuses only the first sibling. Nonterminal differences, actual Chinese titles, opening the second row's action menu and native interaction remain N/O. Codex, Claude Code, Linear, T3 Code and DeepSeek Harness have no matched same-prefix task/state originals in this set; all reference dimensions N/O. Do not infer scores or rankings from unrelated examples.

The later exact `8a86e9539a9543d80af5801b3e67e8b1e4ab0692` correction only changed TypeScript test fixtures; no product pixels were meant to change. Its [fast typecheck](https://github.com/albert-zen/zen/actions/runs/43716904104) and [exact navigation revalidation](https://github.com/albert-zen/zen/actions/runs/43716904174) passed. Separate environment-dependent screenshot failures are not accepted evidence.
