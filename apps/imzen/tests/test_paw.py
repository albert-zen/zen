from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from imagent.interaction.media import AttachmentContent, LocalPath
from imagent.testing import FakeChannelAdapter
from test_gateway import FakeAppServer, inbound, sent_texts

from imzen.config import Settings
from imzen.main import create_gateway
from imzen.paw import PawController, PawState


class FakeRooms:
    def __init__(self):
        self.rooms = [
            {"id": "room-1", "name": "PAW One", "threadId": "thread-1"},
            {"id": "room-2", "name": "PAW Two", "threadId": "thread-2"},
        ]
        self.messages = {room["id"]: [] for room in self.rooms}
        self.posts = []
        self.fail_post = None
        self.before_read = None

    async def request(self, operation, params):
        if operation == "list":
            return {"rooms": list(self.rooms)}
        if operation == "read":
            if self.before_read:
                await self.before_read(params)
            room = next(room for room in self.rooms if room["id"] == params["roomId"])
            return {
                "room": {**room, "operationEpoch": "11111111-1111-4111-8111-111111111111"},
                "messages": list(self.messages[room["id"]]),
            }
        self.posts.append(params)
        if self.fail_post:
            raise self.fail_post
        return {"messageId": "human-post", "threadId": "thread-1"}

    def append(self, room_id, message_id, kind, text):
        self.messages[room_id].append(
            {
                "id": message_id,
                "roomId": room_id,
                "kind": kind,
                "author": "PAW" if kind == "agent" else "Me",
                "text": text,
                "createdAt": 1000,
                "originThreadId": "private-working-thread" if kind == "agent" else None,
                "originTurnId": None,
            }
        )


def compose(root, rooms, channel_id="test"):
    client = FakeAppServer()
    channel = FakeChannelAdapter(channel_id)
    room_state = PawState(root / "paw.sqlite3")
    paw = PawController(rooms, room_state, channel_instance_ids=frozenset({channel_id}))
    gateway, gateway_state = create_gateway(
        Settings(
            app_server_url="ws://127.0.0.1:4500",
            cwd=root,
            gateway_state_file=root / "gateway.sqlite3",
        ),
        client=client,
        channels=[channel],
        persistent_subscriptions=True,
        controller_factory=paw.wrap,
        delivery_authorizer=paw,
        outbound_presentation=paw,
        startup_preparations=paw.startup_preparations(),
    )
    paw.attach(gateway)
    return gateway, gateway_state, room_state, paw, channel, client


@pytest.mark.asyncio
async def test_paw_selection_posts_formal_room_and_never_starts_thread(tmp_path: Path):
    rooms = FakeRooms()
    gateway, sdk_state, state, paw, channel, client = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("list", "/paws"))
        await channel.emit_message(inbound("select", "/paw 1"))
        await channel.emit_message(inbound("question", "Hello PAW"))
        await channel.emit_message(inbound("question", "Hello PAW"))
        assert len(rooms.posts) == 1
        assert rooms.posts[0]["roomId"] == "room-1"
        assert rooms.posts[0]["text"] == "Hello PAW"
        assert rooms.posts[0]["clientId"].startswith("11111111-1111-4111-8111-111111111111:")
        assert client.started_threads == []
        assert client.started_turns == []
        rooms.append("room-1", "human", "human", "Don't echo me")
        rooms.append("room-1", "system", "system", "Don't echo system")
        rooms.append("room-1", "formal", "agent", "Formal PAW reply")
        await paw.poll_once()
        assert sum("Formal PAW reply" in text for text in sent_texts(channel)) == 1
        assert not any("Don't echo" in text for text in sent_texts(channel))
        await paw.poll_once()
        assert sum("Formal PAW reply" in text for text in sent_texts(channel)) == 1
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()


@pytest.mark.asyncio
async def test_switch_from_thread_blocks_private_projections_and_new_restores_legacy(tmp_path):
    rooms = FakeRooms()
    gateway, sdk_state, state, paw, channel, client = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("legacy-start", "Legacy input"))
        await channel.emit_message(inbound("select", "/paw room-1"))
        await client.emit_agent_message("thread-1", "private", "PRIVATE working trace")
        await asyncio.sleep(0.03)
        assert not any("PRIVATE" in text for text in sent_texts(channel))
        assert (
            await gateway.actions(
                inbound("unused", "").conversation_ref, actor="owner"
            ).get_binding()
        ).thread_ref is None
        await channel.emit_message(
            inbound(
                "attachment",
                content=(
                    AttachmentContent(
                        attachment_id="image",
                        media_type="image/png",
                        source=LocalPath("/tmp/image.png"),
                    ),
                ),
            )
        )
        assert "attachment was not sent" in sent_texts(channel)[-1]
        assert rooms.posts == []
        await channel.emit_message(inbound("new", "/new"))
        await channel.emit_message(inbound("legacy-again", "New legacy input"))
        assert client.started_turns[-1][:2] == ("thread-2", "New legacy input")
        assert state.bindings() == ()
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()


