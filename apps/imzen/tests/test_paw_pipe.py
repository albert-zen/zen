from __future__ import annotations

import asyncio
import json

import pytest

from imzen.paw_pipe import MAX_LINE_BYTES, PawHostClient


@pytest.mark.asyncio
async def test_pipe_correlates_out_of_order_responses_and_preserves_host_reason():
    reader = asyncio.StreamReader(limit=MAX_LINE_BYTES)
    written = []
    host = PawHostClient(reader, written.append)
    read_task = asyncio.create_task(host.read_responses())
    first = asyncio.create_task(host.request("list", {}))
    second = asyncio.create_task(host.request("read", {"roomId": "room-1"}))
    await asyncio.sleep(0)
    requests = [json.loads(line) for line in written]
    assert [request["type"] for request in requests] == ["paw-request", "paw-request"]
    reader.feed_data(
        (
            json.dumps(
                {
                    "type": "paw-response",
                    "id": requests[1]["id"],
                    "error": "Room workspace mismatch",
                }
            )
            + "\n"
        ).encode()
    )
    reader.feed_data(
        (
            json.dumps(
                {
                    "type": "paw-response",
                    "id": requests[0]["id"],
                    "result": {"rooms": []},
                }
            )
            + "\n"
        ).encode()
    )
    assert await first == {"rooms": []}
    with pytest.raises(RuntimeError, match="workspace mismatch"):
        await second
    reader.feed_eof()
    await read_task
    with pytest.raises(ConnectionError, match="closed"):
        await host.request("list", {})


@pytest.mark.asyncio
async def test_pipe_eof_rejects_pending_request_without_leaving_reader():
    reader = asyncio.StreamReader(limit=MAX_LINE_BYTES)
    host = PawHostClient(reader, lambda line: None)
    read_task = asyncio.create_task(host.read_responses())
    request = asyncio.create_task(host.request("post", {"roomId": "room-1"}))
    await asyncio.sleep(0)
    reader.feed_eof()
    await read_task
    with pytest.raises(ConnectionError, match="before response"):
        await request


@pytest.mark.asyncio
async def test_pipe_bounds_requests_and_rejects_truncated_response():
    reader = asyncio.StreamReader(limit=MAX_LINE_BYTES)
    written = []
    host = PawHostClient(reader, written.append)
    with pytest.raises(ValueError, match="transport limit"):
        await host.request("post", {"text": "x" * MAX_LINE_BYTES})
    assert not written
    reader.feed_data(b'{"type":"paw-response"}')
    reader.feed_eof()
    with pytest.raises(ValueError, match="incomplete"):
        await host.read_responses()


@pytest.mark.asyncio
async def test_zenx_eof_stops_gateway_and_poll_tasks(monkeypatch, tmp_path):
    import io
    from types import SimpleNamespace

    import imzen.zenx as zenx

    calls = []
    config = {
        "IMZEN_APP_SERVER_URL": "ws://127.0.0.1:4500",
        "IMZEN_CWD": str(tmp_path),
        "IMZEN_GATEWAY_STATE_FILE": str(tmp_path / "gateway.sqlite3"),
    }
    stdin = io.BytesIO((json.dumps(config) + "\n").encode())

    async def connect(*args):
        raise AssertionError("inherited stdin must not require connect_read_pipe")

    class Gateway:
        async def start(self):
            calls.append("gateway-start")

        async def stop(self):
            calls.append("gateway-stop")

    class State:
        async def close(self):
            calls.append("state-close")

    def compose(settings, **kwargs):
        assert kwargs["persistent_subscriptions"]
        return Gateway(), State()

    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "connect_read_pipe", connect)
    monkeypatch.setattr(zenx.sys, "stdin", SimpleNamespace(buffer=stdin))
    monkeypatch.setattr(zenx, "create_gateway", compose)
    monkeypatch.setattr(zenx, "normalize_proxy_exclusions", lambda: None)
    async with asyncio.timeout(1):
        await zenx.run()
    assert calls == ["gateway-start", "gateway-stop", "state-close"]
    assert not any(task.get_name().startswith("imzenx-paw") for task in asyncio.all_tasks())


@pytest.mark.asyncio
async def test_request_wire_is_ascii_json_with_newline_and_unicode_roundtrip():
    reader = asyncio.StreamReader(limit=MAX_LINE_BYTES)
    written = []
    host = PawHostClient(reader, lambda line: written.append((line + "\n").encode("ascii")))
    task = asyncio.create_task(host.request("post", {"roomId": "room-1", "text": "你好，PAW"}))
    await asyncio.sleep(0)
    if task.done():
        task.result()
    request = json.loads(written[0])
    assert written[0].endswith(b"\n")
    assert request["params"]["text"] == "你好，PAW"
    read_task = asyncio.create_task(host.read_responses())
    reader.feed_data(
        (
            json.dumps(
                {
                    "type": "paw-response",
                    "id": request["id"],
                    "result": {"messageId": "posted"},
                }
            )
            + "\n"
        ).encode()
    )
    assert await task == {"messageId": "posted"}
    reader.feed_eof()
    await read_task


@pytest.mark.asyncio
async def test_threaded_reader_bounds_lines_backpressure_and_eof():
    import io

    from imzen.paw_pipe import ThreadedPipeReader

    reader = ThreadedPipeReader(io.BytesIO(b"first\nsecond\n"))
    try:
        assert await reader.readline() == b"first\n"
        assert await reader.readline() == b"second\n"
        assert await reader.readline() == b""
        await reader.wait_closed()
    finally:
        reader.close()
    oversized = ThreadedPipeReader(io.BytesIO(b"x" * (MAX_LINE_BYTES + 1)))
    try:
        with pytest.raises(ValueError, match="transport limit"):
            await oversized.readline()
        await oversized.wait_closed()
    finally:
        oversized.close()


