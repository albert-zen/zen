# Native Thread recovery and deletion

Native ZAS deletion is recoverable and is not mapped to the pinned CAS adapter.
All three methods below require an initialized connection. Lifecycle changes
broadcast `zen/thread/event` with `thread_deleted_updated` and `deleted: boolean`
to initialized native sessions, including sessions not subscribed to that Thread.

- `zen/thread/delete { threadId, expectedLastItemId }` returns
  `{ threadId, deletionItemId }`. Obtain the fence from the healthy native summary's
  `lastItemId` or the last Item of a current native snapshot. Only an archived,
  idle Thread can be deleted. Active Turn cleanup, replacement intent/operation,
  and unfinished ToolTaskManager execution block deletion. A stale fence returns
  `stale_thread`; other explicit rejections include `thread_not_archived`,
  `thread_busy`, `thread_not_found`, and `invalid_request` in `error.data.zenCode`.
- `zen/thread/deleted/list {}` returns `{ data: DeletedThreadSummary[] }`, newest
  deletion first. Each summary contains `threadId`, optional `name`, `cwd`,
  `deletedAt`, and `deletionItemId`; it contains no transcript.
- `zen/thread/restore { threadId, deletionItemId }` returns `{ thread }` and
  restores that exact deletion to Archived. A stale deletion returns
  `stale_thread`. Unarchiving remains a separate explicit operation.

Deletion appends `thread_deleted` to the same journal. Restoration first persists
Archived product metadata, then appends `thread_restored` referencing the exact
deletion Item. Exact duplicate requests are idempotent only while their result
is still current. A delayed delete cannot delete a restored or changed Thread,
and an old restore cannot restore a later deletion. A failed or uncertain journal
append never returns success; clients should refresh instead of inventing a
successful removal.

Deleted Threads are absent from ordinary native/CAS lists and reject ordinary
read, resume, mutations, execution, and child/fork creation. A read-only Deleted
listing plus explicit restoration is the sole public recovery path. These
control Items are excluded from model context and CAS transcript projections.
Corrupt journals cannot be deleted because safe lifecycle state cannot be
established. Deletion never removes children, journal files, workspace files or
shared attachment blobs, and has no automatic retention/purge policy. As with
other Thread mutation fences, this is a single Host guarantee, not a distributed
writer lock between independent Hosts sharing a journal directory.

## Original compaction history

`zen/thread/original/read` requires an initialized, authorized local connection
and `{ threadId, throughItemId }` from an enabled stored compaction reference.
It uses the same AppServer read authority as `zen/thread/read`. It is not a
remote-host workspace grant or a CAS 0.146.0 claim.

- The default `granularity: "items"` returns at most `limit` (1–50, default 50)
  public Item previews in canonical order, newest page first. Pass `nextCursor`
  unchanged as `cursor` with the same Thread and cutoff to read an older page.
- `granularity: "item"` requires `itemId` inside that prefix and returns
  `format: "public_item_json"`, `content`, `offset`, `totalLength`, `truncated`
  and `nextCursor`. Concatenate the explicit 8,000-character chunks to recover
  the complete public Item. Item text and tool output are not summarized.
- Structured opaque provider data exposes only existing public summary and
  identity fields, recursively; lifecycle deletion/restoration controls are
  omitted consistently with the existing public history reader.
- Missing, disabled or invalid cutoffs, mismatched cursors and later Items fail
  explicitly. A reference never creates filesystem access or another transcript.

The older `thread/original/read` retains its legacy CAS display-item shape;
clients needing faithful public tool results and canonical identities use this
native reader.

## Exact-message Thread copies

`zen/thread/fork` accepts `{ sourceThreadId, through, workspace }` and returns
`{ thread: ThreadSnapshot }` with canonical Item identities. It requires an
initialized connection and an available AppServer. `workspace` is exactly
`{ type: "same-directory" }`; `through` is either `{ type: "latest-complete" }`
or `{ type: "item", itemId }`.

An exact Item boundary must identify a persisted `agent_message` in that source
Thread. Streaming-only identities, missing Items and identities from another
Thread return `fork_boundary_unavailable`; malformed requests and non-Agent
Items return `invalid_request`, via `error.data.zenCode`. Renaming a Thread or
appending later history does not change an existing canonical Item's identity.

The exact semantic prefix includes the selected message and excludes later source
content, including the rest of its Turn. When only usage observations separate
that message from its already-observed successful Turn completion, the copy also
retains that original completion receipt and timestamp, not a new local execution.
Otherwise the new Thread atomically stores remapped history, `thread_forked`
provenance with the exact source boundary, and canonical snapshot-only closures
for copied unfinished tools, Turns and queued inputs. These snapshot closures
report no transferred execution; they do not claim source success. Pending replacement intents remain historical
behind the fork provenance. A copy neither invokes a model nor replays tools nor
starts a new Turn. It is idle and ready for explicit new input, including after
journal reload, while the source remains untouched and may continue running.

The pinned CAS adapter's `thread/fork` retains only its existing
`latest-complete` request. It rejects exact Item selection; the native method's
canonical result and exact-boundary semantics are not CAS compatibility claims.
