# Room history storage: staged reconstruction

## Status and scope

The implementation removes the destructive 256-message retention/validation
rule and the renderer's total-history cap. Initial display remains four messages;
explicit earlier-history expansion remains sixteen. Shared automation now uses
the journal below instead of the generic plugin storage's 1 MiB snapshot quota;
other plugins retain that quota. Previously truncated messages cannot be
reconstructed from the remaining snapshot.

Core, migration, service, renderer and Host lifecycle wiring have been reconstructed
and locally checked in stages. This is not a claim that cross-platform or real UI
acceptance has passed: those remain required gates below. Code reconstructed after
the workspace loss receives new commits and fresh validation; old results and
hashes are not evidence for the new tree.

## One authority, confined to shared automation

`AutomationTransactionStore` is the sole append-only persistence authority for
existing shared Trigger/Room product state: each checksummed JSONL transaction
atomically contains bounded body-free metadata and its new Room/body/reaction
facts. It is not a new general event store, scheduler or execution domain. Other
plugins retain their existing quota and storage behavior.

Use the existing serialized service queue and `writeJournalPayload` full-write
loop. A successful append includes message, prepared receipt and existing wakeup
facts in one frame, not separate daily record/head commits. Frames have bounded
size; import batches are at most four events and approximately 60 KiB where
possible. Metadata retains existing bounded Trigger and operation policies.
`MAX_ROOM_OPERATIONS` is 128 in the current source; import this constant in tests
rather than introducing another retention number.

An in-memory offset/ID/reaction-revision index addresses committed frames; it is
not another authoritative file. Startup scans frames incrementally without
retaining all historical bodies. Page responses stay bounded and lazy. Reading a
message reads its containing bounded transaction, including metadata overhead;
never describe this as reading only the returned message bytes. Service recent
message caches must not become retention limits.

## Commit and failure contract

Follow existing platform guarantees: sync the file and call the existing
`syncDirectory` helper (Windows directory sync is intentionally a no-op). Do not
claim absolute power-loss durability or make Unix directory fsync a new Windows
availability prerequisite. Persist creation directory entries using that same
platform contract before selecting a new generation.

Validate checksums, frame boundaries, generation, sequence, metadata/event
bindings and named-file identity. A partial/invalid tail makes the generation
unavailable; do not silently truncate, repair or fall back to stale storage.
Short/zero writes, sync failures and replacement of the named file must not ACK.
After an ambiguous append, fence subsequent writes and report an unknown outcome.
Visible bytes after a failed sync are not proof of an acknowledged commit.

Opening valid committed facts reconstructs observed state; it does not manufacture
a new sync receipt or trigger delivery. A committed receipt is not proof that an
Agent received a wakeup. Observe unknown dispatch outcomes, never replay them.
Test both commit-before-dispatch and dispatch-before-observation failure windows.

## Host marker lease during service lifecycle

The selected journal exposes one Host-owned `append(transaction, candidates?)`
entry point. It acquires the existing shared namespace queue, then the Room
namespace queue in that fixed order. A candidate supplies its actual Host-created
SDK storage facade; a private WeakMap resolves that facade to its real storage
owner. Unmapped, expired, cross-root, wrong-version and wrong-generation handles
cannot authorize an append. The peer namespace must also be current.

Only after both namespace paths and generation markers are verified does this
one callback install a private, transient token for exactly one journal append.
Core lease checks validate both captured storage owners; finally expires the token.
The selected journal's raw append path cannot bypass this admission. A replacement
arriving after admission waits for the existing queues, rather than making a
partially written append spuriously unknown. A replacement that entered first
continues to fence old Host/runtime handles.

This is not a new persistence authority or plugin permission API. The SDK facade
still exposes only its existing storage methods. Same-namespace recursive SDK
access from a lease callback is rejected using callback-local async context;
independent callers continue to queue normally. Callback failure expires its lease;
there is no promise that cancelling after I/O revokes or rolls back a commit.

## Receipt bodies and reaction snapshots

Prepared operations need immutable independent body facts in the same frame as
metadata. Committed new operations may reference an existing or same-frame human
message only after validating Room, operation ID, generation and payload hash.
Body references are storage-internal: public receipt text/quotes remain unchanged.
Missing or mismatched body facts are unavailable, not empty receipts. Avoid
rehydrating all operation bodies on every mutation.

Legacy snapshots may contain committed receipts whose messages were already
truncated or mismatched by the old implementation. Migration preserves the
original receipt as an independent `legacy-receipt` body, not fabricated history.
That exception is allowed only during import and bound to the original non-null
committed message ID. A legacy prepared operation with null message ID receives
no exception: later commit must satisfy normal human-message validation. Operation
identity/body bindings remain immutable after bounded receipt metadata eviction.

