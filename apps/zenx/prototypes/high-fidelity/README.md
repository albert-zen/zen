# ZenX high-fidelity prototype

This directory preserves the reviewed ZenX high-fidelity prototype as a
non-production design and interaction reference. It is not part of the ZenX
renderer, product architecture, runtime, or build.

## Provenance

- Source repository: `/Users/xbjt/.antigravity_cockpit/instances/codex/62a9d91177665568/visualizations/2026/08/19/01a01904-0acb-7fd1-86f2-c5fed7fba832`
- Source commit: `285131afe14a0614805d6491c53f292205ce5a3f`
- Imported: 2026-08-19
- Status: reviewed high-fidelity prototype; static design data only

## Files

- `zenx-high-fidelity-prototype.html` — editable visualization fragment.
- `zenx-high-fidelity-implementation-notes.md` — product projection, interaction, responsive, plugin, and implementation constraints.

## Local preview

From the Zen repository root:

```sh
cd apps/zenx/prototypes/high-fidelity
python3 -m http.server 41783 --bind 127.0.0.1
```

Open
`http://127.0.0.1:41783/zenx-high-fidelity-prototype.html`. Stop the
temporary server after review.

## Scope

The HTML uses static review data. Formal implementation must bind ZEM Items, plugin manifests, grants, approvals, runtime state, and provider configuration from the ZenX Host rather than copying the prototype data model.
