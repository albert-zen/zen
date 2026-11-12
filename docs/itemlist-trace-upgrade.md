# ItemList / Trace cutover (cloud reconstruction)

This implementation is newly rebuilt from public `81ff10d5`; prior unpublished
Oct 26 commit IDs and test counts are not recovered-source evidence.

## Domains and authority

- ItemList contains only durable compiled model-semantic records, not original fact authority. The sole core encoder
  supplies actual text/parts, original roles and typed provenance; adapters do not
  add hidden semantics. Atomic file replacement is logically append-only: prior
  UTF-8 bytes remain exact, then new JSONL records are appended.
- Always-on Trace holds observed runtime/control facts and actual request/response
  artifacts. **Durable logs are recovery truth.** Current runtime state is a
  projection, not an independently authoritative mutable snapshot. Critical
  accepted canonical facts (including original user/assistant/tool facts) require a
  durable Trace receipt before compiler output/ACK. Raw transport chunks, usage,
  and incomplete observations may report explicit degraded capture. An uncertain
  write is not proof of absence. Missing compiled records are reconciled from exact
  logged fact IDs using pure compilation only, never tool or model reexecution.
  Generated sample inputs and frozen imports have immutable context-source facts.
- Existing application state (e.g. titles/archive/preferences) remains separate.
  There is no Execution database or generic revision framework.

The withdrawn current-snapshot prototype remains in the local checkpoint branch
for comparison only. It is not the approved recovery design.

## Migration and compatibility

1. Stop all old/new writers. Copy the complete profile and application for backup;
   verify copied files/hashes and ability to restore before any installation.
2. Read-only preflight decodes every source record, validates legacy Thread history,
   runs the same semantic encoder, and validates owned attachment bytes. Unknown
   intermediate formats are rejected before mutation, not guessed.
3. Exact original JSONL bytes (including CRLF) are preserved under
   `threads/legacy/<thread>.jsonl`. Trace stores the original archive artifact and
   imported observed facts. Historical actual wire capture is **unavailable**;
   migration never fabricates requests from old semantic text.
4. The old root journal path becomes an explicit format fence. Ordinary old Host
   readers reject it rather than append new mixed events. This is not a guarantee
   against arbitrary programs writing files; the stopped-writer prerequisite is
   mandatory. Do not run mixed old/new binaries on one profile.
5. Publish the complete strict semantic file atomically. Interruption resumes
   from the original hash-verified archive; reruns do not rewrite semantic IDs or
   regenerate frozen text. Fork preserves exact semantic snapshots, remapping
   only defined relations, never rebinding short aliases.

Read-only preflight (does not create locks or Trace records):

```sh
node --import tsx scripts/migrate-itemlist-trace.mjs --data-directory /synthetic/copy --offline
```

Only after reviewing the preflight and a verified backup, add `--apply`. This CLI
never invokes providers/tools, closes applications, exports user data, or installs
software. Current user data is not authorized for this cloud acceptance.

Rollback means restoring the **complete stopped backup to a separate profile** and
its matching old application. Never point an old binary at new semantic files or
replace only one domain. Preserve all post-cutover ItemList/Trace/app-state bytes
before rollback; old software cannot represent new records. Unknown schema,
occupied files, or unexpected source changes stop the procedure.

## Writer and durability boundaries

A private native file descriptor holds the existing single-Host storage ownership
for its OS lifetime. Linux uses OFD locks, macOS flock, Windows LockFileEx through
pinned Apache-2.0 `fs-native-extensions@1.4.5` (Node-API 9; shipped Darwin prebuilds
minimum macOS 12). A persistent immutable `.writer.lock` marker fences old wx
candidates. No PID/TTL reclaim, lock-file unlink, or guardian service. An old JSON
or empty lock fails closed for explicit offline review. Host closes ownership
only after admitted I/O drains. A normal crashed process releases the OS lock;
existing manager automatic recovery must still be regression-tested.

Semantic writes use temporary write + file fsync + close + atomic rename + parent
fsync. Windows Node exposes file fsync but not directory fsync: the reported
boundary must remain honest. Complete-file publication rewrites history on each
append; measure larger histories. Process-kill tests are not power-loss proofs.