Page snapshots bind Room and generation plus legal committed frame boundaries,
message count and reaction revision. Reactions applied after a snapshot cannot be
overwritten by a stale page. No new public jump feature is introduced.

Notifications are body-free invalidations with bounded assistant identity. A
service-instance revision distinguishes same-count reaction, acknowledgement and
assistant changes for the Host's local subscription; it is neither a durable
receipt nor a remote watermark. Remote notifications do not carry this revision.
Each Host bootstrap creates a fresh subscription map and startup publishes the
current snapshot. Read-only page/list requests do not publish invalidations.

## Forward-only migration and lifecycle

Before overwriting any authoritative legacy metadata, preserve, verify and sync
its exact original bytes. Both plugin namespaces participate in the existing
replacement gates. Import into an unselected generation in small frames, then
perform the one-time version-2 marker cutover. Afterwards JSON files are markers,
not a second product-state writer. Every SDK/lifecycle writer for both namespaces
must use the Host-owned marker read-only contract.

Check migration artifacts and forward markers **before** any legacy/bootstrap
initialization: missing shared marker plus an existing forward marker must not
create empty v1 state and bypass recovery checks. Selected history missing or
invalid must fail explicitly; never choose legacy data as a fallback. Old v1
writers must refuse version-2 storage. Retry a rolled-back unselected import only
when both original v1 namespaces remain authoritative. A v1 shared container paired with a v2 forward marker is
ambiguous (the shared marker may have been rolled back after new history was
accepted): refuse without rewriting any files rather than reimporting its backup.
The automatic recovery contract does not cover manually rolling both namespaces
back to old v1 copies after cutover; that requires explicit recovery of the retained
journal files. There is no automatic replay of effects.

Deleting one plugin cannot delete the peer's journal or pretend that an empty
append physically erases data. Until a separately reviewed physical-deletion
protocol exists, explicit Delete data refuses when shared facts, active owners or
known migration artifacts make independent deletion unsafe, with a clear shared
storage explanation. Legacy backups count as retained data.

## Acceptance gates

Checkpoint core and fault tests before service integration, then independently
review migration and all-writer/lifecycle wiring. Exercise persistence/restart,
more than 256 ordered messages, more than 1 MiB of history and human receipt
bodies, duplicate retries, 128-operation eviction without history loss, bounded
page/internal-read sizes, stale reactions and failure/unknown paths. Preserve
existing public APIs and exactly-once admission behavior.

Run native file/journal/migration tests on Linux, Windows and macOS. UI acceptance
requires SHA-matched real screenshots with synthetic-data boundaries: initial
four messages, crossing 256 via Load earlier, oldest and latest after loading all.
CI evidence must omit raw logs, local paths, credentials and real user data.

### Minimal recurring checks and one-time UI evidence

The existing Linux `check:observed` already includes the storage, migration,
service and renderer tests. The existing Windows and macOS jobs run just the
store, migration and real factory suites after their existing SDK/Core build.
No second Linux test step, new job, dependency installation, screenshot upload
or job-timeout increase is needed for this change.

These checks establish retained IDs/order across restart, history beyond 256 and
1 MiB, bounded page/read/write behavior, and fail-closed mutation/migration. They
are correctness and I/O-work regressions, not a throughput or user-latency
benchmark. Native power-loss guarantees are not inferred from passing them.

For this UI change, capture once from the exact reviewed checkout with existing
Linux Chromium and CJK fonts, using only generated data:

```sh
npm run build --workspace @zenx/plugin-sdk
node --import tsx apps/zenx/scripts/generate-room-history-fixture.ts /tmp/room-history-raw
node apps/zenx/scripts/build-room-history-preview.mjs /tmp/room-history-raw
node apps/zenx/scripts/capture-room-history-preview.mjs /tmp/room-history-raw --local-synthetic
node apps/zenx/scripts/collect-room-history-evidence.mjs /tmp/room-history-raw /tmp/room-history-safe "$(git rev-parse HEAD)"
```

The four screenshots show initial four messages, crossing 256, and both ends of
all 320 messages. Assertions check IDs, text, order, duplicates and idle scroll
stability. This is a production component fed responses verified against real
synthetic storage, not a native Electron end-to-end or timing measurement. Publish
only the safe directory after reviewing its SHA-bound receipt; raw browser and
lifecycle diagnostics remain local. If browser sandboxing or fonts are blocked,
report the failed acceptance rather than weakening the checks. Repeat this
one-time capture when history interaction/layout changes, not on unrelated PRs.
