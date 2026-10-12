"""Bounded request/response transport over the plugin child's existing pipe."""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Callable
from concurrent.futures import CancelledError, TimeoutError
from typing import BinaryIO, Protocol

MAX_LINE_BYTES = 1024 * 1024


class LineReader(Protocol):
    async def readline(self) -> bytes: ...


class ThreadedPipeReader:
    """Read inherited stdin without platform-specific overlapped-handle APIs.

    A single daemon thread performs bounded binary reads. One-slot queue
    admission applies backpressure before reading another line. It deliberately
    avoids asyncio's default executor, which would join a blocked stdin reader
    indefinitely during an unrelated fatal startup/transport failure.
    """

    def __init__(self, pipe: BinaryIO):
        self._loop = asyncio.get_running_loop()
        self._pipe = pipe
        self._queue: asyncio.Queue[bytes | Exception] = asyncio.Queue(maxsize=1)
        self._stop = threading.Event()
        self._done = asyncio.Event()
        self._submission = None
        self._thread = threading.Thread(
            target=self._read,
            name="imzenx-paw-stdin",
            daemon=True,
        )
        self._thread.start()

    async def readline(self) -> bytes:
        value = await self._queue.get()
        if isinstance(value, Exception):
            raise value
        return value

    def _submit(self, value: bytes | Exception) -> bool:
        enqueue = self._queue.put(value)
        try:
            submission = asyncio.run_coroutine_threadsafe(enqueue, self._loop)
            self._submission = submission
        except RuntimeError:
            enqueue.close()
            return False
        try:
            while not self._stop.is_set():
                try:
                    submission.result(timeout=0.1)
                    return True
                except TimeoutError:
                    continue
                except CancelledError:
                    return False
            submission.cancel()
            return False
        finally:
            self._submission = None

    def _read(self) -> None:
        try:
            while not self._stop.is_set():
                try:
                    line = self._pipe.readline(MAX_LINE_BYTES + 1)
                except Exception as error:
                    self._submit(error)
                    return
                if not isinstance(line, bytes) or len(line) > MAX_LINE_BYTES:
                    self._submit(ValueError("PAW stdin line exceeds transport limit"))
                    return
                if not self._submit(line) or not line:
                    return
        finally:
            try:
                self._loop.call_soon_threadsafe(self._done.set)
            except RuntimeError:
                pass  # A daemon read cannot keep a closed child process alive.

    def close(self) -> None:
        self._stop.set()
        submission = self._submission
        if submission is not None:
            submission.cancel()

    async def wait_closed(self) -> None:
        # EOF/error normally completes immediately. An open inherited stdin
        # cannot be interrupted portably; its daemon thread must not hold exit.
        try:
            async with asyncio.timeout(0.2):
                await self._done.wait()
        except TimeoutError:
            return
        self._thread.join(timeout=0)


class PawHostClient:
    def __init__(self, reader: LineReader, write: Callable[[str], None]):
        self._reader = reader
        self._write = write
        self._pending: dict[str, asyncio.Future] = {}
        self._sequence = 0
        self._closed = False

    async def request(self, operation: str, params: dict) -> dict:
        if self._closed:
            raise ConnectionError("PAW Host pipe is closed")
        if len(self._pending) >= 16:
            raise RuntimeError("PAW Host request capacity is exhausted")
        self._sequence += 1
        request_id = str(self._sequence)
        line = json.dumps(
            {
                "type": "paw-request",
                "id": request_id,
                "operation": operation,
                "params": params,
            },
            ensure_ascii=True,
        )
        if len(line.encode()) + 1 > MAX_LINE_BYTES:
            raise ValueError("PAW request exceeds transport limit")
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            self._write(line)
            async with asyncio.timeout(30):
                return await future
        finally:
            self._pending.pop(request_id, None)

    async def read_responses(self) -> None:
        try:
            while True:
                line = await self._reader.readline()
                if not line:
                    return
                if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
                    raise ValueError("PAW response exceeds transport limit or is incomplete")
                value = json.loads(line)
                if not isinstance(value, dict) or value.get("type") != "paw-response":
                    raise ValueError("Unexpected PAW Host response")
                request_id = value.get("id")
                if not isinstance(request_id, str):
                    raise ValueError("Invalid PAW response identifier")
                future = self._pending.get(request_id)
                if future is None or future.done():
                    continue  # A timed-out response cannot reauthorize a mutation.
                if "error" in value:
                    reason = value["error"]
                    if not isinstance(reason, str) or not reason:
                        reason = "PAW Host rejected the request"
                    future.set_exception(RuntimeError(reason[:512]))
                elif isinstance(value.get("result"), dict):
                    future.set_result(value["result"])
                else:
                    raise ValueError("Invalid PAW response result")
        finally:
            self._closed = True
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("PAW Host pipe closed before response"))
