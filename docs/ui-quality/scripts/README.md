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
