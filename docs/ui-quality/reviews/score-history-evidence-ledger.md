# UI score history: evidence-first draft

This preserves recorded scores, not a new review. No reviewer average, rubric conversion, inferred competitor score or whole-app score is supplied. Empty cells mean unobserved or not yet reliably bound. The JSON companion indexes all located reports by exact SHA-256 and preserves original provenance excerpts and verbatim tables. Original reports and corrections remain separate.

## Frozen Appearance mapping

| Candidate | Source                                            | Images          | Review identity                               |
| --------- | ------------------------------------------------- | --------------- | --------------------------------------------- |
| A         | c4fb90f3; exact source hashes in capture manifest | fresh-A-*       | Not supplied                                  |
| B / Q     | 403584e4 / remote bc79a78a                        | fresh-B-* / Q-* | B original reviewer unknown                   |
| P         | ab52d87f / remote 448a50a0                        | P-*             | Primary and challenge identities not supplied |
| R         | 292a768e / remote fed20ea7                        | R-*             | Same primary/challenge follow-up addenda      |

Images are production SettingsView in sandboxed native Electron with synthetic local ports, not whole-App/Host acceptance. Both P-focus files duplicate P-dark exactly; R-narrow-top duplicates R-dark and proves no narrow layout. All original hashes and source mapping are in capture-manifest.json.

## Original A/B shared assessment, scale 0–4

| State            | Hierarchy | Readability | Color | Materials | Attention | Layout |
| ---------------- | --------: | ----------: | ----: | --------: | --------: | -----: |
| Appearance light |         3 |           3 |     3 |         3 |         2 |      3 |
| Appearance dark  |         3 |           2 |     3 |         3 |         2 |      3 |
| Account light    |         3 |           3 |     3 |         3 |         3 |      3 |
| Account dark     |         3 |           2 |     3 |         3 |         3 |      3 |

These describe near-identical A/B states, not separate scores that can be subtracted. B's single observed focus control scored 3/4; A focus was unobserved. Reviewer identity remains blank.

The independent primary and challenge reports each give P and Q 3/4 in their scored dimensions. Primary also scores visible navigation/static accessibility cues and leaves interaction and cross-surface consistency unobserved. R addenda remain within the same anchors. Retain their exact separate tables rather than merge these into one model result. R was not a fresh blind review; P/Q order bias remains.

## Reference-project comparison cells

| Round            | Reference project                    | Separate dimension scores | Evidence limit                                                                               |
| ---------------- | ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------- |
| Appearance A/B   | Linear, Vercel, Codex                |                           | General principles, not matched reference-image scores                                       |
| Appearance P/Q/R | Public design principles             |                           | No separately scored reference UI                                                            |
| qa6              | General references                   |                           | Equivalent reference screenshots not supplied                                                |
| qa7              | Codex official article; T3 PR #25251 |                           | Three original public images inspected, but no separate competitor dimension scores recorded |

No third-party reference images are redistributed in this package. Cite official URLs instead. Future independent reviewers should receive matched evidence and the same anchored dimensions; retain their separate results and leave unseen dimensions empty. Historical reference scores cannot be invented retroactively.

## Other rounds and remaining work

The JSON companion retains all located review tables independently, including Sol/Terra, Astra/Luna, source/component reviews and later native observations. Filename model labels are identified as such, not reconstructed agent identities. Other frozen-version cells remain blank until reconciled with original manifests. This is a draft index, not a completed all-round PR comparison.

Known later bindings: qa6 uses 735edb82b4e555abf5fe6622324705796f8e559a, qa7 uses 17c54ea29af9a7d29ab3935654ec97442f69058e. qa7's P-full comes from qa6 and Q-full/Q-split from qa7; only the report's matched scope is comparable. These later images are not included in this first publication candidate. qa8 is ongoing and excluded entirely.