async def spawn_probe(script):
    import os
    import sys
    from pathlib import Path

    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            [
                str(Path(__file__).parents[1] / "src"),
                str(Path(__file__).parent),
            ]
        ),
    }
    return await asyncio.create_subprocess_exec(
        sys.executable,
        "-u",
        "-c",
        script,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )


@pytest.mark.asyncio
async def test_real_child_pipe_posts_unicode_room_reply_and_exits_on_eof(tmp_path):
    # Real inherited process pipes, actual SDK Gateway, no account keys or IM
    # transport. This is reproducible on each platform that runs the test suite.
    script = """
import asyncio
import json
from imagent.testing import FakeChannelAdapter
from test_gateway import FakeAppServer, inbound
import imzen.zenx as zenx
from imzen.main import create_gateway

class ProbeChannel(FakeChannelAdapter):
    async def send(self, message):
        result = await super().send(message)
        print(json.dumps({"type": "probe-delivery", "text": "\\n".join(
            part.text for part in message.content
        )}), flush=True)
        return result

def compose(settings, **kwargs):
    channel = ProbeChannel("test")
    gateway, state = create_gateway(
        settings, client=FakeAppServer(), channels=[channel], **kwargs
    )
    original_start = gateway.start
    async def start():
        await original_start()
        await channel.emit_message(inbound("select", "/paw room-1"))
        await channel.emit_message(inbound("input", "你好，正式 Room"))
    gateway.start = start
    return gateway, state

zenx.create_gateway = compose
asyncio.run(zenx.run())
"""
    process = await spawn_probe(script)
    ready = formal = False
    posts = []
    try:
        process.stdin.write(
            (
                json.dumps(
                    {
                        "IMZEN_APP_SERVER_URL": "ws://127.0.0.1:4500",
                        "IMZEN_CWD": str(tmp_path),
                        "IMZEN_GATEWAY_STATE_FILE": str(tmp_path / "gateway.sqlite3"),
                    }
                )
                + "\n"
            ).encode("ascii")
        )
        await process.stdin.drain()
        async with asyncio.timeout(5):
            while not formal:
                line = await process.stdout.readline()
                assert line, (await process.stderr.read()).decode(errors="replace")
                value = json.loads(line)
                if value["type"] == "paw-request":
                    assert line.isascii()
                    if value["operation"] == "read":
                        result = {
                            "room": {
                                "id": "room-1",
                                "name": "Pipe PAW",
                                "threadId": "thread-1",
                                "operationEpoch": "11111111-1111-4111-8111-111111111111",
                            },
                            "messages": []
                            if not ready
                            else [
                                {
                                    "id": "formal-1",
                                    "roomId": "room-1",
                                    "kind": "agent",
                                    "author": "PAW",
                                    "text": "正式回复已送达",
                                    "createdAt": 1000,
                                    "originThreadId": "working-private",
                                    "originTurnId": None,
                                }
                            ],
                        }
                    else:
                        assert value["operation"] == "post"
                        posts.append(value["params"])
                        result = {"messageId": "human-1", "threadId": "thread-1"}
                    process.stdin.write(
                        (
                            json.dumps(
                                {
                                    "type": "paw-response",
                                    "id": value["id"],
                                    "result": result,
                                }
                            )
                            + "\n"
                        ).encode("ascii")
                    )
                    await process.stdin.drain()
                elif value["type"] == "ready":
                    ready = True
                elif value["type"] == "probe-delivery":
                    formal = value["text"] == "正式回复已送达"
        assert [post["text"] for post in posts] == ["你好，正式 Room"]
        process.stdin.close()
        await process.stdin.wait_closed()
        async with asyncio.timeout(5):
            assert await process.wait() == 0
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


@pytest.mark.asyncio
async def test_real_child_failure_exits_even_when_parent_stdin_stays_open():
    process = await spawn_probe("import runpy; runpy.run_module('imzen.zenx', run_name='__main__')")
    try:
        # Missing deployment fields cause a fatal startup error after the daemon
        # has read its first line and is waiting for another line on open stdin.
        process.stdin.write(b"{}\n")
        await process.stdin.drain()
        async with asyncio.timeout(3):
            line = await process.stdout.readline()
            assert line.isascii() and line.endswith(b"\n")
            assert json.loads(line)["type"] == "failed"
            assert await process.wait() == 1
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


@pytest.mark.asyncio
async def test_threaded_reader_backpressures_and_cancels_queued_admission():
    import threading

    from imzen.paw_pipe import ThreadedPipeReader

    class Source:
        def __init__(self):
            self.reads = 0
            self.second = threading.Event()

        def readline(self, limit):
            assert limit == MAX_LINE_BYTES + 1
            self.reads += 1
            if self.reads == 2:
                self.second.set()
            return b"bounded\n"

    source = Source()
    reader = ThreadedPipeReader(source)
    try:
        assert await asyncio.to_thread(source.second.wait, 0.5)
        # One queued line plus one bounded thread-held line, never an unbounded
        # call_soon_threadsafe callback backlog or whole-stream buffer.
        assert source.reads == 2
    finally:
        reader.close()
        async with asyncio.timeout(1):
            await reader.wait_closed()
    assert source.reads == 2
