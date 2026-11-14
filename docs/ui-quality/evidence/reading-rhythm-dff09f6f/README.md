# Rejected desktop reading-rhythm experiment

**Decision: do not retain the global line-height change.** Candidate `dff09f6f` reduced desktop assistant copy from 27px to 24.75px at the unchanged 15px type size. The product CSS, UI specification and targeted test are restored exactly to their pre-experiment `745389d3` blobs. This report preserves the experiment, not a claim of shipped improvement. Existing subagent density improvements remain intact.

## Why reject it

An independent reviewer saw anonymous X/Y full-frame sets, no code, version order or target score. X was the candidate and Y the baseline. The reviewer slightly preferred X for same-screen context, but gave the spacious Y a 0.5 readability advantage in both light and dark prose-top views. Most other criteria were unchanged. A static preference for seeing more content is not a sufficient net benefit to reduce the comfort of the core long-reading task.

Table/code and Information-open frames improved attention scores by 0.5, but the change simultaneously affected paragraphs, lists and code that inherits line-height. It does not isolate which region caused the benefit. Do not retain a code-only variant on this evidence without testing that variant separately. [Full original blind report](BLIND-REVIEW.md).

## Measurements and boundaries

- Type remains 15px; main column remains 800px, or 593px with Information open; Composer remains 108px high and in the same position.
- Body leading 27→24.75px. Full prose block about 1955.77→1859.47px; with Information open 2198.77→2082.22px.
- Table height remains 168.19px. Code card **does change through inherited leading**, 226.59→211.30px; it must not be described as unaffected.
- Heading/list and table/code captures scroll to content anchors, so their scroll offsets differ (e.g. table/code 782→744px). Do not treat every pixel displacement as same-scroll-position evidence.
- 6.30-second build, 50.26-second capture, no renderer errors or external requests. These are production-component Chrome images with synthetic data, not native Electron, real Host or interaction acceptance.
- [Exact geometry](geometry.json), [source/image hashes and anonymous mapping](receipt.json).

## Scores: baseline Y → rejected candidate X

| Scene                  | Hierarchy | Readability | Attention | Consistency | Discoverability |
| ---------------------- | --------: | ----------: | --------: | ----------: | --------------: |
| Light prose top        |       8→8 |       8.5→8 |       8→8 |         8→8 |             7→7 |
| Dark prose top         |       8→8 |       8.5→8 |       8→8 |         8→8 |         6.5→6.5 |
| Light headings/list    |       8→8 |         8→8 |       8→8 |         8→8 |             7→7 |
| Dark headings/list     |       8→8 |         8→8 |       8→8 |         8→8 |         6.5→6.5 |
| Light table/code       |   7.5→7.5 |         8→8 |     7.5→8 |         8→8 |             7→7 |
| Dark table/code        |   7.5→7.5 |     7.5→7.5 |     7.5→8 |         8→8 |         6.5→6.5 |
| Light Information open |   7.5→7.5 |         8→8 |     7→7.5 |         8→8 |             7→7 |
| Dark Information open  |   7.5→7.5 |         8→8 |     7→7.5 |         8→8 |         6.5→6.5 |

Subjective 0–10 scene judgments, not an application score or a comparison with other reviewers' historical scales. No average is computed.

## All matched original product images

Left is baseline/restored appearance, right is rejected experiment. The rollback is verified by exact source blob restoration, not falsely described as a new post-rollback screenshot run.

### light: prose-top

| Baseline                                                                | Rejected candidate                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| ![baseline light prose-top](before/reading-desktop-light-prose-top.png) | ![candidate light prose-top](reading-desktop-light-prose-top.png) |

### light: heading-list

| Baseline                                                                      | Rejected candidate                                                      |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ![baseline light heading-list](before/reading-desktop-light-heading-list.png) | ![candidate light heading-list](reading-desktop-light-heading-list.png) |

### light: table-code

| Baseline                                                                  | Rejected candidate                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| ![baseline light table-code](before/reading-desktop-light-table-code.png) | ![candidate light table-code](reading-desktop-light-table-code.png) |

### light: information-reading

| Baseline                                                                                    | Rejected candidate                                                                    |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ![baseline light information-reading](before/reading-desktop-light-information-reading.png) | ![candidate light information-reading](reading-desktop-light-information-reading.png) |

### dark: prose-top

| Baseline                                                              | Rejected candidate                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------- |
| ![baseline dark prose-top](before/reading-desktop-dark-prose-top.png) | ![candidate dark prose-top](reading-desktop-dark-prose-top.png) |

### dark: heading-list

| Baseline                                                                    | Rejected candidate                                                    |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ![baseline dark heading-list](before/reading-desktop-dark-heading-list.png) | ![candidate dark heading-list](reading-desktop-dark-heading-list.png) |

### dark: table-code

| Baseline                                                                | Rejected candidate                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| ![baseline dark table-code](before/reading-desktop-dark-table-code.png) | ![candidate dark table-code](reading-desktop-dark-table-code.png) |

### dark: information-reading

| Baseline                                                                                  | Rejected candidate                                                                  |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| ![baseline dark information-reading](before/reading-desktop-dark-information-reading.png) | ![candidate dark information-reading](reading-desktop-dark-information-reading.png) |

## Actual reference scores and originals

| Reference                 | Hierarchy | Readability | Attention | Consistency | Discoverability |
| ------------------------- | --------: | ----------: | --------: | ----------: | --------------: |
| Claude Code               |         8 |           7 |       7.5 |           8 |               8 |
| Codex                     |       8.5 |         8.5 |       8.5 |         8.5 |               8 |
| DeepSeek Harness          |         8 |           8 |       7.5 |           8 |               8 |
| T3 Code                   |       7.5 |         7.5 |         8 |           8 |             6.5 |
| Linear, no image supplied |       N/O |         N/O |       N/O |         N/O |             N/O |

The reviewer opened all four originals. Unlike tasks, viewports and source quality do not permit a fair product ranking; Linear historical scores are not passed off as a new observation.

![Codex actual reference](https://github.com/albert-zen/zen/blob/745389d3938e969b3d54592fc098a956a9bbd529/docs/ui-quality/references/official-desktop-demos-20261111/proactive-20s.png?raw=true)

![Claude Code actual reference](https://github.com/albert-zen/zen/blob/745389d3938e969b3d54592fc098a956a9bbd529/docs/ui-quality/references/claude-official-demo-20261111/product-demo-conversation.jpg?raw=true)

![T3 Code actual reference](https://github.com/albert-zen/zen/blob/745389d3938e969b3d54592fc098a956a9bbd529/docs/ui-quality/references/t3-runtime-6f13f36f/main-conversation-dark%281%29.jpg?raw=true)

![DeepSeek Harness actual reference](https://github.com/albert-zen/zen/blob/745389d3938e969b3d54592fc098a956a9bbd529/docs/ui-quality/references/deepseek-harness-production-fcc0ad4/subagents-dark.jpg?raw=true)

## Next evidence, not another untested global compression

Candidate opportunities are the code/result block's own density and the reading boundary near the Composer, but each must be isolated and assessed before shipping. Chinese prose, longer articles, real multi-turn conversations, rich Information content, zoom, reading speed/fatigue, scrolling anchors and keyboard interaction remain unverified. No narrow-screen change is part of this experiment.
