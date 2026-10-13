"""ZAS observation and bounded native pagination stay product-owned."""

from __future__ import annotations

import asyncio

import pytest
from imagent.applications.adapters.appserver.client import (
    AppServerClient,
    AppServerError,
    AppServerSupervisor,
)

from imzen.client import ImZenAppServerClient


def create_client():
    return ImZenAppServerClient(
        supervisor=AppServerSupervisor(app_server_url="ws://127.0.0.1:4500"),
        client_info={"name": "test", "version": "test"},
    )


@pytest.mark.asyncio
async def test_authoritative_read_resumes_observation_without_desktop_activation(monkeypatch):
    calls = []

    async def resume(self, **kwargs):
        calls.append(kwargs)
        return {"thread": {"id": "thread", "turns": [{"id": "turn"}], "status": {"type": "idle"}}}

    monkeypatch.setattr(AppServerClient, "resume_thread", resume)
    client = create_client()
    assert (await client.read_thread("thread"))["thread"]["turns"] == []
    assert (await client.read_thread("thread", include_turns=True))["thread"]["turns"] == [
        {"id": "turn"}
    ]
    assert calls == [{"threadId": "thread"}, {"threadId": "thread"}]


@pytest.mark.asyncio
async def test_thread_pages_are_drained_before_product_sort_and_search(monkeypatch):
    calls = []
    pages = {
        None: {"data": [{"id": "a", "name": "Task one", "updatedAt": 1}], "nextCursor": "a"},
        "a": {"data": [{"id": "b", "preview": "TASK two", "updatedAt": 3}], "nextCursor": "b"},
        "b": {"data": [{"id": "c", "name": "different", "updatedAt": 4}], "nextCursor": None},
    }

    async def listing(self, **kwargs):
        calls.append(kwargs)
        return pages[kwargs["cursor"]]

    monkeypatch.setattr(AppServerClient, "list_threads", listing)
    client = create_client()
    result = await client.list_threads(sortKey="updated_at", searchTerm="task")
    assert [thread["id"] for thread in result["data"]] == ["b", "a"]
    assert result["nextCursor"] is None
    assert calls == [{"limit": 100, "cursor": cursor} for cursor in (None, "a", "b")]


@pytest.mark.asyncio
async def test_thread_snapshot_bound_fails_instead_of_returning_a_partial_list(monkeypatch):
    calls = 0

    async def listing(self, **kwargs):
        nonlocal calls
        calls += 1
        return {"data": [{"id": str(calls), "updatedAt": calls}], "nextCursor": str(calls)}

    monkeypatch.setattr(AppServerClient, "list_threads", listing)
    client = create_client()
    with pytest.raises(ValueError, match="exceeds 1,000"):
        await client.list_threads()
    assert calls == 10


@pytest.mark.asyncio
@pytest.mark.parametrize("params", [{"cursor": "second"}, {"sortKey": "created_at"}])
async def test_unsupported_product_pagination_never_calls_native(monkeypatch, params):
    async def listing(self, **kwargs):
        raise AssertionError("unsupported product query reached native transport")

    monkeypatch.setattr(AppServerClient, "list_threads", listing)
    client = create_client()
    with pytest.raises(ValueError):
        await client.list_threads(**params)


@pytest.mark.asyncio
async def test_reads_and_direct_resumes_serialize_only_the_same_thread(monkeypatch):
    first_entered = asyncio.Event()
    release = asyncio.Event()
    same_started = asyncio.Event()
    calls = []
    active = set()

    async def resume(self, **kwargs):
        thread = kwargs["threadId"]
        assert thread not in active, "native ZAS rejects overlapping resumes"
        active.add(thread)
        calls.append(thread)
        try:
            if len(calls) == 1:
                first_entered.set()
                await release.wait()
            return {"thread": {"id": thread, "turns": [], "status": {"type": "idle"}}}
        finally:
            active.remove(thread)

    monkeypatch.setattr(AppServerClient, "resume_thread", resume)
    client = create_client()
    first = asyncio.create_task(client.read_thread("same"))
    await first_entered.wait()

    async def same_thread():
        same_started.set()
        return await client.resume_thread(threadId="same")

    queued = asyncio.create_task(same_thread())
    await same_started.wait()
    try:
        other = await client.read_thread("independent")
        assert other["thread"]["id"] == "independent"
        assert calls == ["same", "independent"]
    finally:
        release.set()
        results = await asyncio.gather(first, queued, return_exceptions=True)
    assert all(isinstance(result, dict) for result in results)
    assert calls == ["same", "independent", "same"]


