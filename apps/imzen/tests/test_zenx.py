from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from imagent.testing import FakeChannelAdapter
from test_gateway import FakeAppServer, inbound, sent_texts

from imzen.config import Settings
from imzen.main import create_gateway


def compose_zenx(root, client):
    channel = FakeChannelAdapter("test")
    gateway, state = create_gateway(
        Settings(
            app_server_url="ws://127.0.0.1:4500",
            cwd=root,
            gateway_state_file=root / "gateway.sqlite3",
        ),
        client=client,
        channels=[channel],
        persistent_subscriptions=True,
    )
    return gateway, state, channel


async def wait_text(channel, text):
    async with asyncio.timeout(2):
        while not any(text in value for value in sent_texts(channel)):  # noqa: ASYNC110 - observe SDK test double delivery
            await asyncio.sleep(0.005)


@pytest.mark.asyncio
async def test_desktop_turn_fans_out_only_to_subscribed_conversations(tmp_path: Path):
    client = FakeAppServer()
    await client.start_thread(cwd=str(tmp_path))
    gateway, state, channel = compose_zenx(tmp_path, client)
    await gateway.start()
    try:
        for chat in ("one", "two"):
            await channel.emit_message(
                inbound(f"sub-{chat}", "/subscribe thread-1", conversation_id=chat)
            )
        await channel.emit_message(inbound("help", "/help", conversation_id="not-subscribed"))
        await client.emit_agent_message(
            "thread-1", "desktop-turn", "Desktop reply", item_id="desktop-item"
        )
        await wait_text(channel, "Desktop reply")
        await asyncio.sleep(0.03)
        recipients = [
            m.conversation_ref.native_conversation_id
            for m in channel.sent
            if any("Desktop reply" in t.text for t in m.content if hasattr(t, "text"))
        ]
        assert sorted(recipients) == ["one", "two"]
        await channel.emit_message(inbound("unsub", "/unsubscribe", conversation_id="one"))
        await client.emit_agent_message(
            "thread-1", "desktop-turn-2", "Next reply", item_id="desktop-item-2"
        )
        await wait_text(channel, "Next reply")
        recipients = [
            m.conversation_ref.native_conversation_id
            for m in channel.sent
            if any("Next reply" in t.text for t in m.content if hasattr(t, "text"))
        ]
        assert recipients == ["two"]
        assert client.started_turns == []
    finally:
        await gateway.stop()
        await state.close()


@pytest.mark.asyncio
async def test_restart_restores_subscription_and_im_input_targets_same_thread(tmp_path: Path):
    client = FakeAppServer()
    await client.start_thread(cwd=str(tmp_path))
    gateway, state, channel = compose_zenx(tmp_path, client)
    await gateway.start()
    await channel.emit_message(inbound("sub", "/subscribe thread-1"))
    await gateway.stop()
    await state.close()
    # Native server survives; the Gateway and its transport are fresh objects.
    fresh = FakeAppServer()
    fresh.threads = client.threads
    gateway, state, channel = compose_zenx(tmp_path, fresh)
    await gateway.start()
    try:
        await fresh.emit_agent_message(
            "thread-1", "desktop-after-restart", "Restored reply", item_id="restored-item"
        )
        await wait_text(channel, "Restored reply")
        msg = inbound("im-input", "From IM")
        await channel.emit_message(msg)
        await channel.emit_message(msg)
        assert fresh.started_threads == []
        assert len(fresh.started_turns) == 1
        assert fresh.started_turns[0][:2] == ("thread-1", "From IM")
    finally:
        await gateway.stop()
        await state.close()


