"""Real IMZen consumer over authenticated native Zen with a synthetic IM transport.

Only the channel and optional PAW room transport are synthetic. Settings,
Controller, application client, Gateway and SQLite persistence are production.
Observers record requests without fabricating results or replacing behavior.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
from dataclasses import replace
from pathlib import Path

from imagent.applications.adapters.appserver.client import AppServerSupervisor
from imagent.interaction.media import AttachmentContent, LocalPath
from imagent.interaction.messages import TextContent
from imagent.testing import FakeChannelAdapter
from test_gateway import inbound
from test_paw import FakeRooms

from imzen.client import ImZenAppServerClient
from imzen.config import Settings
from imzen.main import create_gateway
from imzen.paw import PawController, PawState


def report(payload):
    print(json.dumps(payload), flush=True)


def delivery(message):
    return {
        "text": "\n".join(part.text for part in message.content if isinstance(part, TextContent)),
        "formats": [part.format.value for part in message.content if isinstance(part, TextContent)],
        "replyTo": message.reply_to,
        "conversation": message.conversation_ref.native_conversation_id,
    }


class ObservedChannel(FakeChannelAdapter):
    def __init__(self, deliveries):
        super().__init__("test")
        self.deliveries = deliveries

    async def send(self, message):
        receipt = await super().send(message)
        value = delivery(message)
        self.deliveries.append(value)
        report({"event": "delivery", **value})
        return receipt


class ObservedClient(ImZenAppServerClient):
    def __init__(self, settings, wire_calls):
        super().__init__(
            supervisor=AppServerSupervisor(
                app_server_url=settings.app_server_url,
                app_server_auth_token_file=settings.app_server_auth_token_file,
            ),
            client_info={"name": "imzen-queue-test", "title": "IMZen", "version": "test"},
            shared_filesystem_verifier=settings.app_server_shared_filesystem_root.is_dir,
        )
        self.wire_calls = wire_calls

    async def _send_json(self, payload, **kwargs):
        if payload.get("method") in {
            "thread/start",
            "turn/start",
            "turn/steer",
            "zen/turn/send",
            "zen/turn/send-unarchived",
            "zen/thread/queue/cancel",
        }:
            self.wire_calls.append({"method": payload["method"], "params": payload["params"]})
        return await super()._send_json(payload, **kwargs)


async def main():
    config = json.loads(sys.stdin.readline())
    environment = dict(config["settings"])
    wire_calls, deliveries = [], []
    settings = Settings.from_env(environment)
    gateway = state = paw_state = paw = channel = None
    rooms = FakeRooms()

    async def start():
        nonlocal settings, gateway, state, paw_state, paw, channel
        settings = Settings.from_env(environment)
        client = ObservedClient(settings, wire_calls)
        channel = ObservedChannel(deliveries)
        options = {}
        if config.get("paw"):
            paw_state = PawState(settings.cwd / "paw.sqlite3")
            paw = PawController(rooms, paw_state, channel_instance_ids=frozenset({"test"}))
            options = {
                "controller_factory": paw.wrap,
                "delivery_authorizer": paw,
                "outbound_presentation": paw,
                "startup_preparations": paw.startup_preparations(),
            }
        gateway, state = create_gateway(
            settings, client=client, channels=[channel], persistent_subscriptions=True, **options
        )
        if paw:
            paw.attach(gateway)
        await gateway.start()

    async def stop():
        await gateway.stop()
        await state.close()
        if paw_state:
            paw_state.close()

    async def snapshot():
        # Synthetic database, read-only: verify durable reply routing without
        # implementing a second queue or mutating any SDK-owned receipt table.
        with sqlite3.connect(settings.gateway_state_file.as_uri() + "?mode=ro", uri=True) as db:
            correlations = db.execute(
                "SELECT thread_id, turn_id, reply_to_message_id, client_message_id "
                "FROM turn_reply_correlations ORDER BY correlation_id"
            ).fetchall()
            queued = db.execute(
                "SELECT message_id, native_conversation_id, actor_fingerprint, thread_id, "
                "client_message_id, input_fingerprint, receipt_state, turn_id "
                "FROM queued_input_correlations ORDER BY message_id"
            ).fetchall()
        conversation = inbound("snapshot").conversation_ref
        binding = await gateway.actions(conversation, actor="owner").get_binding()
        room = paw_state.get(conversation) if paw_state else None
        return {
            "inputContinuation": settings.input_continuation,
            "bindingThreadId": binding.thread_ref.thread_id
            if binding and binding.thread_ref
            else None,
            "pawRoomId": room.room_id if room else None,
            "wireCalls": wire_calls,
            "deliveries": deliveries,
            "queueReceipts": [
                {
                    "messageId": row[0],
                    "conversation": row[1],
                    "actorFingerprint": row[2],
                    "threadId": row[3],
                    "clientMessageId": row[4],
                    "inputFingerprint": row[5],
                    "state": row[6],
                    "turnId": row[7],
                }
                for row in queued
            ],
            "correlations": [
                {
                    "threadId": item[0],
                    "turnId": item[1],
                    "replyTo": item[2],
                    "clientMessageId": item[3],
                }
                for item in correlations
            ],
        }

    try:
        await start()
        report({"event": "ready", **await snapshot()})
        while line := await asyncio.to_thread(sys.stdin.readline):
            command = json.loads(line)
            try:
                if command["action"] == "emit":
                    content = [TextContent(command["text"])]
                    if command.get("image"):
                        image = Path(command["image"])
                        content.append(
                            AttachmentContent(
                                attachment_id="image-" + command["messageId"],
                                source=LocalPath(image),
                                media_type="image/png",
                                filename=image.name,
                                # Legacy path-only image shape exercises IMZen's
                                # safe-root size/bytes bridge before native dispatch.
                                size_bytes=None,
                            )
                        )
                    message = inbound(
                        command["messageId"],
                        content=tuple(content),
                        conversation_id=command.get("conversation", "chat-1"),
                    )
                    if command.get("actor"):
                        message = replace(message, sender=command["actor"])
                    # Bounded ingress proves queue receipt does not hold the
                    # input/control path until the model or approval completes.
                    await asyncio.wait_for(channel.emit_message(message), timeout=3)
                elif command["action"] == "restart":
                    await stop()
                    environment["IMZEN_INPUT_CONTINUATION"] = command["mode"]
                    await start()
                elif command["action"] != "snapshot":
                    raise ValueError("unknown probe command")
                report({"id": command["id"], **await snapshot()})
            except Exception as error:
                report({"id": command["id"], "error": type(error).__name__, "detail": str(error)})
    finally:
        if gateway:
            await stop()


if __name__ == "__main__":
    asyncio.run(main())
