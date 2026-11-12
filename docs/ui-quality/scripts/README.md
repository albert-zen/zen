# Reproduce isolated native histories

From repository root with prepared development dependencies:

```sh
node --import tsx docs/ui-quality/scripts/seed-native-journeys.mts "$PWD" /absolute/new-qa-root
npm run build:fixtures --workspace @zen/zenx
```

The seed refuses an existing directory. It creates only synthetic FakeModel
providers, canonical App Server histories, its own workspace files, a disposable
host profile and a seed manifest. It uses production public APIs, including
exact-prefix Fork, a child sender's real harmless tool-call receipt, canonical
thread messages, profile selection and 24 completed conversation turns.

For native application inspection, launch the built app with the generated
`profile/` as Electron userData/sessionData and `data/` as ZENX_DATA_DIR. Use an
isolated browser profile, remove inherited provider credentials from the test
process environment and block non-loopback network. Never point this fixture at
a user's active data/profile. Capture through the approved native UI tooling;
the seed does not automate screenshots or emulate user interaction.

The capture run used Electron 43.2.0. A QA-only launch wrapper disabled hardware
acceleration after the cloud desktop produced corrupt surfaces on restart.
Accepted captures were visually inspected; corrupt captures were excluded. No
production rendering preference was changed.

Limits: these are real application histories with synthetic content. They do
not prove online-provider authentication, plugin-generated autonomous work,
paid-model quality or sustained streaming timing. FakeModel finishes nearly
instantly. A slower controlled local adapter is needed for that timing test.

## Reproduce source theme-token contrast measurements

The standard-library-only calculator below measures 36 combinations of
Light/Dark, three presets, three accents and Standard/High. Run it from any
working directory; its default repository is the one containing the script.
`--repo` can explicitly select another checkout. Use a new output file:

```sh
output_dir=$(mktemp -d)
python3 docs/ui-quality/scripts/measure-theme-contrast.py --repo . \
  --output "$output_dir/theme-contrast.json"
```

Omit `--output` to write JSON to stdout. The file option refuses an existing
path, so archived measurements are never automatically overwritten. Record the
source commit alongside generated evidence; results describe that checkout's
current theme tokens, not necessarily the original round-six palette.

This is an **explicit token-pair source calculator**, not a general CSS cascade
parser, native computed-style inspection, visual review or WCAG/AT certification.
It resolves the limited root-token syntax used by `theme.css` and manually mapped
foreground/background pairs. Alpha layers and the explicit sRGB border mix are
composited before luminance calculation; composite channels remain unrounded for
ratios, displayed hex is rounded, and reported ratios use four decimal places.
Reinspect the pair mappings if component selectors, backgrounds or theme
structure change. Low border ratios alone do not establish a WCAG failure.
