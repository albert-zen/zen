# Settings: long selected model identities

**Not deployed.** The baseline is the merged ZenX SettingsView at `9e65c349`
(reviewed renderer `5a259e00`). The prototype adds only the local wrap rule in
`model-routing-label.patch`; it does not change shared Combobox behavior,
model IDs, provider choice, preferences, Settings layout/routing, or storage.

Paired, unedited Chromium 131 screenshots in the same synthetic fixture,
which mounts production SettingsView and styles without an account, network,
or Host. Graphite, DPR 1. Linux Chromium only, not native desktop.

- `before.png` and `prototype.png`: 1000 × 900, light, English, same two
  operational model selections. The before controls show the same prefix and
  omit Fast/Deep; the prototype leaves both names, including the suffix, readable.
- `before-unavailable.png` and `prototype-unavailable.png`: 1280 × 900, dark,
  zh-CN. The saved-looking Fast fixture lacks required catalog metadata, so the
  existing unavailable notice stays separately visible. Prototype also shows
  the full identity. This is controlled input, not an attempt to start an
  invalid persisted Host profile.

Open Models & providers, put two long names with a common prefix in the
Default model and Title model fields. With the real focused trigger use
ArrowDown to open, Escape to close without changing selection, then ArrowDown,
search for `November 2026 · Deep` and Enter. In both variants the exact Deep
selection changes the default draft only; Title is unchanged. The explicitly
unavailable Fast value remains described until changed and is not selectable.
No Apply or persistence claim: the isolated read-only Host fixture rejects save.

All eight replays passed: four combinations covering 520, 880, 1000 and
1280 CSS px, both themes and languages, healthy/unavailable cases. Measured
label widths at 1000 px: before 317 px available with 693/698 px required;
prototype 317/317 px and the literal suffix is visible. No unexpected requests
or page errors.

Reference: [T3 Code #22193 screenshot](https://github.com/macodev00/t3code/blob/4e957d6f73c2ab8e1dbf20c7348a5d5c0987c5a7/issue-16444/after/01-general-default-model.png)
was viewed: it presents the original selected model and independent disabled
provider copy, but uses a short name. [T3 Code #16522](https://github.com/pingdotgg/t3code/pull/16522)
reports actual isolated long-name tests in the provider list with full keyboard
tooltip, not these two closed default selectors; its external comparison
images were unavailable here. No matched-reference runtime, blind score or
overall app claim.
