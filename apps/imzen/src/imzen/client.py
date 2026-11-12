"""Product read projection over ZAS's deliberately smaller list surface."""

from __future__ import annotations

from imagent.applications.adapters.appserver.client import AppServerClient


class ImZenAppServerClient(AppServerClient):
    async def read_thread(self, thread_id: str, *, include_turns: bool = False):
        # ZAS resume attaches this socket to live events and returns the snapshot
        # behind its resume barrier. It does not activate any desktop window.
        # These product-authoritative reads also establish output observation.
        # The SDK owns all public resume admission, cancellation and close tasks;
        # its projection routes remain the authority for IM recipients.
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
