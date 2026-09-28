# Remote Host v0 — isolated development slice

**Not ZenX's daily Host, not Android end-to-end, not a public deployment.** This native ZAS gateway is opt-in only for a separate CLI Host with `--remote-host-config`, explicit non-default `--data-dir`, and deterministic `fake` provider. No Electron listener, local descriptor or token file is exported. No real provider/tool approval or production mobile pairing UI exists in this slice.

## Contract and security boundary

The pure shared protocol types/constants are [`src/protocol/native/remote-wire.ts`](../src/protocol/native/remote-wire.ts), importable as types without Node. TLS 1.2+ WSS `/remote` and HTTPS `POST /pair` are the only endpoints. Operator-supplied stable external `hostId`, TLS certificate/key, workspace allowlist, and owner-only code file are mandatory. A random 256-bit one-use code expires after five minutes; pairing through trusted TLS returns a random device token, stored by the client in secure storage. The client supplies `Authorization: Bearer` and `x-zen-device-id` to WSS and checks `zen/remote/hello` host/version. Browser-originated handshakes are rejected. **Do not disable certificate verification**: Android must use OS trust or reviewed pinning and compare expected host ID. Test self-signed certificates are ephemeral and explicitly trusted only by test clients.

Workspace ID resolves only to a Host-owned allowlist, checked against each Thread's real cwd; clients cannot start arbitrary cwd. New remote Threads are `read-only` + `approvalPolicy: always`; existing Full Access Threads can be listed/read/interrupted but `send` fails `operation_forbidden`. The AppServer rechecks permissions under its Thread mutation lock at Turn admission, so a local permission change racing the remote read cannot authorize a Full Access run. There is no remote approval handler. Local TTY `revoke <deviceId>` closes active sockets and invalidates tokens; stopping the isolated Host revokes all. Grants are **process-local**, so restart requires re-pair. CLI pairing code currently grants all configured workspaces; Host API supports scoped `createPairingCode([workspaceId])` but lacks scope-management UX. Keep the configured hostId stable; identity reset requires clients to re-pair.

Remote resume and events are **strictly public projections**, not trusted native full snapshots: user/Agent visible text, Turn lifecycle IDs/status, and redacted watermark placeholders only. No reasoning, tool bodies, provider settings, cwd, attachment, or raw streaming delta. Snapshot + transient processEpoch/watermark come from the sole AppServer canonical ItemList; on disconnect/epoch change/gap, re-resume and dedupe Item/Turn IDs. Retry uncertain `send` only with the _same_ clientId and input; never reissue interrupt blindly. A send response means admitted, not completed.

### R2: bounded shutdown and recovery (native version 1)

The earlier v0 complete resume response could exceed 2 MiB and indefinitely fail for valid history; v1 **breaks** that shape. `zen/remote/hello {version:1,hostId}` is mandatory. `zen/remote/resume {workspaceId,threadId}` returns one `RemoteRecoveryPage` with `{processEpoch,threadId,watermark,thread:{id,name?,archived},entries,nextCursor}`. `zen/remote/resume/page {cursor}` repeats on the **same** authenticated WebSocket until `nextCursor:null`. Each page body is at most 256 KiB (below the 2 MiB response frame cap even with the largest accepted request id). `entries` in canonical order are either `{kind:"item",item,turn?}` or `{kind:"text_fragment",item,offset,text,complete}`. Text offsets are JavaScript UTF-16 code units; concatenate exact text in offset order, and **do not** treat a fragment as an Item before `complete:true`. A non-text metadata entry that itself cannot fit fails `entry_too_large` explicitly, never truncates or falsely marks history complete.

At the first resume the Host fixes the canonical Item count, process epoch and watermark after establishing a live subscription. A connection retains only this boundary, the next position, one at-most-256-KiB previous page for retry, and a 512-KiB event barrier—not a second log. **Both fresh pages and cached previous-page/terminal-page retries recheck the current device grant, dynamic Host workspace mapping, Thread cwd and process epoch before returning any text.** Loss of scope invalidates the cursor, cache and event barrier; the denied request reports `wrong_workspace` (or the applicable auth/epoch error), subsequent use of the old cursor reports `stale_cursor`. Authorized retries still receive the identical prior page. An asynchronous check that completes after a newer resume cannot publish the old generation. Live events during pagination remain in that bounded barrier, flushed after the terminal page; if overflow occurs, `zen/remote/thread/reset {threadId,reason:"resync_required"}` invalidates the partial recovery. Large live events or slow socket output force disconnect and a new paged resume rather than unbounded buffering. A previous cursor may retry the last page on its connection; cursors from another connection/epoch/Thread or a superseded resume return `stale_cursor`. On any gap, reset, disconnect, or epoch change discard the incomplete page set and start from `resume`, reconciling stable Item/Turn IDs. Idempotent `send.clientId` and expected-Turn interrupt fences are unchanged.

