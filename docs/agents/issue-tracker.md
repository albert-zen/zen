# Issue Tracker: Linear

Use Linear as the canonical issue tracker for Zen agent work.

## Workspace

- Team: `Albert's house`
- Team key: `ALB`
- Project: `Zen agent`
- Project URL: https://linear.app/alberts-house/project/zen-agent-04d56f75dcff

## Local Artifacts

Use paths from `docs/agents/artifact-paths.md` for durable local specs and evidence:

- PRDs remain in `docs/prd/`.
- Issue DAGs and execution evidence remain in `docs/implementation/`.
- Linear issues should link back to the relevant local PRD/DAG paths when possible.

## Issue IDs

Use Linear issue IDs as the canonical IDs after issues are created.

When drafting local issue DAGs before publishing to Linear, use temporary local IDs:

```text
<slug>-001
<slug>-002
```

Replace or annotate temporary IDs with Linear issue IDs after publishing.

## Dependencies

- Keep the local DAG artifact as the planning source for dependency shape.
- Reflect dependency edges in Linear with blocker/blocked relations after issues are created.
- Do not rely only on issue descriptions for dependency state.

## Status

Linear issue status is canonical. Local artifacts should record publication status and Linear links.
