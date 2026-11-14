# Settings contrast follow-up fixture

This mounts the real production `SettingsView`, styles and translations with
synthetic local-only Settings ports. It is not a connected account, a complete
ZenX Host, a native titlebar or whole-app acceptance. `qa@example.test`, project
paths and quota timestamps are fictional fixtures. Sign out deliberately rejects
without making a network request. It must never use a real profile or credential.

Build with the repository's existing dependencies:

```sh
node docs/ui-quality/scripts/contrast-followup/build.mjs REPOSITORY NEW_OUTPUT_DIRECTORY
```

The output directory must not exist. The builder records the exact three
production source hashes in `source.json` and bundles those files without source
rewriting. Keep baseline and candidate outputs in separate directories. Serve
only these synthetic fixture directories using the environment's supported local
preview route. Do not bypass a browser URL policy or publish the fixture.

Parameters: `mode=light|dark`, `preset=graphite|cobalt|ember`,
`accent=azure|iris|jade`, `contrast=standard|high`, `lang=en|zh-CN`, and
`tab=appearance|account`. The real Appearance controls remain usable. Account's
Sign out action exposes the local rejection in its actual production error node.

For a rendered follow-up, capture matched viewports/themes before and after;
inspect selected preset/accent supporting text and the Account error with their
computed foreground/background/opacity and ancestor surfaces. Verify keyboard
focus, repeated selection and the Sign out error without leaving the fixture.
Never turn source-token calculations or a JSDOM mount into a native screenshot
or WCAG certification claim.

2026-11-09 recovery run: baseline and candidate build succeeded. A JSDOM mount
reached Appearance and Account; clicking the actual Account Sign out button
showed the explicit synthetic rejection. Browser capture was **not completed**:
`file:` was rejected by the browser protocol policy, and supported HTTP localhost
attempts returned connection refused. No pixels or new visual scores resulted.
