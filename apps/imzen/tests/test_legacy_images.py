"""Old typed image inputs through the real product Gateway and current SDK."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path

import pytest
from imagent.applications import AgentInput, ProjectRef, ThreadRef, ZenApplicationAdapter
from imagent.interaction.media import AttachmentContent, LocalPath
from imagent.testing import FakeChannelAdapter
from test_gateway import FakeAppServer, inbound, sent_texts
from test_steering import ActiveServer

import imzen.controller as controller_module
from imzen.config import Settings
from imzen.controller import ImZenContentTransformer
from imzen.main import create_gateway

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "legacy_image_bb805.json").read_text(encoding="utf-8")
)


def old_image(root: Path, *, with_size: bool = False) -> AttachmentContent:
    payload = base64.b64decode(FIXTURE["png_base64"])
    assert hashlib.sha256(payload).hexdigest() == FIXTURE["png_sha256"]
    root.mkdir(parents=True, exist_ok=True)
    path = root / "synthetic.png"
    path.write_bytes(payload)
    record = dict(FIXTURE["channel_typed" if with_size else "custom_path_only"])
    record["source"] = LocalPath(str(path))
    return AttachmentContent(**record)


def write_sparse(path: Path, size: int) -> None:
    with path.open("wb") as stream:
        stream.truncate(size)


@asynccontextmanager
async def product_bridge(
    tmp_path: Path, *, root: Path | None, active: bool = False, local_host: bool = False
):
    env = {
        "IMZEN_CWD": str(tmp_path),
        "IMZEN_APP_SERVER_URL": "ws://127.0.0.1:4500",
        "IMZEN_GATEWAY_STATE_FILE": str(tmp_path / "synthetic-gateway.sqlite3"),
        "IMZEN_PERMISSION_MODE": "approval-required",
    }
    if root is not None and not local_host:
        env["IMZEN_APP_SERVER_SHARED_FILESYSTEM_ROOT"] = str(root)
    client = ActiveServer() if active else FakeAppServer()
    channel = FakeChannelAdapter("test")
    gateway, state = create_gateway(
        Settings.from_env(env),
        client=client,
        channels=[channel],
        local_app_server=local_host,
        channel_config=({"qq": {"enabled": True, "media_dir": str(root)}} if local_host else None),
    )
    await gateway.start()
    try:
        if active:
            await channel.emit_message(inbound("start", "Synthetic first turn"))
        yield channel, client
    finally:
        await gateway.stop()
        await state.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("active", [False, True], ids=["start", "steer"])
@pytest.mark.parametrize("with_size", [False, True], ids=["old-path-only", "old-channel"])
@pytest.mark.parametrize("local_host", [False, True], ids=["explicit-root", "local-host-root"])
async def test_actual_old_image_shapes_deliver_the_same_bytes(
    tmp_path, active, with_size, local_host
):
    root = tmp_path / "trusted-media"
    attachment = old_image(root, with_size=with_size)
    async with product_bridge(tmp_path, root=root, active=active, local_host=local_host) as (
        channel,
        client,
    ):
        await channel.emit_message(inbound("image", content=(attachment,)))
    calls = client.steered if active else client.started_turns
    assert len(calls) == 1, sent_texts(channel)
    assert calls[0][-1]["input_items"] == [
        {"type": "image", "url": "data:image/png;base64," + FIXTURE["png_base64"]}
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "no-root",
        "outside",
        "relative",
        "leaf-symlink",
        "empty",
        "oversize",
        "declared-wrong",
        "declared-bool",
        "declared-zero",
        "count",
        "aggregate",
        "fifo",
    ],
)
async def test_legacy_size_bridge_keeps_sdk_rejection_boundaries(tmp_path, case):
    root = tmp_path / "trusted-media"
    attachment = old_image(root)
    configured_root = root
    attachments = (attachment,)
    if case == "no-root":
        configured_root = None
    elif case == "outside":
        attachments = (old_image(tmp_path / "outside"),)
    elif case == "relative":
        attachments = (replace(attachment, source=LocalPath("synthetic.png")),)
    elif case == "leaf-symlink":
        link = root / "link.png"
        link.symlink_to(Path(attachment.source.path))
        attachments = (replace(attachment, source=LocalPath(str(link))),)
    elif case in {"empty", "oversize", "aggregate"}:
        size = {"empty": 0, "oversize": 20 * 1024 * 1024 + 1, "aggregate": 17 * 1024 * 1024}[case]
        await asyncio.to_thread(write_sparse, Path(attachment.source.path), size)
        if case == "aggregate":
            attachments = tuple(replace(attachment, attachment_id=f"large-{i}") for i in range(2))
    elif case.startswith("declared-"):
        size = {
            "declared-wrong": FIXTURE["png_size"] + 1,
            "declared-bool": True,
            "declared-zero": 0,
        }[case]
        attachments = (replace(attachment, size_bytes=size),)
    elif case == "count":
        attachments = tuple(replace(attachment, attachment_id=f"image-{i}") for i in range(17))
    elif case == "fifo":
        if not hasattr(os, "mkfifo"):
            pytest.skip("FIFO is unavailable on this platform")
        fifo = root / "fifo.png"
        os.mkfifo(fifo)
        attachments = (replace(attachment, source=LocalPath(str(fifo))),)
    async with product_bridge(tmp_path, root=configured_root) as (channel, client):
        await asyncio.wait_for(
            channel.emit_message(inbound("rejected-image", content=attachments)), timeout=2
        )
    assert client.started_turns == []
    assert any("could not process" in text for text in sent_texts(channel))


@pytest.mark.asyncio
async def test_metadata_lookup_preserves_original_source_for_sdk_nofollow(tmp_path):
    root = tmp_path / "trusted-media"
    attachment = old_image(root)
    transformer = ImZenContentTransformer(root)
    transformed = await transformer.transform_content(inbound("image", content=(attachment,)))
    normalized = transformed[0]
    assert normalized.source is attachment.source
    assert normalized.size_bytes == FIXTURE["png_size"]
    outside = tmp_path / "outside.png"
    outside.write_bytes(base64.b64decode(FIXTURE["png_base64"]))
    original = Path(attachment.source.path)
    await asyncio.to_thread(original.unlink)
    await asyncio.to_thread(original.symlink_to, outside)
    client = FakeAppServer()
    application = ZenApplicationAdapter(
        application_instance_id="zen-main",
        workspace_id="image-test",
        client=client,
        cwd=str(tmp_path),
        shared_filesystem_root=root,
    )
    with pytest.raises(ValueError, match="trusted shared_filesystem_root"):
        await application.send_input(
            ThreadRef(ProjectRef("zen-main", "image-test"), "synthetic-thread"),
            AgentInput(client_message_id="race", content=transformed),
        )
    assert client.started_turns == []


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [17, 30_000])
async def test_excess_legacy_images_reject_before_any_metadata_lookup(tmp_path, monkeypatch, count):
    root = tmp_path / "trusted-media"
    attachment = old_image(root)
    lookups = 0
    original = controller_module.resolve_local_attachment

    def observed(*args, **kwargs):
        nonlocal lookups
        lookups += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(controller_module, "resolve_local_attachment", observed)
    async with product_bridge(tmp_path, root=root) as (channel, client):
        await channel.emit_message(
            inbound(
                "too-many-images",
                content=tuple(
                    replace(attachment, attachment_id=f"legacy-{i}") for i in range(count)
                ),
            )
        )
    assert lookups == 0
    assert client.started_turns == []
    assert any("could not process" in text for text in sent_texts(channel))


@pytest.mark.asyncio
@pytest.mark.parametrize("active", [False, True], ids=["start", "steer"])
async def test_sixteen_legacy_images_keep_the_public_sdk_boundary(tmp_path, monkeypatch, active):
    root = tmp_path / "trusted-media"
    attachment = old_image(root)
    lookups = 0
    original = controller_module.resolve_local_attachment

    def observed(*args, **kwargs):
        nonlocal lookups
        lookups += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(controller_module, "resolve_local_attachment", observed)
    async with product_bridge(tmp_path, root=root, active=active) as (channel, client):
        await channel.emit_message(inbound("maximum-images", content=(attachment,) * 16))
    calls = client.steered if active else client.started_turns
    assert lookups == 16
    assert len(calls) == 1, sent_texts(channel)
    assert (
        calls[0][-1]["input_items"]
        == [{"type": "image", "url": "data:image/png;base64," + FIXTURE["png_base64"]}] * 16
    )


@pytest.mark.asyncio
async def test_pinned_public_sdk_rejects_seventeenth_image_without_consumer_preflight(tmp_path):
    attachment = old_image(tmp_path / "trusted-media", with_size=True)
    client = FakeAppServer()
    application = ZenApplicationAdapter(
        application_instance_id="zen-main",
        workspace_id="image-test",
        client=client,
        cwd=str(tmp_path),
        shared_filesystem_root=tmp_path / "trusted-media",
    )
    with pytest.raises(ValueError, match="image"):
        await application.send_input(
            ThreadRef(ProjectRef("zen-main", "image-test"), "synthetic-thread"),
            AgentInput(client_message_id="too-many-images", content=(attachment,) * 17),
        )
    assert client.started_turns == []
