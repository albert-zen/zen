"""Synthetic IM transport over the real product Gateway, SDK, and ZAS socket.

The observing subclasses only report real requests/deliveries. They never return
native responses or substitute Application/Gateway behavior.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from imagent.applications.appserver_client import AppServerError, AppServerSupervisor
from imagent.contracts import (
    ApplicationInputRejected,
    AttachmentContent,
    LocalPath,
    TextContent,
    ThreadRef,
)
from imagent.testing import FakeChannelAdapter
from test_gateway import inbound

from imzen.client import ImZenAppServerClient
from imzen.config import Settings
from imzen.main import create_gateway


def report(payload):
    print(json.dumps(payload), flush=True)


def delivery(message):
    return {
        "text": "\n".join(part.text for part in message.content if isinstance(part, TextContent)),
        "replyTo": message.reply_to,
    }


class ObservedChannel(FakeChannelAdapter):
    async def send(self, message):
        receipt = await super().send(message)
        report({"event": "delivery", **delivery(message)})
        return receipt


class ObservedClient(ImZenAppServerClient):
    def __init__(self, settings):
        super().__init__(
            supervisor=AppServerSupervisor(
                app_server_url=settings.app_server_url,
                app_server_auth_token_file=settings.app_server_auth_token_file,
            ),
            client_info={"name": "imzen-steering-test", "title": "IMZen", "version": "test"},
            shared_filesystem_verifier=settings.app_server_shared_filesystem_root.is_dir,
        )
        self.calls = []
        self.wire_calls = []

    async def _send_json(self, payload, **kwargs):
        if payload.get("method") in {"turn/start", "turn/steer"}:
            self.wire_calls.append({"method": payload["method"], "params": payload["params"]})
        return await super()._send_json(payload, **kwargs)

    async def _request(self, method, params, **kwargs):
        if method in {"turn/start", "turn/steer"}:
            self.calls.append(
                {
                    "method": method,
                    "params": params,
                    "imageEpoch": kwargs.get("expected_local_image_epoch"),
                }
            )
        return await super()._request(method, params, **kwargs)


async def main():
    config = json.loads(sys.stdin.readline())
    settings = Settings.from_env(config["settings"])
    client = ObservedClient(settings)
    channel = ObservedChannel("test")
    gateway, state = create_gateway(
        settings,
        client=client,
        channels=[channel],
        persistent_subscriptions=True,
    )
    thread_ref = ThreadRef("zen-main", config["threadId"])

    async def snapshot():
        correlations = await state.list_turn_reply_correlations(thread_ref)
        return {
            "calls": client.calls,
            "wireCalls": client.wire_calls,
            "deliveries": [delivery(message) for message in channel.sent],
            "imageEpoch": client.local_image_paths_epoch(),
            "correlations": [
                {
                    "turnId": item.turn_id,
                    "replyTo": item.reply_to_message_id,
                    "clientMessageId": item.client_message_id,
                }
                for item in correlations
            ],
        }

    try:
        await gateway.start()
        await channel.emit_message(
            inbound("subscribe-steering", "/subscribe " + thread_ref.native_thread_id)
        )
        report({"event": "ready", **await snapshot()})
        while line := await asyncio.to_thread(sys.stdin.readline):
            command = json.loads(line)
            try:
                if command["action"] == "emit":
                    content = [TextContent(command["text"])]
                    for key, media_type in (("image", "image/png"), ("file", "text/plain")):
                        if command.get(key):
                            filename = Path(command[key])
                            content.append(
                                AttachmentContent(
                                    attachment_id=key + "-" + command["messageId"],
                                    source=LocalPath(filename),
                                    media_type=media_type,
                                    filename=filename.name,
                                )
                            )
                    await channel.emit_message(
                        inbound(command["messageId"], content=tuple(content))
                    )
                elif command["action"] == "image-epoch-steer":
                    try:
                        await client.steer_turn(
                            thread_ref.native_thread_id,
                            command["expectedTurnId"],
                            input_items=[{"type": "localImage", "path": command["image"]}],
                            expected_local_image_epoch=command["imageEpoch"],
                        )
                    except AppServerError as error:
                        if "cannot read bridge-local image paths for this connection" not in str(
                            error
                        ):
                            raise
                        report({"id": command["id"], "rejected": "image_epoch", **await snapshot()})
                        continue
                    raise AssertionError(
                        "unverified image epoch unexpectedly reached native dispatch"
                    )
                elif command["action"] == "fenced-steer":
                    try:
                        await client.steer_turn(
                            thread_ref.native_thread_id,
                            command["expectedTurnId"],
                            command["text"],
                        )
                    except ApplicationInputRejected as error:
                        report({"id": command["id"], "rejected": error.reason, **await snapshot()})
                        continue
                    raise AssertionError("native fenced steer unexpectedly succeeded")
                elif command["action"] != "snapshot":
                    raise ValueError("unknown probe command")
                report({"id": command["id"], **await snapshot()})
            except Exception as error:
                report({"id": command["id"], "error": type(error).__name__, "detail": str(error)})
    finally:
        await gateway.stop()
        await state.close()


if __name__ == "__main__":
    asyncio.run(main())