@pytest.mark.asyncio
async def test_resume_failure_and_queued_cancellation_leave_no_false_success(monkeypatch):
    entered = asyncio.Event()
    release = asyncio.Event()
    queued_started = asyncio.Event()
    calls = 0

    async def resume(self, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            await release.wait()
            raise ConnectionError("synthetic connection loss")
        return {"thread": {"id": kwargs["threadId"], "turns": []}}

    monkeypatch.setattr(AppServerClient, "resume_thread", resume)
    client = create_client()
    first = asyncio.create_task(client.read_thread("same"))
    await entered.wait()

    async def queued_read():
        queued_started.set()
        return await client.read_thread("same")

    queued = asyncio.create_task(queued_read())
    await queued_started.wait()
    queued.cancel()
    with pytest.raises(asyncio.CancelledError):
        await queued
    release.set()
    with pytest.raises(ConnectionError):
        await first
    assert calls == 1
    assert (await client.read_thread("same"))["thread"]["id"] == "same"
    assert calls == 2


@pytest.mark.asyncio
async def test_active_cancellation_keeps_native_owner_and_recovery_shares_admission(monkeypatch):
    entered = asyncio.Event()
    release = asyncio.Event()
    queued_started = asyncio.Event()
    calls = []

    async def resume(self, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            entered.set()
            await release.wait()
        return {"thread": {"id": kwargs["threadId"], "turns": []}}

    monkeypatch.setattr(AppServerClient, "resume_thread", resume)
    monkeypatch.setattr(AppServerClient, "resume_thread_for_recovery", resume)
    client = create_client()
    first = asyncio.create_task(client.resume_thread({"threadId": "same"}))
    await entered.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    async def recovery():
        queued_started.set()
        return await client.resume_thread_for_recovery({"threadId": "same"}, cwd="synthetic")

    queued = asyncio.create_task(recovery())
    await queued_started.wait()
    assert (await client.read_thread("independent"))["thread"]["id"] == "independent"
    assert calls == [{"threadId": "same"}, {"threadId": "independent"}]
    assert not queued.done()
    release.set()
    assert (await queued)["thread"]["id"] == "same"
    assert calls[-1] == {"threadId": "same", "cwd": "synthetic"}
    await client.close()


@pytest.mark.asyncio
async def test_close_fences_waiters_and_survives_repeated_caller_cancellation(monkeypatch):
    entered = asyncio.Event()
    native_finished = asyncio.Event()
    close_entered = asyncio.Event()
    close_release = asyncio.Event()
    queued_started = asyncio.Event()
    calls = []
    closes = 0

    async def resume(self, **kwargs):
        calls.append(kwargs["threadId"])
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            native_finished.set()

    async def close(self):
        nonlocal closes
        closes += 1
        close_entered.set()
        await close_release.wait()

    monkeypatch.setattr(AppServerClient, "resume_thread", resume)
    monkeypatch.setattr(AppServerClient, "close", close)
    client = create_client()
    first = asyncio.create_task(client.read_thread("same"))
    await entered.wait()

    async def queued_read():
        queued_started.set()
        return await client.read_thread("same")

    queued = asyncio.create_task(queued_read())
    await queued_started.wait()
    for _ in range(2):
        closing = asyncio.create_task(client.close())
        await close_entered.wait()
        # A different-thread admission observes the close fence immediately.
        with pytest.raises(AppServerError, match="client is closed"):
            await client.read_thread("other")
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
    assert not native_finished.is_set()
    close_release.set()
    await client.close()
    assert native_finished.is_set()
    assert closes == 1
    assert calls == ["same"]
    with pytest.raises(asyncio.CancelledError):
        await first
    with pytest.raises(AppServerError, match="client is closed"):
        await queued
    with pytest.raises(AppServerError, match="client is closed"):
        await client.resume_thread_for_recovery(threadId="same")


@pytest.mark.asyncio
async def test_owner_cancelled_before_first_step_still_releases_thread_admission(monkeypatch):
    calls = 0

    async def resume(self, **kwargs):
        nonlocal calls
        calls += 1
        return {"thread": {"id": kwargs["threadId"], "turns": []}}

    monkeypatch.setattr(AppServerClient, "resume_thread", resume)
    client = create_client()
    create_task = asyncio.create_task

    def cancelled_owner(coroutine):
        task = create_task(coroutine)
        task.cancel()
        return task

    with monkeypatch.context() as patch:
        patch.setattr(asyncio, "create_task", cancelled_owner)
        with pytest.raises(asyncio.CancelledError):
            await client.read_thread("same")
    assert calls == 0
    result = await asyncio.wait_for(client.read_thread("same"), timeout=1)
    assert result["thread"]["id"] == "same"
    assert calls == 1
    await client.close()
