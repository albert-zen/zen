# Zen UI benchmark research

Research date: 2026-11-09. Public-source research only. No reference app was installed or authenticated; no repository was changed. Public pages were opened in dedicated browser tabs. The project lead owns current Zen captures and implementation review.

## Findings that affect the plan

1. **Theo, not verified as “Zio”.** Theo's own https://t3.gg/ links T3 Code, his GitHub and YouTube. The interview at https://www.indiehackers.com/post/tech/theo-browne-on-how-hes-bringing-in-over-1m-yr-as-a-creator-and-founder-tJPQiOnONnf7pJ9m1PTP identifies Theo Browne as founder and names T3 Code among his products. Treat Zio as a possible transcription error, not a verified alias.
2. **The model council and UI hill climb are real public workflows.** The strongest primary evidence is https://github.com/pingdotgg/t3code/pull/24865, not social summaries. It records 18 review rounds, actual seeded app capture links, comparator scores, and explicit measurement caveats.
3. **High model scores do not prove product success.** The same PR acknowledges comparator score drift on unchanged images. https://github.com/pingdotgg/t3code/pull/25251 subsequently reverses excessive grayscale, and https://github.com/pingdotgg/t3code/pull/25401 rethinks placement after seven already-high-scoring rounds. These are reasons to retain user tasks, independent reviews and measurable acceptance criteria.
4. **Reference identity remains partly uncertain.** The actual https://plotcode.com/ is a cloud infrastructure pattern catalog with provider/language filters. There is no verified evidence that this is the coding-agent benchmark the user means. Some third-party transcripts misrender Claude Code as PlotCode, but do not silently substitute it. “DeepSea Harness” likely means DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness and https://www.deepseek.com/harness/en/. A separately named deepSea plugin also exists, so use the official project spelling while explicitly noting the likely correction.

## Historical T3 evidence and practical lessons

### Council source

https://github.com/t3dotgg/tstack/blob/main/skills/council/SKILL.md

The published skill asks for three strong models from different providers, read-only review, scores per complete round, explicit missing scores, fixes followed by fresh review, and scope control. It requires unavailable delegates to be reported rather than silently replaced. A Sol/Terra panel is useful independent review but is not the published three-provider council. The current skill and a particular historical PR need not use identical models or wording.

### Exact hill-climb redesign

https://github.com/pingdotgg/t3code/pull/24865

The PR describes neutral sidebar hierarchy, coherent typography/radii/icons, quieter composer controls, clearer settings and a Beta toggle. It lists superseded PRs #24776, #24837, #24810 and #24883. The 18 rounds comprise five toward 9.0, ten toward 9.5+, then three toggle/merge reviews. The numbers are author-reported reviewer scores, not independent UX research. In particular, Gemini's comparison ratings changed despite fixed reference images and its prose contradicted parts of its own score table. Do not advertise “better than Codex” as an established result.

Selected source-linked captures, **historical author-provided app evidence**, not newly captured/current installations:

- Before: https://files.tslop.org/2026/10/ui-95-main-thread-dark-4c233702.png
- After: https://files.tslop.org/2026/10/ui-95-s10-thread-dark-46f8dba3.png
- Annotated comparison: https://files.tslop.org/2026/10/ui-95-annotated-main-vs-pr-s11-a5faf45d.png
- The PR says macOS 1280×832, seeded development data. This report read the PR evidence description; these historical image files were not individually rendered in this research pass.

### Iteration after the apparent win

- https://github.com/pingdotgg/t3code/pull/25251 restores identity and semantic color while keeping structure neutral. It also distinguishes keyboard focus from selection and discusses light syntax contrast. Lesson: quiet does not mean eliminating meaning.
- https://github.com/pingdotgg/t3code/pull/25401 relocates state to the end of the timeline after comparing four real-app placement alternatives. Lesson: question information architecture before polishing the wrong grouping.
- https://github.com/pingdotgg/t3code/pull/25869 simplifies the composer and removes desktop collapse behavior. Lesson: fewer states can improve clarity and remove maintenance complexity, but permissions must remain legible.
- https://github.com/pingdotgg/t3code/pull/25968 specifies reproducible mobile scene/pose packs, desktop pairs, task flows and a blind review brief. Lesson: capture repeatable states, not one attractive empty screen.

