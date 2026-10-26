# Canonical content: upgrade and rollback gate

This is an operator checklist, not an automatic migration. The source journal
remains append-only. A preflight report is disposable evidence, never a second
history, a capability grant, or proof of what an old provider received.

## Release identity and stop conditions

Use the **full source commit and artifact SHA-256**, not the current `0.1.0`
package version, to identify a candidate. Record the exact Host, desktop client,
CLI and provider/plugin bundle revisions in the release handoff. A successful
build does not establish that the installed app uses that build.

Do not distribute a candidate as upgrade-ready until its handoff names:

- The integrated commit, CI run, artifact/platform/architecture and checksums.
- The canonical-content implementation and per-message debugger commits, tested
  together, including all applicable protocol serializers with fake transport.
- The accepted legacy journal shapes and exact new Item/content contract; no
  placeholder version strings or guessed compatibility ranges.
- Evidence that failed/unknown append prevents dispatch, reload preserves text,
  queued/steered inputs obey the same boundary, and old tools are not reexecuted.
- Actual mixed-client/Host behavior and the supported downgrade path below.
- Any untested platform, real-application scenario or paid-provider integration.

The audit tool below verifies the decoder built from the checked-out source. It
**does not detect whether that source implements the new content contract** or
certify a final release. Until those integrated tests pass, the release gate is
closed even if a journal audit succeeds.

## Offline read-only preflight

The operator must first quit all writers using the selected data, including
background Hosts. The tool does not stop them, acquire a lease or promise a live
snapshot. Choose the actual journal and AttachmentStore directories explicitly;
it does not scan home directories or discover credentials.

```sh
npm ci
npm run build
node scripts/history-upgrade-audit.mjs --offline /selected/journals /selected/attachments
```

Use the trusted, pinned candidate checkout and its lockfile. Building is separate
from the audit; the audit itself makes no network, model, tool-execution or write
calls. Exit 0 means the selected nonempty journal set decodes and replays with
this build and its referenced media passes the existing AttachmentStore checks.
Exit 1 blocks proceeding; exit 2 is a usage error. Never fix a failure by deleting
unknown Items, removing media parts, stripping metadata or editing source text.

The audit preserves source bytes (including CRLF). It reports counts and hashes,
not message text, filenames, Thread IDs, credentials or raw decoder errors.
Keep even these hashes private: they can correlate data. Journal symlinks,
invalid names, invalid UTF-8/JSON, unknown Item types and invalid replay fail.
Reachable declared content/modelContent/input media is checked; arbitrary JSON
inside tool output is not interpreted as an attachment reference. Missing,
corrupt or symlinked attachment payloads fail. Journals over 64 MiB fail rather
than being partially scanned. Resolve such a limit separately; do not split or
rewrite the journal just to pass preflight.

All input paths must be operator-controlled, quiescent directories. This is not
a security sandbox against concurrent path replacement. Unreferenced blobs,
external files, transient tool spool files, live jobs, credentials and plugin
configuration are **not** certified by this journal audit.

## Backup and restore rehearsal

1. While writers are stopped, make an operator-controlled filesystem backup of
   the selected journals **and their complete AttachmentStore**. Preserve raw
   bytes, permissions and directory layout. Store outside the live data tree.
   Include Host/profile/plugin configuration separately where needed, using the
   existing secure backup practice; do not put secrets in the audit report.
2. Restore that backup into a fresh, isolated directory, never over the original.
   Run the same pinned audit on the restored directories. Compare every reported
   journal/media hash and count against the source audit. Also compare the whole
   backup inventory using the operator's backup tooling; the audit covers only
   selected journals and reachable media, not a whole machine backup.
3. Keep the original and verified backup unchanged. Only an explicitly authorized
   operator should switch the real app to the new build/data location.
4. Start with an isolated restored copy and fake transport for engineering
   validation. Merely reading history must not dispatch a model or resume tools.
   New user sends can be billable and must not be used as an implicit smoke test.
5. After first new-content writes, preserve that newer history too. To revert the
   binary to an older reader, use a **separate pre-upgrade backup**. Never point an
   old Host at new data unless exact decoder/replay compatibility was tested.
   This is a branch in history: changes after backup are absent there. Do not
   silently discard those changes or merge journals by concatenating files.

The automated test exercises backup → restore only on freshly generated synthetic
files; it does not copy, migrate or install anything on a user's computer:

```sh
npm run build
node --test dist/test/history-upgrade-audit.test.js dist/test/journal.test.js
```

## Compatibility matrix to close before distribution

| Pair / operation                             | Safe default until demonstrated                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| New Host reads old journal                   | Preserve original bytes and truthful legacy display; exact historical model text is not reconstructible merely from metadata. |
| New Host continues old Thread                | Test the final compiler's append-only materialization and source/role preservation; no bulk rewrite and no hidden late text.  |
| New client + old Host                        | Do not claim complete content/debug semantics; capability must fail explicitly or clearly show unsupported.                   |
| Old client + new Host                        | Test actual decoder behavior and renderer; never silently hide unknown canonical Items then claim full history.               |
| Old Host + newly appended journal            | Block operational downgrade unless exact compatibility is proven. Unknown Items must fail, not be dropped.                    |
| Fork/import/compaction                       | Preserve identity/roles and declared boundaries; inspect newly appended content after reload. No tool replay.                 |
| Debug with request capture disabled          | Canonical content still visible and copyable. Wire observation is optional and not authority.                                 |
| Request capture after clear/restart/eviction | Unavailable; never backfill an alleged exact request from today's compiler.                                                   |

These are release gates, not a claim that a runtime protocol negotiation or binary
version blocker has already been implemented. Product owners must bind this table
to actual tested revisions in the release handoff.

## Release-note text (publish only after the corresponding gates pass)

- Model-visible message text is committed through the canonical context boundary
  before sending. Message inspection shows that canonical content directly.
- Original legacy history is retained unchanged. Missing historical model input
  is identified as unavailable, not reconstructed as if it were original.
- Optional actual-request capture remains local, bounded and ephemeral; clearing
  or restarting does not remove canonical history.
- Back up journals and referenced attachments before upgrading. Do not open newly
  written history with an older Host; rollback uses a separate pre-upgrade backup.

Replace this draft wording with the final verified scope; do not advertise
unmerged fixes, universal provider support or an installed update from a PR alone.
