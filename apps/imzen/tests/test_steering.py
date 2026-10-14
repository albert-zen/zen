"""The locked SDK's input policy through the production IMZen composition."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from imagent.applications import (
    AgentInput,
    ApplicationInputRejected,
    ProjectRef,
    ThreadRef,
    ZenApplicationAdapter,
)
from imagent.interaction.media import AttachmentContent, LocalPath
from imagent.interaction.messages import TextContent
from imagent.testing import FakeChannelAdapter
from test_gateway import FakeAppServer, inbound, sent_texts

from imzen.config import Settings
from imzen.main import create_gateway


class ActiveServer(FakeAppServer):
    """Controllable native boundary; actual native ZAS is covered by test:imzenx."""

    def __init__(self):
        super().__init__()
        self.steered = []
        self.fail_steer = None

    async def start_turn(self, thread_id, text=None, **params):
        result = await super().start_turn(thread_id, text, **params)
        self.threads[thread_id]["status"] = {"type": "active"}
        self.turn_pages[thread_id] = [{**result["turn"], "status": "inProgress"}]
        return result

    async def steer_turn(self, thread_id, turn_id, text=None, **params):
        self.steered.append((thread_id, turn_id, text, params))
        if self.fail_steer is not None:
            raise self.fail_steer
        return {"turnId": turn_id}


@asynccontextmanager
async def bridge(tmp_path, client):
    settings = Settings.from_env(
        {
            "IMZEN_CWD": str(tmp_path),
            "IMZEN_APP_SERVER_URL": "ws://127.0.0.1:4500",
            "IMZEN_GATEWAY_STATE_FILE": str(tmp_path / "gateway.sqlite3"),
            "IMZEN_APP_SERVER_SHARED_FILESYSTEM_ROOT": str(tmp_path),
            "IMZEN_PERMISSION_MODE": "approval-required",
        }
    )
    channel = FakeChannelAdapter("test")
    gateway, state = create_gateway(settings, client=client, channels=[channel])
    await gateway.start()
    try:
        yield channel
    finally:
        await gateway.stop()
        await state.close()


@pytest.mark.asyncio
async def test_composition_steers_correlated_turn_and_preserves_original_reply(tmp_path):
    client = ActiveServer()
    async with bridge(tmp_path, client) as channel:
        await channel.emit_message(inbound("first", "start"))
        await channel.emit_message(inbound("second", "continue"))
        assert len(client.started_turns) == 1
        assert client.steered == [("thread-1", "turn-1", "continue", {})]
        assert client.started_threads[0]["approval_policy"] == "on-request"
        await client.emit_agent_message("thread-1", "turn-1", "same-turn-answer")
        async with asyncio.timeout(2):
            while "same-turn-answer" not in sent_texts(channel):  # noqa: ASYNC110
                await asyncio.sleep(0.01)
        reply = next(item for item in channel.sent if item.content[0].text == "same-turn-answer")
        assert reply.reply_to == "first"
        client.threads["thread-1"]["status"] = {"type": "idle"}
        client.turn_pages["thread-1"][0]["status"] = "completed"
        await channel.emit_message(inbound("third", "new turn"))
        assert len(client.started_turns) == 2
        assert len(client.steered) == 1


@pytest.mark.asyncio
async def test_steered_image_carries_verified_bytes_from_explicit_root(tmp_path):
    image = tmp_path / "image.png"
    image.write_bytes(b"synthetic image")
    client = ActiveServer()
    client.connection_epoch = 17
    async with bridge(tmp_path, client) as channel:
        await channel.emit_message(inbound("first", "start"))
        await channel.emit_message(
            inbound(
                "image",
                content=(
                    AttachmentContent(
                        attachment_id="image",
                        media_type="image/png",
                        source=LocalPath(str(image)),
                        size_bytes=image.stat().st_size,
                    ),
                ),
            )
        )
    assert len(client.started_turns) == 1
    assert client.steered == [
        (
            "thread-1",
            "turn-1",
            None,
            {
                "input_items": [
                    {"type": "image", "url": "data:image/png;base64,c3ludGhldGljIGltYWdl"}
                ],
            },
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "message"),
    [
        (ApplicationInputRejected("turn_ended"), "turn has ended"),
        (RuntimeError("connection lost"), "outcome is unknown"),
    ],
)
async def test_steer_failure_never_falls_back_or_replays_after_restart(tmp_path, error, message):
    client = ActiveServer()
    failed = inbound("second", "continue once")
    async with bridge(tmp_path, client) as channel:
        await channel.emit_message(inbound("first", "start"))
        client.fail_steer = error
        await channel.emit_message(failed)
        await channel.emit_message(failed)
        assert sum(message in text for text in sent_texts(channel)) == 1
    assert len(client.started_turns) == 1
    assert len(client.steered) == 1
    restarted = ActiveServer()
    async with bridge(tmp_path, restarted) as channel:
        await channel.emit_message(failed)
    assert not restarted.started_threads
    assert not restarted.started_turns
    assert not restarted.steered


@pytest.mark.asyncio
async def test_external_turn_without_im_reply_correlation_is_not_dispatched(tmp_path):
    client = ActiveServer()
    await client.start_thread(cwd=str(tmp_path))
    await client.start_turn("thread-1", "external origin")
    async with bridge(tmp_path, client) as channel:
        await channel.emit_message(inbound("pick", "/pick thread-1"))
        await channel.emit_message(inbound("second", "must reject"))
        assert any("could not process" in text for text in sent_texts(channel))
    assert len(client.started_turns) == 1
    assert client.steered == []


@pytest.mark.asyncio
async def test_sdk_explicit_steering_opt_out_remains_start_only(tmp_path: Path):
    client = ActiveServer()
    await client.start_thread(cwd=str(tmp_path))
    await client.start_turn("thread-1", "first")
    application = ZenApplicationAdapter(
        application_instance_id="zen-main",
        workspace_id="imzen-workspace",
        client=client,
        cwd=str(tmp_path),
        steer_active_turn=False,
    )
    await application.send_input(
        ThreadRef(ProjectRef("zen-main", "imzen-workspace"), "thread-1"),
        AgentInput(client_message_id="next", content=(TextContent("start-only policy"),)),
    )
    assert len(client.started_turns) == 2
    assert not client.steered