### Later redesign stack

- https://github.com/pingdotgg/t3code/pull/28839: primitives, type roles and shell.
- https://github.com/pingdotgg/t3code/pull/28840: composer and conversation timeline.
- https://github.com/pingdotgg/t3code/pull/28841: panels/pages.
- https://github.com/pingdotgg/t3code/pull/28842: settings/setup.
- https://github.com/pingdotgg/t3code/pull/28844: voice.
- https://github.com/pingdotgg/t3code/pull/28845: workspace panes.

The fetched #28839/#28840/#28842 descriptions document matched seeded replay captures, hashes, viewports and explicit limits. #28840 places pending work in an integrated tray, unlike the earlier #25401 direction. Therefore this history is evidence of exploration, not a universal rule about where Zen must put state. PR bodies contained a stack-review warning; merge/current-release status was not independently checked. Do not describe every proposal as shipped.

## Public visual references

### T3 Code

https://t3.codes/ and https://github.com/pingdotgg/t3code

Fresh browser observation: a dark three-region product image with title-led thread navigation, central conversation/composer, and a contextual right panel. Bright status/identity marks are sparse. The marketing page explicitly labels the image as T3 running several subagents. Use it for composition and hierarchy inspiration, not evidence of keyboard accessibility, real-time behavior or current shipped-state coverage.

Saved capture: `/workspace/shared/ui-benchmark-captures/t3-published-product-20261109.png`.
Classification: **fresh capture of official marketing page containing a published product image**, not a live T3 app audit. Browser screenshot 1165×747; product image is scaled inside the page.

### Linear

https://linear.app/now/behind-the-latest-design-refresh (March 12, 2026)

Official article with before/after imagery. The useful principles are predictable action locations, navigation that recedes after arrival, restrained separators and smaller, more consistent icons. Its workflow uses feature flags and an in-app theme tool to compare versions. A published sidebar image was opened and inspected: muted inactive rows, tighter icon treatment and added vertical spacing. Preserve meaningful contrast rather than blindly copying a dim screenshot.

Saved capture: `/workspace/shared/ui-benchmark-captures/linear-published-comparison-20261109.png`.
Classification: **fresh browser capture of an official annotated historical comparison image**, not authenticated Linear.

Supporting sources:

- https://linear.app/now/how-we-redesigned-the-linear-ui (March 28, 2024), historical process.
- https://linear.app/now/styling-linear-for-the-future-stylex (August 26, 2026), discusses explicit component styling boundaries and redesign regressions. Borrow the discipline, not a requirement to migrate Zen's styling framework.

### Vercel

https://vercel.com/geist/introduction

Freshly viewed official design-system catalog, with neutral surfaces, coherent icon examples, typography, color and component sections. Good source for building shared primitives and role-based tokens. The public catalog is not the Vercel deployment dashboard, and no signed-in dashboard was audited.

Saved capture: `/workspace/shared/ui-benchmark-captures/vercel-geist-docs-20261109.png`.
Classification: **live official documentation page**, not a dashboard capture.

### Codex

https://openai.com/index/introducing-the-codex-app/ (February 2, 2026)

The official launch article positions the app around managing parallel agents and long-running work. This is useful workflow context, but launch visuals cannot establish the current app's quality. Opening https://developers.openai.com/codex/app/ now redirects to https://learn.chatgpt.com/docs/app, so avoid pretending the old documentation URL is a frozen Codex visual specification.

