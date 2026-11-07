# Documentation-only CI validation

This temporary draft validates the documentation-only fast path introduced in
PR #739. It changes only this Markdown file and must not be merged.

Acceptance requires successful formatting and selection checks, the original
named CI checks including all three UI shards, and explicit omission of heavy
installation, build, native-input and browser-test steps. Record actual hosted
runner time separately from historical full-CI costs.
