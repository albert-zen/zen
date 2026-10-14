"""Synthetic channel driver for actual SDK/native + private PAW pipe integration.

Only the IM transport is synthetic. Gateway, app-server client, PAW controller,
state and pipe codecs are production objects; no native or Room replies are faked.
The command multiplexer is test control, separate from PAW responses.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
from datetime import UTC, datetime

from imagent import Succeeded
from imagent.applications import ProjectRef, ThreadRef
from imagent.interaction.messages import ConversationRef, InboundMessage, TextContent
from imagent.testing import FakeChannelAdapter

from imzen.config import Settings
from imzen.main import create_gateway
from imzen.paw import PawController, PawState
from imzen.paw_pipe import PawHostClient, ThreadedPipeReader


def inbound(message_id, text=""):
    return InboundMessage(
        message_id=message_id,
        conversation_ref=ConversationRef("test", "synthetic-room-chat"),
        sender="owner",
        content=(TextContent(text),),
        created_at=datetime.now(UTC),
    )


def report(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


class Responses:
    def __init__(self):
        self.lines = asyncio.Queue()

    async def readline(self):
        return await self.lines.get()


async def main():
    config = json.loads(sys.stdin.readline())
    settings = Settings.from_env(config["settings"])
    reader = ThreadedPipeReader(sys.stdin.buffer)
    responses = Responses()
    commands = asyncio.Queue()
    host = PawHostClient(responses, lambda line: print(line, flush=True))
    deliveries = []

    class Channel(FakeChannelAdapter):
        async def send(self, message):
            receipt = await super().send(message)
            value = {
                "text": "\n".join(p.text for p in message.content if isinstance(p, TextContent)),
                "replyTo": message.reply_to,
            }
            deliveries.append(value)
            report({"event": "delivery", **value})
            return receipt

    async def multiplex():
        try:
            while line := await reader.readline():
                value = json.loads(line)
                if value.get("type") == "paw-response":
                    await responses.lines.put(line)
                else:
                    await commands.put(value)
        finally:
            await responses.lines.put(b"")
            await commands.put(None)

    gateway = sdk_state = room_state = paw = channel = None

    async def start():
        nonlocal gateway, sdk_state, room_state, paw, channel
        channel = Channel("test")
        room_state = PawState(settings.gateway_state_file.with_suffix(".paw.sqlite3"))
        paw = PawController(host, room_state, channel_instance_ids=frozenset({"test"}))
        gateway, sdk_state = create_gateway(
            settings,
            channels=[channel],
            local_app_server=True,
            persistent_subscriptions=True,
            controller_factory=paw.wrap,
            delivery_authorizer=paw,
            outbound_presentation=paw,
            startup_preparations=paw.startup_preparations(),
        )
        paw.attach(gateway)
        await gateway.start()

    async def stop():
        if gateway is not None:
            await gateway.stop()
        if sdk_state is not None:
            await sdk_state.close()
        if room_state is not None:
            room_state.close()

    async def snapshot():
        binding = await gateway.actions(
            inbound("inspect").conversation_ref, actor="owner"
        ).get_binding()
        selected = room_state.get(inbound("inspect").conversation_ref)
        filename = settings.gateway_state_file.with_suffix(".paw.sqlite3")
        with sqlite3.connect(filename.as_uri() + "?mode=ro", uri=True) as db:
            posts = db.execute("SELECT state, COUNT(*) FROM paw_inbound GROUP BY state").fetchall()
        return {
            "bindingThreadId": binding.thread_ref.thread_id
            if binding and binding.thread_ref
            else None,
            "bindingGeneration": binding.generation if binding else None,
            "roomId": selected.room_id if selected else None,
            "checkpoint": selected.checkpoint if selected else None,
            "postStates": dict(posts),
            "deliveries": deliveries,
        }

    tasks = [asyncio.create_task(multiplex()), asyncio.create_task(host.read_responses())]
    try:
        await start()
        report({"event": "ready", **await snapshot()})
        while (command := await commands.get()) is not None:
            try:
                action = command["action"]
                if action == "emit":
                    await channel.emit_message(inbound(command["messageId"], command["text"]))
                elif action == "poll":
                    await paw.poll_once()
                elif action == "restart":
                    await stop()
                    await start()
                elif action == "stage-stale-thread":
                    # A public bind represents an interrupted /pick between SDK
                    # admission and PAW clearing. No Gateway table mutation.
                    actions = gateway.actions(inbound("stage").conversation_ref, actor="owner")
                    binding = await actions.get_binding()
                    result = await actions.bind_thread(
                        ThreadRef(
                            ProjectRef("zen-main", settings.workspace_id), command["threadId"]
                        ),
                        action_id=command["actionId"],
                        expected_generation=binding.generation,
                    )
                    assert isinstance(result, Succeeded)
                elif action != "snapshot":
                    raise ValueError("Unknown test command")
                report({"id": command["id"], **await snapshot()})
            except Exception as error:
                report({"id": command["id"], "error": type(error).__name__, "detail": str(error)})
    finally:
        await stop()
        reader.close()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await reader.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