Saved capture: `/workspace/shared/ui-benchmark-captures/codex-official-article-20261109.png`.
Classification: **fresh capture of official launch article header**, redirected to the Simplified Chinese locale. It is not a product screenshot and should not be put into a blind visual quality comparison as if it were one. No current interactive Codex session was inspected by this worker.

### DeepSeek Harness

https://github.com/deepseek-ai/deepseek-harness links its official product site and describes the plugin-based runtime. Search retrieved the matching official site; web extraction of that site encountered a JavaScript verification page. No challenge was solved and no actual Harness UI was captured. Repo identity is verified; claims about current pixel geometry are not.

## Existing local references: verified but stale

Read-only checks of the existing reference clones found:

- `.../references/t3code`: origin https://github.com/pingdotgg/t3code.git; HEAD `5cc99e1c23980d7995a13c47f969b47cb68ed1be`, dated 2026-10-01.
- `.../references/deepseek-harness`: origin https://github.com/deepseek-ai/deepseek-harness.git; HEAD `639ed015397290b3745d163aafe02ffee4aa3f84`, dated 2026-09-29.

No fetch, checkout or repo changes were made. The old October 1 research artifact was read for provenance only; none of its Zen screenshots or verdicts count as today's audit. These clones cannot support claims about current November UI without a new pinned source/version check.

## Recommended bounded hill-climb for Zen (our synthesis)

1. Freeze a baseline commit, viewport, theme, seed and screenshot manifest. Include populated and empty threads, streaming/tool use, errors, approvals, picker, settings and narrow/long-content states.
2. Define a fixed rubric before showing candidates: task clarity, hierarchy, consistency, readability/contrast, state truthfulness, keyboard/focus behavior, responsive fit and visual polish. Separate screenshot evidence from interaction evidence.
3. Give reviewers identical blind A/B packs with fixed anchors and no “must reach 9.5” instruction. Require concrete screenshot locations, severity and top fixes. Record disagreement and missing evidence. Independent Sol/Terra reviews are two reviewers, not three independent providers.
4. Make a small set of high-impact changes in shared primitives before decorating individual screens. Preserve agent status, permissions, error recovery and user data semantics.
5. Recapture exactly the same cases and run interaction checks. Retain fixed-reference scores as a calibration warning, not a target that moves with the candidate.
6. Stop when no high/medium visible or interaction defects remain in scoped cases, key tasks do not regress, and reviewers can cite real improvements. A number alone never overrides a reproducible defect. If rounds stop improving, reconsider layout alternatives rather than run an endless score loop.

## Evidence limitations

No authenticated third-party apps, paid model calls, downloads/installations, repo edits or publishing. Four current browser captures were saved, but only public docs/marketing/editorial pages were available. No worker-generated screenshot here qualifies as a current authenticated Codex, T3, Linear, Vercel dashboard or DeepSeek Harness app audit. Historical PR media are primary author-provided evidence, not independently replayed tests. Search summaries, including the Theo video transcript, were used only to locate primary links; exact runtime/cost claims from those summaries are not relied on.

## Follow-up: verified Codex interface reference

A later, bounded public-source check found and visually inspected a genuine
published Codex app image, separate from the launch-header capture excluded
above. The official article
https://developers.openai.com/blog/run-long-horizon-tasks-with-codex is dated
February 23, 2026 and publishes
https://developers.openai.com/images/blog/long-horizon-4.jpeg with alt text
“Codex app workspace with project thread”.

The unaltered 1200×673 JPEG shows global actions, grouped project/thread
navigation, a new-thread workspace, composer and restrained toolbar. It is useful
for hierarchy, spacing and navigation comparison, not settings or interaction
acceptance. Neither the app build nor capture date is established; the article
date and visible model label are not a version claim. The original bytes and
source/limits note are retained with the next evidence archive. See
[`references/codex-published-interface.md`](references/codex-published-interface.md)
for exact URL, size and SHA-256. Earlier frozen reviews did not see this new
reference and their scores are not rewritten.
