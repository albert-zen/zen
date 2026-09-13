"""Real ZAS interop probe; only the external IM transport is a local test double."""

from __future__ import annotations

import asyncio
import json
import sys

from imagent.testing import FakeChannelAdapter
from test_gateway import inbound, sent_texts

from imzen.config import Settings
from imzen.main import create_gateway


async def main():
    config = json.loads(sys.stdin.readline())
    channel = FakeChannelAdapter("test")
    gateway, state = create_gateway(
        Settings.from_env(config["settings"]),
        channels=[channel],
        persistent_subscriptions=True,
    )
    try:
        await gateway.start()
        await channel.emit_message(inbound("subscribe-real", "/subscribe " + config["threadId"]))
        print(json.dumps({"event": "subscribed", "messages": sent_texts(channel)}), flush=True)
        async with asyncio.timeout(10):
            while not any("desktop-origin" in text for text in sent_texts(channel)):  # noqa: ASYNC110 - observe SDK test double delivery
                await asyncio.sleep(0.01)
        await channel.emit_message(inbound("im-real", "im-origin"))
        async with asyncio.timeout(10):
            while not any("im-origin" in text for text in sent_texts(channel)):  # noqa: ASYNC110 - observe SDK test double delivery
                await asyncio.sleep(0.01)
        print(json.dumps({"event": "synchronized", "messages": sent_texts(channel)}), flush=True)
        await channel.emit_message(inbound("im-new-command", "/new"))
        await channel.emit_message(inbound("im-new-input", "im-new-thread"))
        print(json.dumps({"event": "created-from-im"}), flush=True)
        await asyncio.to_thread(sys.stdin.read)
    finally:
        await gateway.stop()
        await state.close()


if __name__ == "__main__":
    asyncio.run(main())