def test_macos_ipv6_host_exclusion_preserves_proxy_routing(monkeypatch):
    import httpx

    from imzen.zenx import normalize_proxy_exclusions

    for key in (
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(
        "imzen.zenx.urllib.request.getproxies",
        lambda: {
            "no": "127.0.0.1,localhost,::1,127.0.0.0/8,::1/128",
            "https": "http://127.0.0.1:7890",
        },
    )
    normalize_proxy_exclusions()
    import os

    assert os.environ["no_proxy"] == "127.0.0.1,localhost,::1,127.0.0.0/8,::1"
    assert os.environ["https_proxy"] == "http://127.0.0.1:7890"
    # The actual pinned HTTPX constructor failed before any QQ request.
    with httpx.Client():
        pass


@pytest.mark.asyncio
async def test_navigation_uses_titles_and_pick_is_the_subscription(tmp_path: Path):
    client = FakeAppServer()
    await client.start_thread(cwd=str(tmp_path))
    client.threads["thread-1"]["name"] = "Desktop work"
    gateway, state, channel = compose_zenx(tmp_path, client)
    await gateway.start()
    try:
        for index, command in enumerate(("/threads", "/pick 1", "/status", "/help")):
            await channel.emit_message(inbound(f"nav-{index}", command))
        rendered = "\n".join(sent_texts(channel))
        assert "Desktop work" in rendered
        assert "thread-1" not in rendered
        assert "/subscribe" not in rendered
        assert "select and receive" in rendered
        await client.emit_agent_message(
            "thread-1", "desktop-picked", "Picked reply", item_id="picked"
        )
        await wait_text(channel, "Picked reply")
        await channel.emit_message(inbound("new", "/new"))
        await client.emit_agent_message(
            "thread-1", "desktop-cleared", "Cleared reply", item_id="cleared"
        )
        await asyncio.sleep(0.03)
        assert not any("Cleared reply" in text for text in sent_texts(channel))
        assert client.started_threads == [{"cwd": str(tmp_path)}]
    finally:
        await gateway.stop()
        await state.close()


@pytest.mark.asyncio
async def test_pick_numbers_follow_each_conversations_last_list(tmp_path: Path):
    client = FakeAppServer()
    for _ in range(2):
        await client.start_thread(cwd=str(tmp_path))
    client.threads["thread-1"]["name"] = "First"
    client.threads["thread-2"]["name"] = "Second"
    client.threads = dict(reversed(list(client.threads.items())))
    gateway, state, channel = compose_zenx(tmp_path, client)
    await gateway.start()
    try:
        await channel.emit_message(inbound("stale", "/pick 1", conversation_id="a"))
        assert any("Use /threads first" in t for t in sent_texts(channel))
        await channel.emit_message(inbound("list-a", "/threads", conversation_id="a"))
        # Change server ordering after A saw its list. A's number must stay stable.
        client.threads = dict(reversed(list(client.threads.items())))
        await channel.emit_message(inbound("list-b", "/threads", conversation_id="b"))
        await channel.emit_message(inbound("pick-a", "/pick 1", conversation_id="a"))
        await channel.emit_message(inbound("pick-b", "/pick 1", conversation_id="b"))
        await channel.emit_message(inbound("input-a", "A input", conversation_id="a"))
        await channel.emit_message(inbound("input-b", "B input", conversation_id="b"))
        assert [(t[0], t[1]) for t in client.started_turns] == [
            ("thread-2", "A input"),
            ("thread-1", "B input"),
        ]
        await channel.emit_message(inbound("refresh-a", "/threads", conversation_id="a"))
        await channel.emit_message(inbound("refresh-pick-a", "/pick 1", conversation_id="a"))
        await channel.emit_message(inbound("bad-pick", "/pick 99", conversation_id="a"))
        assert any("Invalid thread number" in t for t in sent_texts(channel))
        await channel.emit_message(
            inbound("input-refreshed", "Refreshed input", conversation_id="a")
        )
        assert client.started_turns[-1][:2] == ("thread-1", "Refreshed input")
    finally:
        await gateway.stop()
        await state.close()


@pytest.mark.asyncio
async def test_zenx_prefixes_use_product_and_common_namespace(tmp_path: Path):
    client = FakeAppServer()
    await client.start_thread(cwd=str(tmp_path))
    gateway, state, channel = compose_zenx(tmp_path, client)
    await gateway.start()
    try:
        await channel.emit_message(inbound("list", "/threads"))
        await channel.emit_message(inbound("pick", "/sub 1"))
        assert "Selected thread" in sent_texts(channel)[-1]
        await channel.emit_message(inbound("ambiguous", "/s"))
        assert "Ambiguous" in sent_texts(channel)[-1]
        await channel.emit_message(inbound("still-selected", "same thread"))
        assert client.started_turns[-1][0] == "thread-1"
        await channel.emit_message(inbound("clear", "/unsub"))
        await channel.emit_message(inbound("new", "fresh thread"))
        assert client.started_turns[-1][0] == "thread-2"
    finally:
        await gateway.stop()
        await state.close()
