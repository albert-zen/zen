# Unified-reference v2 synthetic visual evidence

- Production/source head: `41b72ef29ba87e023520675c4f800c568ef10259`.
- CI merge checkout: `469c88e4910a76af6d128bc32b27f47bb684dbaf`.
- CI run: https://github.com/albert-zen/zen/actions/runs/39540338123
- Artifact: https://github.com/albert-zen/zen/actions/runs/39540338123/artifacts/12318723498
- Self-contained `unified-reference-frame.html` SHA-256: `399c08f1ce1635e38c809a6dc9cd516bffd0eb523190c063dea96d4a7c76479d` (local and CI bytes identical).

All content is synthetic. These are actual production React components rendered by Linux Chrome with explicit desktop-input capability emulation, not physical desktop/touch hardware. Fine/hover media are asserted; closed pills are 28 px. The existing separate touch-capability scene remains 48 px with 44 px controls. No live provider request or private source file is used in the UI fixture. Full CI status is recorded in PR #453 separately from the successful visual capture.

The five-reference draft uses the exact bundle in `apps/zenx/docs/reference-context/v2/fixture-bundle.json`: thread, full-message excerpt, sub-agent thread, selected excerpt and file pointer. Explicit Enter sends canonical v2 text; its bytes equal the actual mock-provider capture. The complete-message snapshot is synthetic, not a claim of an implemented @message picker. Images are a separate canonical attachment category, not file pointers.

The short 420 x 480 scene intentionally stresses 15 references, six synthetic geometric images and six queued messages. The two screenshots show different positions in the same bounded scroll area, not hidden/discarded contents. All 22 reference/detail, image-remove and Composer targets were individually scrolled into view and hit-tested. Measurements: scrollHeight 752, clientHeight 268; all targets visible/hittable and no horizontal document overflow.

The `v2` directory includes actual production Host/runtime/adapter request examples captured through an injected fetch with zero network. Its tool set is deliberately wait-only: file/thread pointers are metadata only and have not been read. The screenshots do not imply real model output; the assistant acknowledgment is explicitly labeled local preview.

SHA-256 of evidence files:

```json
{
  "unified-light-1280-draft.png": "7840c1d560f3bbfeb606f767e6d1d96f651d72243566808586cb50e8e1f38ddf",
  "unified-light-1280-sent.png": "29fafc6320d0f82ae4aa2c45b9b11a8afc1f959935731b7145bda9dda33cda72",
  "unified-short-queue-references.png": "d07e0bfc8a236d86c115a46825cec64c8a1f3d4e8b067349fe57c79ddac10425",
  "unified-short-queue-composer.png": "c1aa1ad2e21a3e6288e38fb0b5927afe595ae0a7a8389250d709425da9600a17",
  "measurements.json": "dbed165da4d5726d471dd2fbe75c1a6b35d8f1c1c4e8c60c94aea24a68677988"
}
```
