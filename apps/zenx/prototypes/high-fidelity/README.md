# ZenX high-fidelity prototype

This directory preserves the reviewed ZenX high-fidelity prototype as a static,
non-production artifact. It is not part of the renderer, product architecture,
runtime, or build, and it is not authoritative for current UI/UX decisions.

## Provenance

- Source repository: `/Users/xbjt/.antigravity_cockpit/instances/codex/62a9d91177665568/visualizations/2026/08/19/01a01904-0acb-7fd1-86f2-c5fed7fba832`
- Source commit: `285131afe14a0614805d6491c53f292205ce5a3f`
- Imported: 2026-08-19
- Status: reviewed high-fidelity prototype; static design data only

## Files

- `zenx-high-fidelity-prototype.html` — editable visualization fragment.

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

The HTML uses static review data and preserves the imported snapshot unchanged.
Current product rules live only in [ZenX UI/UX decisions](../../docs/ui-ux.md);
later confirmed decisions there take precedence over this prototype.
