# Desktop UI evidence: sidebar consistency and expanded output

Two independent, local-scene comparisons, not a whole-app score. All attached PNG files are unmodified GitHub Actions originals of production components with synthetic data at 1280×900 in Chrome 157.0.8103.50. No renderer errors or external requests. Native interaction and visual review are separately scoped.

## Sidebar approval at rest and focus

Baseline `99f713abab81d077a6f5241de7eaf57c84f82573`; candidate `cdca3cc15879d066c36b48239f8a262096630c1f`. Matched Noto families. [Baseline archive](https://github.com/albert-zen/zen/actions/runs/43708053433/artifacts/14158803966) and [candidate archive](https://github.com/albert-zen/zen/actions/runs/43711728028/artifacts/14161076034) contain 12 originals each, including both locales and themes, at rest and keyboard focus in Project and Recent.

| Rest                     | Before                              | After                              |
| ------------------------ | ----------------------------------- | ---------------------------------- |
| English, light           | [PNG](./EN-Light-Rest-1-before.png) | [PNG](./EN-Light-Rest-2-after.png) |
| Simplified Chinese, dark | [PNG](./ZH-Dark-Rest-1-before.png)  | [PNG](./ZH-Dark-Rest-2-after.png)  |

| Blind review, mean across four matched groups | Before | After |
| --------------------------------------------- | -----: | ----: |
| Hierarchy                                     |    7.5 |   8.0 |
| Readability                                   |    7.0 |   7.5 |
| Attention                                     |    7.5 |   8.0 |
| Rest/focus consistency                        |    7.0 |   8.0 |
| Interaction cues                              |   7.25 |  7.25 |
| Overall for this scene                        |   7.25 |  7.75 |

Independent reviewer examined all 24 originals and preferred the candidate in all four groups. Compact approval appears both at rest and in focus; full wording is retained, with model/title in the existing detail. Asking and title widths, focused menu hit, Composer geometry and draft remain unchanged. The shorter copy is less explicit about who must act, and matching-prefix titles still cannot be distinguished consistently without details. Actual opened menu contents and screen-reader output were not verified. Separate legacy approval-only and combined capture steps both passed.

## Expanded tool output reading

Baseline `cdca3cc15879d066c36b48239f8a262096630c1f`; candidate `8e41230d04f0c3136b061b04786fb4f3eac5c5b5`. English desktop with identical pinned Noto assets and capture harness. [Ordinary baseline](https://github.com/albert-zen/zen/actions/runs/43711727966/artifacts/14160384616) and [ordinary candidate](https://github.com/albert-zen/zen/actions/runs/43712228506/artifacts/14161510772); [nested baseline](https://github.com/albert-zen/zen/actions/runs/43711727966/artifacts/14161210729) and [nested candidate](https://github.com/albert-zen/zen/actions/runs/43712228506/artifacts/14161440936). Ordinary and nested are separate fixture states, not interchangeable.

| Expanded | Before                                             | After                                             |
| -------- | -------------------------------------------------- | ------------------------------------------------- |
| Light    | [PNG](./EN-Light-Tool-Output-1-before-cdca3cc.png) | [PNG](./EN-Light-Tool-Output-2-after-8e41230.png) |
| Dark     | [PNG](./EN-Dark-Tool-Output-1-before-cdca3cc.png)  | [PNG](./EN-Dark-Tool-Output-2-after-8e41230.png)  |

| Independent blind review | Before | After |
| ------------------------ | -----: | ----: |
| Hierarchy                |    8.5 |   8.5 |
| Readability              |    7.0 |   8.0 |
| Attention                |    8.5 |   8.0 |
| Consistency              |    7.5 |   8.0 |
| Interaction cues         |    7.0 |   7.0 |
| Overall for this scene   |    7.7 |   8.0 |

The reviewer examined all 18 selected originals and modestly preferred the change: actual output separates more clearly from input/exit metadata, particularly in dark mode, and the answer still dominates. Tradeoff: short output wraps earlier and long light output fits approximately one fewer row; inner scroll range 699→774 px at unchanged 259 px viewport. No horizontal overflow; measured output-end and answer continuation still pass. Both collapsed controls were RGB-identical, not a redesign of compact trace. No native or accessibility acceptance is implied.

**References:** Codex, Claude Code, Linear, T3 Code and DeepSeek Harness all N/O in each dimension for both scenes; no matching task/state originals to compare. Do not rank products across unlike tasks.