The live subscription also rechecks device, dynamic workspace/cwd and Host epoch **after** its asynchronous Thread read, before publishing each projected event. An authorization/read failure poisons only that generation: it unsubscribes and emits an observable `zen/remote/thread/reset` (also while the recovery page barrier is active), clears buffered events and cursor, and requires a fresh resume even if authorization is subsequently restored. This does not retract messages already delivered before revocation or claim an instantaneous lock over external workspace configuration. An older asynchronous callback cannot reset a newer resume. Page request mutual exclusion belongs to its generation: a new resume can page while an old read remains pending, and the old request's `finally` cannot release the new generation's busy slot. The per-connection four-RPC cap remains in force. These are implementation corrections under **the same v1 wire**, not a new mobile recovery shape.

The gateway caps total TCP sockets at 64, unauthenticated TLS sessions and pending pair bodies at 16, upgraded WebSockets at 32, and simultaneous RPC calls per socket at 4. It sets a 5s TLS handshake/header deadline, 5s absolute partial `/pair` body deadline, 10s absolute unauthenticated TLS lifetime plus Node request timeout, and 1s idle HTTP keepalive. These are conservative budgets for a single opt-in local fake-provider Host: 16 pending pairing sessions leave capacity for normal clients and reject cheap socket exhaustion, and legitimate 2-KiB pairing JSON should finish within 5s on a nearby/private connection. Slow WAN networks may require an explicit reviewed adjustment, not silent infinite waits. Explicit close first stops accepting and destroys **all owned TCP connections** including unfinished TLS and HTTP, not only upgraded WS; CI/regression tests use trusted temporary TLS certificates and random localhost ports.

## Isolated reproduction

Create an owner-only disposable directory and a TLS certificate/key trusted by the intended client. Example config (replace every path, config/key permissions `0600` on Unix, pair file nonexistent):

```json
{
  "hostId": "desktop-dev-stable-random-id",
  "listen": "127.0.0.1",
  "port": 0,
  "tlsCertFile": "/absolute/dev/cert.pem",
  "tlsKeyFile": "/absolute/dev/key.pem",
  "pairCodeFile": "/absolute/private/one-use-code",
  "workspaces": [
    {
      "id": "demo",
      "label": "Isolated Demo",
      "cwd": "/absolute/disposable/workspace"
    }
  ]
}
```

```sh
npm run build
node dist/apps/cli/src/cli.js app-server \
  --provider fake --data-dir /absolute/disposable/zen-data \
  --cwd /absolute/disposable/workspace --listen ws://127.0.0.1:0 \
  --remote-host-config /absolute/private/remote.json
```

CLI prints WSS URL and protected code-file **path**, not code/token. Trusted TLS client POSTs `{hostId,deviceId,code}` to `/pair`, then WSS `/remote` with device/bearer headers and calls hello/workspaces/threads/create/resume/send/interrupt. SIGTERM closes listeners and removes the process's code file. Loopback/port zero is local only; binding a private-network address requires deliberate operator TLS deployment and is not done by tests. Never copy ZenX's bearer file to mobile.

Automated evidence: `test/remote-host*.test.ts` covers fake canonical model, temporary TLS certificate, actual HTTPS/WSS, two clients, idempotent retry, redacted snapshot, wrong host/workspace, revocation and CLI cleanup; R2 adds an unauthenticated slow-pair/handshake shutdown regression and complete paged recovery of >2 MiB of legitimate canonical history after reconnection, including new Item delivery during pagination and a single Unicode Item spanning pages. Tests do not invoke user shell or a paid provider. TLS tests skip when `openssl` is unavailable; other tests remain active.

## Known limitations / next seam

- **No ZenX Electron Host integration yet.** A follow-up must pass its live authorized Project/workspace projection across the existing Host boundary and provide explicit UI opt-in without duplicating settings or migrating the running Host. The CLI Host is an isolated proof, not the selected daily desktop device.
- No real-model operation/approval, persistent device grants, mobile enrollment UX, background push, certificate rotation, adaptive rate-limiting/full operational DoS protection, full attachments/tool transcript, or cloud relay. Finite connection/body/shutdown bounds are not a general-purpose production anti-DoS gateway. Real provider/tool exposure requires separate threat review and Host permission design.
- Headless protocol work has no functional UI screenshot. Evidence is this readable document, fixed tests, and PR CI. Later Android simulator evidence must identify its exact build/Host/scenario and label fake provider honestly.
