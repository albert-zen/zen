"""Product read projection over ZAS's deliberately smaller list surface."""

from __future__ import annotations

import asyncio
from weakref import WeakValueDictionary

from imagent.applications.adapters.appserver.client import AppServerClient, AppServerError


class ImZenAppServerClient(AppServerClient):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # ZAS resume is an observation barrier, not a reentrant read. A caller
        # cancelling its wait cannot cancel a request already running natively.
        self._resume_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
        self._resume_tasks: set[asyncio.Task] = set()
        self._resume_closing = False
        self._resume_shutdown: asyncio.Task | None = None

    async def resume_thread(self, params=None, **kwargs):
        return await self._serialized_resume(super().resume_thread, params, kwargs)

    async def resume_thread_for_recovery(self, params=None, **kwargs):
        return await self._serialized_resume(super().resume_thread_for_recovery, params, kwargs)

    async def _serialized_resume(self, resume, params, kwargs):
        payload = dict(params or {})
        payload.update(kwargs)
        thread_id = payload.get("threadId")
        if not isinstance(thread_id, str) or not thread_id:
            raise ValueError("threadId must be a nonempty string")
        if self._resume_closing:
            raise AppServerError("IMZen client is closed")
        lock = self._resume_locks.get(thread_id)
        if lock is None:
            lock = asyncio.Lock()
            self._resume_locks[thread_id] = lock
        # Waiting callers remain directly cancellable and never dispatch.
        await lock.acquire()
        if self._resume_closing:
            lock.release()
            raise AppServerError("IMZen client is closed")
        # The admitted native operation owns its lock until its actual response,
        # SDK-bounded timeout/reset, or client close. Each caller still requests
        # a fresh snapshot; there is no result cache or additional retry.
        task = asyncio.create_task(resume(**payload))
        self._resume_tasks.add(task)
        task.add_done_callback(lambda done: self._resume_finished(done, lock))
        return await asyncio.shield(task)

    def _resume_finished(self, task, lock):
        # Task completion owns release even if close cancels it before its first
        # coroutine step, where a coroutine-local finally would not run.
        lock.release()
        self._resume_tasks.discard(task)
        # A cancelled caller no longer observes the result; still retrieve any
        # exception so teardown never leaves an unobserved background failure.
        if not task.cancelled():
            task.exception()

    async def close(self):
        if self._resume_shutdown is None:
            self._resume_closing = True
            self._resume_shutdown = asyncio.create_task(self._close_resumes())
            self._resume_shutdown.add_done_callback(self._observe_shutdown)
        # Repeated caller cancellation cannot interrupt transport/task cleanup.
        await asyncio.shield(self._resume_shutdown)

    @staticmethod
    def _observe_shutdown(task):
        if not task.cancelled():
            task.exception()

    async def _close_resumes(self):
        try:
            await super().close()
        finally:
            tasks = tuple(self._resume_tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def read_thread(self, thread_id: str, *, include_turns: bool = False):
        # ZAS resume attaches this socket to live events and returns the snapshot
        # behind its resume barrier. It does not activate any desktop window.
        # The pinned SDK has no native subscribe hook, so its authoritative reads
        # establish transport observation; SDK routes still gate IM recipients.
        result = await self.resume_thread(threadId=thread_id)
        if not include_turns:
            result = {**result, "thread": {**result["thread"], "turns": []}}
        return result

    async def list_threads(self, **params):
        # The pinned SDK asks for updated_at/searchTerm; ZAS owns ID-ordered
        # native pages. Drain a bounded snapshot before product sorting/filtering
        # rather than pretending that dropping a sort parameter preserves it.
        if params.get("cursor") is not None:
            raise ValueError("IMZen's bounded Thread list has no continuation cursor")
        if params.get("sortKey") not in {None, "updated_at"}:
            raise ValueError("Unsupported IMZen Thread sort key")
        threads = []
        cursor = None
        for _ in range(10):
            result = await super().list_threads(limit=100, cursor=cursor)
            threads.extend(result["data"])
            cursor = result.get("nextCursor")
            if cursor is None:
                break
        else:
            raise ValueError(
                "IM Thread list exceeds 1,000 Threads; use ZenX to archive older Threads"
            )
        query = str(params.get("searchTerm") or "").casefold()
        if query:
            threads = [
                thread
                for thread in threads
                if query
                in " ".join(
                    str(thread.get(key) or "") for key in ("id", "name", "preview")
                ).casefold()
            ]
        threads.sort(key=lambda thread: (thread.get("updatedAt", 0), thread["id"]), reverse=True)
        return {"data": threads, "nextCursor": None}
