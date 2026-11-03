# Read-only MCP fixture experiment

This **unwired, synthetic-only** probe tests a narrow model-facing surface over
stdio. It does not connect to ZenX, create credentials, open a network listener,
load journals, invoke a model or configure an external harness. It is not a
production MCP server or a claim of full protocol conformance.

```sh
node --test scripts/experiments/readonly-mcp/fixture.test.mjs
```

The two tools read one fixed synthetic Thread and one compact synthetic Board.
Tool arguments cannot choose another Thread or permission scope. The fixture
checks an allowlist; `readOnlyHint` is descriptive, not authorization. It emits
bounded newline JSON-RPC and only advertises the capability it implements.

This separates the experimental question “can several harnesses consume a small
model-facing surface?” from replacing ZAS or sharing a harness's conversation
state. A production adapter would require an approved Host-owned, revocable
caller scope and the existing native read/policy ports. It must not call capability
packages directly with forged trusted invocation fields. No such adapter exists
in this experiment. Actual SDK interoperability, harness compatibility, user input
routing, cancellation, and answer delivery are **not tested here**.

Roll back by discarding this isolated branch; no product startup or configuration
refers to these scripts. The experiment adds no runtime dependency.
