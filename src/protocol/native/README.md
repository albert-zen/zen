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
