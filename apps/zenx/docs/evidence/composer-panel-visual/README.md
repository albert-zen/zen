# Composer / right-panel visual evidence (code-level, not a screenshot)

Environment: isolated ZenX worktree, Electron 43, macOS. This evidence is **not** a claim of a running UI or an installed-app screenshot.

| Scenario                 | Before (`b494dfc`)                                                               | After (this branch)                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Closed panel hover       | 40px button at `top: 4px` reaches the 44px titlebar divider                      | 36px button at `top: 4px` stops 4px above divider                                                                          |
| Open panel close         | 28px close affordance vs 40px open affordance; both `panel-right`                | Both 36px; same `panel-right` glyph and 16px SVG                                                                           |
| Composer empty / short   | 16px corner, textarea reaches shell edge                                         | 22px corner (20px narrow), textarea 8px inset, equivalent text origin                                                      |
| Composer long / overflow | scrollbar at textarea edge, intersecting rounded shell                           | textarea scrollbar starts 8px below top and 8px before right edge; existing bounded height and auto-scroll logic unchanged |
| Focus                    | textarea suppresses default outline                                              | shell uses `:focus-within` ring; context indicator receives focus ring                                                     |
| Narrow layout            | icon-only composer control grows to min-width 44px while usage indicator is 30px | both 36px; mobile text size and existing breakpoints unchanged                                                             |

Run `node --test apps/zenx/test/composer-panel-visual.test.mjs` for source-level regression assertions. These checks do not verify pixel paint, real scrollbar behavior, dark/light theme appearance, or keyboard interactions. Real before/after captures and those checks remain pending: the isolated Electron build exits before opening a window (`GPU process isn't usable`, `SIGTRAP`), both in default and escalated launch with `--disable-gpu`. No personal ZenX state was used; the test launch used `/tmp/zenx-visual-only/{user-data,core}`. Do not present this table as a screenshot or a functional walkthrough.
