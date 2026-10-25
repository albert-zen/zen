# Trigger management refinement (draft)

This is a presentation-only direction for review, not an approved design or a scheduler change. Trigger message bubbles and source navigation are handled separately in #492. This PR deliberately keeps the existing save, toggle, run, delete, race guards, target selection, polling and trigger execution semantics unchanged.

## Direction

Keep management in context, while making each definition easier to scan: a heading with its primary creation action, a clear name/state row, a condition summary, aligned target/next-run facts, instructions disclosure, and a separated action footer. Recent activity receives a distinct label/outcome/time hierarchy. Narrow thread panels use the same components in one column. This is not a new navigation architecture or modal editing flow.

References consulted:

- [Fluent 2 drawer guidance](https://fluent2.microsoft.design/components/web/react/core/drawer/usage): contextual inline surfaces preserve the primary task, with clear heading/content/action regions.
- [Nielsen Norman Group: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/): keep optional detail behind an explicit affordance rather than equal-weight presentation.
- [Nielsen Norman Group: recognition rather than recall](https://www.nngroup.com/articles/recognition-and-recall/): expose the definition's target and schedule alongside its name instead of requiring users to infer them.

These principles inform hierarchy; no other product's visual design or execution model is copied.

## Evidence and limits

The preview imports the actual TriggersPage and TriggersPanel components with synthetic SDK responses. It cannot mutate definitions or access real user data. The capture workflow runs sandboxed Chrome in GitHub Actions; it checks renderer errors, external requests, horizontal overflow, CJK fonts, Edit and Cancel, then captures three viewport/theme/language combinations.

Paired captures use the same corrected synthetic fixture. `before` loads the two production UI sources from main commit `98caf2f44ec697bd705909eb970036ce615ca664`; `after` uses this PR. Both carry source hashes and provenance. The earlier exploratory baseline omitted synthetic thread shortId/status and displayed undefined labels. That fixture defect is corrected for the paired comparison, not presented as a production bug. The first preview attempt also failed on a language-controller method typo, which was fixed and given a dedicated TypeScript check.

Screenshot inspection does not establish full desktop integration, screen-reader compliance, or real scheduling correctness. No real trigger is fired during this visual test. This PR must remain draft until the paired images and CI results have been reviewed; design selection remains with the user.
