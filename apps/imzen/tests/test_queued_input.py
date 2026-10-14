from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from imagent import ConversationActions, Failed, OutcomeUnknown, Succeeded
from imagent.gateway import QueuedInputNoticeReason, QueuedInputStatus, QueuedInputStatusKind
from imagent.gateway.persistence.effects import ActionError, ActionErrorCode
from imagent.interaction.messages import TextFormat
from test_gateway import compose, inbound, sent_texts

from imzen.config import Settings
from imzen.main import create_gateway
from imzen.queued_input import ImZenQueuedInputPresenter


class ScopedActions:
    def __init__(self, result):
        self.result = result
        self.reads = []
        self.cancels = []

    async def read_queued_input(self, message_id):
        self.reads.append(message_id)
        return self.result

    async def cancel_queued_input(self, message_id, *, action_id):
        self.cancels.append((message_id, action_id))
        return self.result


@asynccontextmanager
async def controls(root, monkeypatch, result):
    recorder = ScopedActions(result)

    async def read(_actions, message_id):
        return await recorder.read_queued_input(message_id)

    async def cancel(_actions, message_id, *, action_id):
        return await recorder.cancel_queued_input(message_id, action_id=action_id)

    # Exercise the real Gateway/registry/action-command lifecycle; only the
    # public remote-control outcomes are scripted for these presentation tests.
    monkeypatch.setattr(ConversationActions, "read_queued_input", read)
    monkeypatch.setattr(ConversationActions, "cancel_queued_input", cancel)
    gateway, channel, client = compose(root, allow_unique_prefix=True)
    await gateway.start()
    try:
        yield channel, recorder
        message = inbound("probe")
        assert (
            await gateway.actions(message.conversation_ref, actor=message.sender).get_binding()
            is None
        )
        assert client.started_threads == client.started_turns == []
    finally:
        await gateway.stop()


@pytest.mark.parametrize("command", ["queued", "unqueue"])
async def test_queue_control_uses_original_scoped_id_without_selecting_thread(
    tmp_path, monkeypatch, command
):
    result = Succeeded(QueuedInputStatus("original id", QueuedInputStatusKind.CANCELLED))
    async with controls(tmp_path, monkeypatch, result) as (channel, actions):
        await channel.emit_message(inbound("control-1", f'/{command} "original id"'))
        assert "cancelled" in sent_texts(channel)[-1].lower()
        if command == "queued":
            assert actions.reads == ["original id"]
            assert actions.cancels == []
        else:
            assert actions.cancels == [("original id", "imzen:operation:control-1:queued.cancel")]
            assert actions.reads == []


@pytest.mark.parametrize("command", ["queued", "unqueue"])
@pytest.mark.parametrize("arguments", ["", "first second"])
async def test_queue_control_requires_one_original_message_id(
    tmp_path, monkeypatch, command, arguments
):
    async with controls(tmp_path, monkeypatch, None) as (channel, actions):
        await channel.emit_message(inbound("control-2", f"/{command} {arguments}"))
        assert f"Use /{command} <original IM message ID>" in sent_texts(channel)[-1]
        assert actions.reads == actions.cancels == []


@pytest.mark.parametrize(
    ("outcome", "expected"),
    [
        (Failed(ActionError(ActionErrorCode.QUEUE_ALREADY_ADMITTED)), "already started"),
        (OutcomeUnknown(ActionError(ActionErrorCode.NATIVE_OUTCOME_UNKNOWN)), "unknown"),
        (Failed(ActionError(ActionErrorCode.NATIVE_OUTCOME_UNKNOWN)), "unknown"),
    ],
)
async def test_unqueue_never_claims_cancellation_for_admitted_or_unknown(
    tmp_path, monkeypatch, outcome, expected
):
    async with controls(tmp_path, monkeypatch, outcome) as (channel, _actions):
        await channel.emit_message(inbound("control-3", "/unqueue original"))
        text = sent_texts(channel)[-1].lower()
        assert expected in text
        assert "cancelled" not in text


@pytest.mark.parametrize("state", list(QueuedInputStatusKind))
async def test_queue_notice_preserves_original_reply_and_markdown(state):
    message = inbound("original", "hello")
    result = await ImZenQueuedInputPresenter().present_queued_input(
        QueuedInputStatus(message.message_id, state),
        reason=QueuedInputNoticeReason.ADMISSION,
        conversation_ref=message.conversation_ref,
        delivery_id="notice",
        reply_to_message_id=message.message_id,
    )
    assert result.reply_to == message.message_id
    assert result.delivery_id == "notice"
    assert result.conversation_ref == message.conversation_ref
    assert result.content[0].format is TextFormat.MARKDOWN
    assert "/queued original" in result.content[0].text
    if state is QueuedInputStatusKind.ADMITTED:
        assert "not confirmation of completion" in result.content[0].text


@pytest.mark.parametrize(
    "message_id", ["`[link](https://example.test)`", "line\n@everyone", "a" * 512]
)
async def test_queue_notice_bounds_and_does_not_interpolate_unsafe_identifier(message_id):
    message = inbound(message_id, "hello")
    result = await ImZenQueuedInputPresenter().present_queued_input(
        QueuedInputStatus(message_id, QueuedInputStatusKind.PENDING),
        reason=QueuedInputNoticeReason.ATTEMPT_FAILED,
        conversation_ref=message.conversation_ref,
        delivery_id="notice",
        reply_to_message_id=message_id,
    )
    text = result.content[0].text
    assert len(text) < 1500
    assert "still pending" in text
    assert "Resume" in text
    if "`" in message_id or "\n" in message_id:
        assert message_id not in text
    assert result.reply_to == message_id


async def test_explicit_queue_on_old_native_capability_never_falls_back_to_start(tmp_path):
    from imagent.testing import FakeChannelAdapter
    from test_gateway import FakeAppServer

    client = FakeAppServer()
    channel = FakeChannelAdapter("test")
    gateway, state = create_gateway(
        Settings(
            app_server_url="ws://127.0.0.1:4500",
            cwd=tmp_path,
            gateway_state_file=tmp_path / "gateway.sqlite3",
            input_continuation="queue",
        ),
        client=client,
        channels=[channel],
    )
    await gateway.start()
    try:
        await channel.emit_message(inbound("unsupported", "do not silently start"))
        assert len(client.started_threads) == 1
        assert client.started_turns == []
        assert any("not accepted" in text for text in sent_texts(channel))
    finally:
        await gateway.stop()
        await state.close()


@pytest.mark.parametrize("command", ["queued", "unqueue"])
async def test_paw_allows_original_queue_control_without_changing_room_route(tmp_path, command):
    from test_paw import FakeRooms
    from test_paw import compose as paw_bridge

    rooms = FakeRooms()
    gateway, sdk_state, state, paw, channel, client = paw_bridge(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("select-room", "/paw room-1"))
        before = state.get(inbound("original").conversation_ref)
        actions = gateway.actions(inbound("original").conversation_ref, actor="owner")
        binding = await actions.get_binding()
        await channel.emit_message(inbound("queue-control", f"/{command} original"))
        text = sent_texts(channel)[-1]
        assert "not found" in text.lower()
        assert "PAW Room mode" not in text
        assert state.get(inbound("original").conversation_ref) == before
        assert await actions.get_binding() == binding
        assert rooms.posts == client.started_threads == client.started_turns == []
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()
