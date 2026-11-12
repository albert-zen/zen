"""Actual native client resume lifecycle with server-owned deterministic barriers."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from imagent.applications.adapters.appserver.client import AppServerError, AppServerSupervisor

from imzen.client import ImZenAppServerClient


def report(event, **details):
    print(json.dumps({"event": event, **details}), flush=True)


async def main():
    config = json.loads(sys.stdin.readline())

    def create_client():
        return ImZenAppServerClient(
            supervisor=AppServerSupervisor(
                app_server_url=config["url"],
                app_server_auth_token_file=Path(config["tokenFile"]),
            ),
            client_info={"name": "resume-lifecycle", "version": "test"},
            request_timeout_s=0.5 if config["mode"] == "timeout" else 5,
        )

    client = create_client()
    tasks = []
    try:
        await client.connect()
        first = asyncio.create_task(client.read_thread(config["threadId"]))
        tasks.append(first)
        assert (await asyncio.to_thread(sys.stdin.readline)).strip() == "native-held"
        if config["mode"] == "cancel":
            first.cancel()
            try:
                await first
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("active caller did not cancel")
            queued_entered = asyncio.Event()

            async def recovery():
                queued_entered.set()
                return await client.resume_thread_for_recovery({"threadId": config["threadId"]})

            second = asyncio.create_task(recovery())
            tasks.append(second)
            await queued_entered.wait()
            # A separate native response is the barrier, never an arbitrary sleep.
            other = await client.read_thread(config["otherThreadId"])
            assert other["thread"]["id"] == config["otherThreadId"]
            assert not second.done(), "native resume owner was released by caller cancellation"
            report("independent-ready")
            result = await second
            assert result["thread"]["id"] == config["threadId"]
            report("complete", mode="cancel")
        elif config["mode"] == "close":
            queued_entered = asyncio.Event()

            async def queued_read():
                queued_entered.set()
                return await client.read_thread(config["threadId"])

            queued = asyncio.create_task(queued_read())
            tasks.append(queued)
            await queued_entered.wait()
            await client.close()
            results = await asyncio.gather(first, queued, return_exceptions=True)
            assert all(isinstance(value, BaseException) for value in results)
            try:
                await client.read_thread(config["threadId"])
            except AppServerError:
                pass
            else:
                raise AssertionError("closed client admitted another resume")
            client = create_client()
            assert (await client.read_thread(config["threadId"]))["thread"]["id"] == config[
                "threadId"
            ]
            report("complete", mode="close")
        elif config["mode"] == "timeout":
            try:
                await first
            except AppServerError as exc:
                assert "timed out" in str(exc), str(exc)
            else:
                raise AssertionError("held native request did not time out")
            # An explicit new call obtains its own snapshot after SDK reset; the
            # cancelled/timed-out first operation is not replayed by the consumer.
            assert (await client.read_thread(config["threadId"]))["thread"]["id"] == config[
                "threadId"
            ]
            report("complete", mode="timeout")
        else:
            raise AssertionError("unknown fixture mode")
    finally:
        await client.close()
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