@pytest.mark.asyncio
async def test_restart_restores_room_and_outbound_checkpoint_without_echo(tmp_path):
    rooms = FakeRooms()
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("select", "/paw room-1"))
        await channel.emit_message(inbound("input", "Durable input"))
        rooms.append("room-1", "old", "agent", "Already delivered")
        await paw.poll_once()
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()
    rooms.append("room-1", "new", "agent", "After restart")
    gateway, sdk_state, state, paw, channel, client = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await paw.poll_once()
        await channel.emit_message(inbound("input", "Durable input"))
        await channel.emit_message(inbound("next", "Same PAW"))
        assert not any("Already delivered" in text for text in sent_texts(channel))
        assert sum("After restart" in text for text in sent_texts(channel)) == 1
        assert [post["text"] for post in rooms.posts] == ["Durable input", "Same PAW"]
        assert client.started_turns == []
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()


@pytest.mark.asyncio
async def test_sdk_accepted_delivery_survives_crash_before_adapter_checkpoint(tmp_path):
    rooms = FakeRooms()
    rooms.append("room-1", "baseline", "human", "Existing message")
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("select", "/paw room-1"))
        rooms.append("room-1", "formal", "agent", "Exactly once")
        original = state.checkpoint

        def interrupted(*args):
            raise RuntimeError("simulated exit after platform acceptance")

        state.checkpoint = interrupted
        with pytest.raises(RuntimeError, match="simulated exit"):
            await paw.poll_once()
        assert sum("Exactly once" in text for text in sent_texts(channel)) == 1
        state.checkpoint = original
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await paw.poll_once()
        assert not any("Exactly once" in text for text in sent_texts(channel))
        assert state.bindings()[0].checkpoint == "formal"
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()


@pytest.mark.asyncio
async def test_unknown_admission_is_visible_and_never_automatically_reposted(tmp_path):
    rooms = FakeRooms()
    rooms.fail_post = ConnectionError("response lost")
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("select", "/paw room-1"))
        await channel.emit_message(inbound("input", "May already be posted"))
        assert "unknown" in sent_texts(channel)[-1]
        assert "not be retried automatically" in sent_texts(channel)[-1]
        await channel.emit_message(inbound("input", "May already be posted"))
        assert len(rooms.posts) == 1
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("input", "May already be posted"))
        assert len(rooms.posts) == 1
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()


@pytest.mark.asyncio
async def test_unknown_outbound_is_durable_and_not_retried_after_restart(tmp_path):
    from imagent.interaction.channels import DeliveryReceipt, DeliveryReceiptStatus

    rooms = FakeRooms()
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("select", "/paw room-1"))
        rooms.append("room-1", "formal", "agent", "Unknown outcome")

        async def uncertain_send(message):
            channel.sent.append(message)
            return DeliveryReceipt(status=DeliveryReceiptStatus.UNKNOWN)

        channel.send = uncertain_send
        await paw.poll_once()
        assert "unknown" in paw.route_error(inbound("unused", "").conversation_ref)
        assert sum("Unknown outcome" in text for text in sent_texts(channel)) == 1
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await paw.poll_once()
        assert "unknown" in paw.route_error(inbound("unused", "").conversation_ref)
        assert channel.sent == []
        assert state.bindings()[0].checkpoint is None
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()


@pytest.mark.asyncio
async def test_route_change_discards_read_that_started_on_previous_room(tmp_path):
    rooms = FakeRooms()
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    await gateway.start()
    task = None
    started = asyncio.Event()
    release = asyncio.Event()
    try:
        await channel.emit_message(inbound("select", "/paw room-1"))
        rooms.append("room-1", "old", "agent", "Stale reply")

        async def paused_read(params):
            if params["roomId"] == "room-1":
                started.set()
                await release.wait()

        rooms.before_read = paused_read
        task = asyncio.create_task(paw.poll_once())
        await started.wait()
        await channel.emit_message(inbound("switch", "/paw room-2"))
        release.set()
        await task
        assert not any("Stale reply" in text for text in sent_texts(channel))
        assert state.bindings()[0].room_id == "room-2"
    finally:
        release.set()
        if task:
            await task
        await gateway.stop()
        await sdk_state.close()
        state.close()


@pytest.mark.asyncio
async def test_missing_history_checkpoint_fails_explicitly_without_skipping(tmp_path):
    rooms = FakeRooms()
    rooms.append("room-1", "baseline", "human", "Baseline")
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("select", "/paw room-1"))
        rooms.messages["room-1"].clear()
        rooms.append("room-1", "later", "agent", "Truncated history")
        await paw.poll_once()
        assert "checkpoint" in paw.route_error(inbound("unused", "").conversation_ref)
        assert not any("Truncated history" in text for text in sent_texts(channel))
        assert state.bindings()[0].checkpoint == "baseline"
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()


