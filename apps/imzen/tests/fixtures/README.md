# Legacy Gateway fixture provenance

`gateway-v0.sql` was generated from a new temporary SQLite database by
`generate_gateway_v0.py`, using the actual public `SQLiteGatewayState` APIs from
SDK `bb8055054e4b77b2677682e708dd6f394b56406c`. No user database was copied.
The generator requires that exact installed distribution and refuses existing
output paths. Set `IMZEN_LEGACY_PYTHON` to such an existing interpreter to run the
additional provenance test; ordinary CI imports the portable SQL fixture.

Zen main before this migration pins SDK
`7d5f1179365679d0f95abd5cb2ce76547238d05f`. Its persistence and identity code is
byte-for-byte identical to the generator revision:

| SDK path                              | Identical Git object at both revisions     |
| ------------------------------------- | ------------------------------------------ |
| `src/imagent/storage.py`              | `3e0be7263110b44603e8ddf8191210e90db478ce` |
| `src/imagent/contracts/`              | `c3d9fb6faad4af0a088337569c673a601f3c66ca` |
| `src/imagent/projections.py`          | `c47945bde48cdfa92ce8c4ba55ab6923cb8f5561` |
| `src/imagent/request_correlations.py` | `13154855cee5bab754b14076cad414fde64f2f1e` |

The entire revision diff contains only Zen adapter steering, its tests, and docs;
there is no schema or delivery-key change. The fixture therefore covers the
original main SDK persistence contract as well as the steering candidate.

The fixture exercises bindings, generation, inbound completed/uncertain claims,
projection checkpoints, turn/request reply routing, and accepted/unknown/in-flight
proactive deliveries. Tests verify safe supported-case migration and explicit
rejection of unprovable or lossy conversions. A freshly created v1 restart test is
not treated as legacy-migration evidence.