Native packaging stages only the exact target prebuild, locked runtime JS closure,
and licenses. No startup download/compiler. Linux fresh isolated-package loading
is tested; actual Windows/macOS/Electron package validation remains a release gate.

## Acceptance ledger (not a release certificate)

New focused tests cover strict domain routing, durable-control failure ACK refusal,
resume after archive/Trace/fence/publication interruption, original source bytes,
unsupported formats, semantic old-or-new publication, native process competition,
SIGKILL restart, failed real apply_patch read-close, I/O drain, and attachment alias
rejection **before import success**. Full runtime/transport/UI integration is pending.

Before any user-machine action, rerun the integrated compiler → real serializer →
durable raw Trace → fake/local model streaming → tool results/errors/unknown →
recovery → normal/debug UI → restart → migration chain. No paid model APIs.
Required regressions include all queued steers at first safe boundary, per-sample
settings snapshots, immediate revocation, exact effect recovery without tool replay,
short stable refs and stale rejection, artifact completeness, cancellation/shutdown,
concurrent clients, original UI regression fixes and plugin storage.

The user painpoint ledger must not disappear behind green unit tests: selection/
turn expansion; bubble whitespace; file/URL clicks; light blank page; file scrolling
and End; quote composer overflow then delete-empty; rail/chooser/fullscreen limits;
ThreadRoom sidebar; computer target; background non-stealing focus; persistent
activity notice; AX self-drawn DingTalk/WeCom timeout/partial/no hidden fallback;
CJK clipboard/Cmd channel; expired screenshot refs; native media/Responses and
package provenance. OCR is not implemented by AX-budget work. Real locked/screen-off
hardware, focus, and activity-indicator guarantees cannot be marked passed using
synthetic tests alone. Explicitly label unimplemented, simulated, platform-limited,
and untested gates. The user's machine is not a substitute cloud acceptance lab.

## Typed model-visible identifier audit

This is a typed-boundary audit, not a regex UUID scrub. Final serializer fixtures
must be rerun on the integrated compact-ref/core commits; this table is not evidence
that those unintegrated adapters already passed.

| Boundary                                             | Preserve                                                | Compact or keep internal                                                              | Acceptance                                                    |
| ---------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| User text, pasted code, paths, file hashes           | Exact authored bytes and role                           | Never rewrite ID-looking strings                                                      | Synthetic intentional UUID is preserved by migration/fact log |
| Tool-call/result protocol pairing (`content.callId`) | Provider-required matching identity                     | Do not blindly shorten without explicit reversible protocol mapping                   | Serializer pairing regression required                        |
| Generated selected-reference envelope                | Actual excerpts and trusted provenance                  | Scope-local stable semantic refs; host/thread/client routing IDs stay source metadata | Core generated-envelope tests + actual wire audit required    |
| Computer target and screenshot/capture refs          | Exact target/capture binding and stale rejection        | Typed scoped aliases, never silently rebound                                          | Compact-ref owner + platform fixtures required                |
| Room/thread routing and self-control list output     | User-relevant names/content and explicit tool selection | Tool-owned short refs; raw routing payload in Trace                                   | Tool projection and serializer fixtures required              |
| Errors and cancellation receipts                     | Real outcome, unknown effect, actionable reason         | Avoid leaking unrelated routing UUIDs from generated wrappers                         | Accepted/unknown/retry E2E required                           |
| Internal source ordinals/CAS edit revision           | Exact private pairing and real edit CAS                 | Never inject generic context revisions/expected versions into prompt text             | Inspect compiled messages, not global string replacement      |

Fork/import preserves frozen source bindings; newly allocated refs use the existing
scope high-water mark. A stale ref must fail explicitly rather than silently bind to
a different target. Original full observed payloads stay in immutable Trace; there
is no second mutable text or alias authority.

Normal product upgrade, not OS-level prohibition: the old public binary's existing
migrated-Thread `startTurn` path is verified to reject the format fence before any
write or model call. That binary does not know the new ownership protocol and could
still create a separate old-format Thread if deliberately run against the same
profile. New/old simultaneous use is unsupported. The supported procedure is stop
old writers, verify backup, replace the version, then migrate; no ACL or guardian is
introduced to police arbitrary obsolete programs.