@pytest.mark.asyncio
async def test_pick_switches_back_but_failed_pick_preserves_paw(tmp_path):
    rooms = FakeRooms()
    gateway, sdk_state, state, paw, channel, client = compose(tmp_path, rooms)
    await client.start_thread(cwd=str(tmp_path))
    await gateway.start()
    try:
        await channel.emit_message(inbound("select", "/paw room-1"))
        await channel.emit_message(inbound("missing", "/pick missing"))
        assert len(state.bindings()) == 1
        await channel.emit_message(inbound("threads", "/threads"))
        await channel.emit_message(inbound("pick", "/pick 1"))
        await channel.emit_message(inbound("plain", "Legacy selected"))
        assert state.bindings() == ()
        assert client.started_turns[-1][:2] == ("thread-1", "Legacy selected")
        assert not rooms.posts
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()


@pytest.mark.asyncio
async def test_bad_room_pauses_only_its_route_and_reselection_recovers(tmp_path):
    rooms = FakeRooms()
    rooms.append("room-1", "baseline", "human", "Baseline")
    gateway, sdk_state, state, paw, channel, client = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("select-a", "/paw room-1", conversation_id="a"))
        await channel.emit_message(inbound("select-b", "/paw room-2", conversation_id="b"))
        rooms.messages["room-1"].clear()
        rooms.append("room-2", "healthy", "agent", "Healthy reply")
        await paw.poll_once()
        assert any("Healthy reply" in text for text in sent_texts(channel))
        await channel.emit_message(inbound("status", "/paw", conversation_id="a"))
        assert "paused" in sent_texts(channel)[-1].lower()
        assert "checkpoint" in sent_texts(channel)[-1]
        await channel.emit_message(inbound("legacy", "Still responsive", conversation_id="c"))
        assert client.started_turns[-1][1] == "Still responsive"
        await channel.emit_message(inbound("reselect", "/paw room-1", conversation_id="a"))
        rooms.append("room-1", "recovered", "agent", "Recovered reply")
        await paw.poll_once()
        assert any("Recovered reply" in text for text in sent_texts(channel))
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()


@pytest.mark.asyncio
async def test_stale_thread_binding_is_suppressed_then_cleared_before_restart(tmp_path):
    from imagent import Succeeded
    from imagent.applications import ProjectRef, ThreadRef

    rooms = FakeRooms()
    gateway, sdk_state, state, paw, channel, client = compose(tmp_path, rooms)
    await client.start_thread(cwd=str(tmp_path))
    await gateway.start()
    conversation = inbound("unused", "").conversation_ref
    try:
        await channel.emit_message(inbound("thread", "/pick thread-1"))
        await channel.emit_message(inbound("room", "/paw room-1"))
        actions = gateway.actions(conversation, actor="test")
        binding = await actions.get_binding()
        # Simulate an obsolete persisted legacy route alongside a Room address.
        restored = await actions.bind_thread(
            ThreadRef(ProjectRef("zen-main", "imzen-workspace"), "thread-1"),
            action_id="stale-thread-route",
            expected_generation=binding.generation,
        )
        assert isinstance(restored, Succeeded)
        await client.emit_agent_message("thread-1", "private", "PRIVATE stale Thread trace")
        await asyncio.sleep(0.03)
        assert not any("PRIVATE" in text for text in sent_texts(channel))
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()
    for restart in range(2):
        gateway, sdk_state, state, paw, channel, client = compose(tmp_path, rooms)
        try:
            await gateway.start()
            actions = gateway.actions(conversation, actor="test")
            binding = await actions.get_binding()
            assert binding.thread_ref is None
            if restart == 0:
                # A later interrupted /pick can leave a new SDK generation next
                # to the same durable Room generation. Preparation must fence
                # this distinct route, not replay a previous clear receipt.
                await client.start_thread(cwd=str(tmp_path))
                result = await actions.bind_thread(
                    ThreadRef(ProjectRef("zen-main", "imzen-workspace"), "thread-1"),
                    action_id="second-stale-route",
                    expected_generation=binding.generation,
                )
                assert isinstance(result, Succeeded)
        finally:
            await gateway.stop()
            await sdk_state.close()
            state.close()


@pytest.mark.asyncio
async def test_paw_prefix_ambiguity_uses_one_product_command_namespace(tmp_path):
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, FakeRooms())
    await gateway.start()
    try:
        await channel.emit_message(inbound("ambiguous", "/pa"))
        response = sent_texts(channel)[-1]
        assert "Ambiguous command" in response
        assert "/paw" in response and "/paws" in response
        assert state.bindings() == ()
    finally:
        await gateway.stop()
        state.close()


async def test_disabled_channel_keeps_paw_history_without_blocking_other_channels(tmp_path):
    rooms = FakeRooms()
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    await gateway.start()
    try:
        await channel.emit_message(inbound("select-before-disable", "/paw room-1"))
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()
    rooms.append("room-1", "offline-formal", "agent", "Waiting for re-enable")
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms, channel_id="other")
    try:
        await gateway.start()
        await paw.poll_once()
        assert state.bindings()[0].conversation.channel_instance_id == "test"
        assert state.bindings()[0].checkpoint is None
        assert not channel.sent
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()
    gateway, sdk_state, state, paw, channel, _ = compose(tmp_path, rooms)
    try:
        await gateway.start()
        await paw.poll_once()
        assert sum("Waiting for re-enable" in text for text in sent_texts(channel)) == 1
    finally:
        await gateway.stop()
        await sdk_state.close()
        state.close()
