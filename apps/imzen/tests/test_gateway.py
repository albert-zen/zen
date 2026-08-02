from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from imagent.applications import ZenApplicationAdapter
from imagent.applications.appserver_client import AppServerError
from imagent.bindings import InMemoryBindingRepository
from imagent.contracts import (
    AttachmentContent,
    ConversationRef,
    InboundMessage,
    LocalPath,
    ProjectionPolicy,
    TextContent,
)
from imagent.gateway import ImAgentGateway
from imagent.testing import FakeChannelAdapter

from imzen.controller import (
    ImZenController,
    ImZenFailurePresenter,
    ImZenRequestPresenter,
    adapt_inbound_content,
    thread_start_options,
)


class FakeAppServer:
    def __init__(self) -> None:
        self.connection_epoch = 1
        self.notification_handlers = []
        self.server_request_handlers = []
        self.connection_reset_handlers = []
        self.started_threads: list[dict[str, object]] = []
        self.started_turns: list[tuple[str, str | None, dict[str, object]]] = []
        self.resumed_threads: list[str] = []
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.replies: list[tuple[str | int, dict[str, object], int | None]] = []
        self.error_replies: list[tuple[str | int, int, str]] = []
        self.models: list[dict[str, object]] = [
            {"id": "model-one", "displayName": "Model One", "isDefault": True},
            {"id": "model-two", "displayName": "Model Two"},
        ]
        self.threads: dict[str, dict[str, object]] = {}
        self.turn_pages: dict[str, list[dict[str, object]]] = {}
        self.connected = False
        self.closed = False
        self.fail_turn: Exception | None = None

    def add_notification_handler(self, handler) -> None:
        self.notification_handlers.append(handler)

    def add_server_request_handler(self, handler) -> None:
        self.server_request_handlers.append(handler)

    def add_connection_reset_handler(self, handler) -> None:
        self.connection_reset_handlers.append(handler)

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.closed = True

    def local_image_paths_epoch(self) -> int:
        return self.connection_epoch

    async def start_thread(self, **params: object) -> dict[str, object]:
        self.started_threads.append(dict(params))
        thread_id = f"thread-{len(self.started_threads)}"
        thread = {
            "id": thread_id,
            "cwd": str(params["cwd"]),
            "preview": "",
            "updatedAt": len(self.started_threads),
            "status": {"type": "idle"},
        }
        self.threads[thread_id] = thread
        return {"thread": thread}

    async def list_threads(self, **_params: object) -> dict[str, object]:
        return {"data": list(self.threads.values()), "nextCursor": None}

    async def read_thread(
        self,
        thread_id: str,
        *,
        include_turns: bool = False,
    ) -> dict[str, object]:
        thread = dict(self.threads[thread_id])
        if include_turns:
            thread["turns"] = self.turn_pages.get(thread_id, [])
        return {"thread": thread}

    async def resume_thread(self, **params: object) -> dict[str, object]:
        thread_id = str(params["threadId"])
        self.resumed_threads.append(thread_id)
        return await self.read_thread(thread_id)

    async def list_thread_turns(
        self,
        thread_id: str,
        **_params: object,
    ) -> dict[str, object]:
        return {"data": self.turn_pages.get(thread_id, []), "nextCursor": None}

    async def start_turn(
        self,
        thread_id: str,
        text: str | None = None,
        **params: object,
    ) -> dict[str, object]:
        self.started_turns.append((thread_id, text, dict(params)))
        if self.fail_turn is not None:
            raise self.fail_turn
        turn_id = f"turn-{len(self.started_turns)}"
        return {"turn": {"id": turn_id}}

    async def interrupt_turn(self, thread_id: str, turn_id: str) -> dict[str, object]:
        return {"threadId": thread_id, "turnId": turn_id}

    async def list_models(self, **_params: object) -> dict[str, object]:
        return {"data": self.models}

    async def call(
        self,
        method: str,
        params: dict[str, object] | None = None,
    ) -> dict[str, object]:
        payload = dict(params or {})
        self.calls.append((method, payload))
        if method == "thread/settings/update" and payload.get("model") == "missing":
            raise AppServerError(
                "Model is not available from this Zen host: missing",
                code=-32000,
                data={"zenCode": "model_unavailable"},
            )
        return {}

    async def reply_to_transport_request(
        self,
        request_id: str | int,
        result: dict[str, object],
        *,
        expected_connection_epoch: int | None = None,
    ) -> None:
        self.replies.append((request_id, result, expected_connection_epoch))

    async def reply_error_to_transport_request(
        self,
        request_id: str | int,
        *,
        code: int,
        message: str,
    ) -> None:
        self.error_replies.append((request_id, code, message))

    async def emit_agent_message(
        self,
        thread_id: str,
        turn_id: str,
        text: str,
        *,
        item_id: str = "agent-1",
    ) -> None:
        await self._notify(
            {
                "method": "item/completed",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {
                        "id": item_id,
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": text,
                    },
                },
            }
        )
        await self._notify(
            {
                "method": "turn/completed",
                "params": {
                    "threadId": thread_id,
                    "turn": {"id": turn_id, "status": "completed"},
                },
            }
        )

    async def emit_approval(self, thread_id: str, turn_id: str, request_id: int) -> None:
        message = {
            "id": request_id,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "_transport_request_id": request_id,
                "_connection_epoch": self.connection_epoch,
                "threadId": thread_id,
                "turnId": turn_id,
                "command": "echo hello",
                "cwd": "/repo",
                "availableDecisions": ["accept", "decline", "cancel"],
            },
        }
        for handler in tuple(self.server_request_handlers):
            await handler(message)

    async def _notify(self, message: dict[str, object]) -> None:
        for handler in tuple(self.notification_handlers):
            result = handler(message)
            if asyncio.iscoroutine(result):
                await result


def inbound(
    message_id: str,
    text: str = "",
    *,
    conversation_id: str = "chat-1",
    content: tuple[Any, ...] | None = None,
) -> InboundMessage:
    return InboundMessage(
        message_id=message_id,
        conversation_ref=ConversationRef("test", conversation_id),
        sender="owner",
        content=content if content is not None else (TextContent(text),),
        created_at=datetime.now(UTC),
    )


def compose(tmp_path: Path, client: FakeAppServer | None = None):
    resolved_client = client or FakeAppServer()
    channel = FakeChannelAdapter("test")
    application = ZenApplicationAdapter(
        application_instance_id="zen-main",
        client=resolved_client,
        cwd=str(tmp_path),
        shared_filesystem_root=tmp_path,
        thread_start_options=thread_start_options("full-access"),
    )
    controller = ImZenController(application=application, client=resolved_client)
    gateway = ImAgentGateway(
        channels=[channel],
        applications=[application],
        bindings=InMemoryBindingRepository(),
        projection_policy=ProjectionPolicy.FOREGROUND_ONLY,
        controller=controller,
        content_adapter=adapt_inbound_content,
        inbound_failure_presenter=ImZenFailurePresenter(),
        request_presenter=ImZenRequestPresenter(),
    )
    return gateway, channel, resolved_client


def sent_texts(channel: FakeChannelAdapter) -> list[str]:
    return [
        "\n".join(part.text for part in message.content if isinstance(part, TextContent))
        for message in channel.sent
    ]


@pytest.mark.asyncio
async def test_duplicate_input_reuses_thread_and_projects_markdown(tmp_path: Path) -> None:
    gateway, channel, client = compose(tmp_path)
    await gateway.start()
    try:
        message = inbound("m1", "Build it")
        await channel.emit_message(message)
        await channel.emit_message(message)
        markdown = "**bold**\n\n- one\n- two\n\n```sh\nprintf hello\n```"
        await client.emit_agent_message("thread-1", "turn-1", markdown)
        await asyncio.sleep(0.01)
    finally:
        await gateway.stop()

    assert client.connected is True
    assert client.closed is True
    assert client.started_threads == [
        {
            "cwd": str(tmp_path),
            "sandbox": "danger-full-access",
            "approval_policy": "never",
        }
    ]
    assert client.started_turns == [("thread-1", "Build it", {})]
    projected = next(message for message in channel.sent if markdown in sent_texts_for(message))
    assert projected.reply_to == "m1"


@pytest.mark.asyncio
async def test_new_and_permission_apply_to_the_next_thread(tmp_path: Path) -> None:
    gateway, channel, client = compose(tmp_path)
    await gateway.start()
    try:
        await channel.emit_message(inbound("m1", "first"))
        await channel.emit_message(inbound("m2", "/permission approval-required"))
        await channel.emit_message(inbound("m3", "second"))
        await channel.emit_message(inbound("m4", "/new"))
        await channel.emit_message(inbound("m5", "third"))
    finally:
        await gateway.stop()

    assert [item["approval_policy"] for item in client.started_threads] == [
        "never",
        "on-request",
        "on-request",
    ]
    assert [turn[0] for turn in client.started_turns] == [
        "thread-1",
        "thread-2",
        "thread-3",
    ]
    assert any("Commands require approval" in text for text in sent_texts(channel))
    assert any("next message will start a new Zen thread" in text for text in sent_texts(channel))


@pytest.mark.asyncio
async def test_threads_pick_status_history_catchup_and_unsupported_delete(
    tmp_path: Path,
) -> None:
    client = FakeAppServer()
    client.threads = {
        "thread-old": {
            "id": "thread-old",
            "cwd": str(tmp_path),
            "preview": "older work",
            "updatedAt": 10,
            "status": {"type": "idle"},
        },
        "thread-new": {
            "id": "thread-new",
            "cwd": str(tmp_path),
            "preview": "desktop handoff",
            "updatedAt": 20,
            "status": {"type": "idle"},
        },
    }
    client.turn_pages["thread-new"] = [
        {
            "id": "turn-live",
            "status": "inProgress",
            "items": [
                {"id": "user-live", "type": "userMessage", "text": "Continue work"},
                {
                    "id": "progress",
                    "type": "agentMessage",
                    "phase": "commentary",
                    "text": "Inspecting the repository.",
                },
            ],
        },
        {
            "id": "turn-old",
            "status": "completed",
            "items": [
                {"id": "user-old", "type": "userMessage", "text": "Start work"},
                {
                    "id": "answer-old",
                    "type": "agentMessage",
                    "phase": "final_answer",
                    "text": "Initial work is complete.",
                },
            ],
        },
    ]
    gateway, channel, _ = compose(tmp_path, client)
    await gateway.start()
    try:
        for message_id, text in (
            ("m1", "/threads"),
            ("m2", "/pick thread-new"),
            ("m3", "/status"),
            ("m4", "/catchup 2"),
            ("m5", "/history 2"),
            ("m6", "/delete"),
            ("m7", "continue from IM"),
        ):
            await channel.emit_message(inbound(message_id, text))
    finally:
        await gateway.stop()

    rendered = "\n".join(sent_texts(channel))
    assert "desktop handoff" in rendered
    assert client.resumed_threads == []
    assert client.started_turns[-1][0] == "thread-new"
    assert "## Zen thread" in rendered
    assert "Inspecting the repository." in rendered
    assert "Initial work is complete." in rendered
    assert "unsupported" in rendered.casefold()


@pytest.mark.asyncio
async def test_model_catalog_switch_and_unavailable_error(tmp_path: Path) -> None:
    gateway, channel, client = compose(tmp_path)
    await gateway.start()
    try:
        await channel.emit_message(inbound("m1", "/model"))
        await channel.emit_message(inbound("m2", "start"))
        await channel.emit_message(inbound("m3", "/model model-two"))
        await channel.emit_message(inbound("m4", "/model missing"))
    finally:
        await gateway.stop()

    rendered = "\n".join(sent_texts(channel))
    assert "**Model One** (`model-one`) — default" in rendered
    assert "**Model Two** (`model-two`)" in rendered
    assert client.calls == [
        ("thread/settings/update", {"threadId": "thread-1", "model": "model-two"}),
        ("thread/settings/update", {"threadId": "thread-1", "model": "missing"}),
    ]
    assert "Could not switch model to **missing**" in rendered
    assert "Model is not available from this Zen host" in rendered


@pytest.mark.asyncio
async def test_command_approval_round_trips_with_stable_sdk_request_ref(tmp_path: Path) -> None:
    gateway, channel, client = compose(tmp_path)
    stable_refs: list[str] = []
    await gateway.start()
    try:
        await channel.emit_message(inbound("m1", "run it"))
        for index, (request_id, command) in enumerate(
            ((42, "approve"), (43, "deny"), (44, "cancel")),
            start=2,
        ):
            sent_before = len(channel.sent)
            await client.emit_approval("thread-1", "turn-1", request_id)
            await asyncio.sleep(0.01)
            approval = next(
                text for text in sent_texts(channel)[sent_before:] if "echo hello" in text
            )
            match = re.search(rf"/{command} ([^`\s]+)", approval)
            assert match is not None
            stable_ref = match.group(1)
            stable_refs.append(stable_ref)
            assert stable_ref != str(request_id)
            assert f"/approve {stable_ref}" in approval
            assert f"/deny {stable_ref}" in approval
            assert f"/cancel {stable_ref}" in approval
            await channel.emit_message(inbound(f"m{index}", f"/{command} {stable_ref}"))
    finally:
        await gateway.stop()

    assert client.replies == [
        (42, {"decision": "accept"}, 1),
        (43, {"decision": "decline"}, 1),
        (44, {"decision": "cancel"}, 1),
    ]
    rendered = "\n".join(sent_texts(channel))
    for stable_ref, decision in zip(stable_refs, ("accept", "decline", "cancel"), strict=True):
        assert f"Approval {stable_ref}: {decision}" in rendered


@pytest.mark.asyncio
async def test_generic_files_become_manifest_while_images_stay_native(tmp_path: Path) -> None:
    document = tmp_path / "design.txt"
    image = tmp_path / "diagram.png"
    document.write_text("design", encoding="utf-8")
    image.write_bytes(b"png")
    gateway, channel, client = compose(tmp_path)
    message = inbound(
        "m1",
        content=(
            TextContent("Review these"),
            AttachmentContent(
                attachment_id="file-1",
                media_type="text/plain",
                source=LocalPath(str(document)),
                filename="design.txt",
                size_bytes=document.stat().st_size,
            ),
            AttachmentContent(
                attachment_id="image-1",
                media_type="image/png",
                source=LocalPath(str(image)),
                filename="diagram.png",
                size_bytes=image.stat().st_size,
            ),
        ),
    )
    await gateway.start()
    try:
        await channel.emit_message(message)
    finally:
        await gateway.stop()

    thread_id, text, options = client.started_turns[0]
    assert thread_id == "thread-1"
    assert text is None
    assert options["input_items"] == [
        {
            "type": "text",
            "text": f"Review these\n\n[Attachments]\n- design.txt: {document}",
        },
        {"type": "localImage", "path": str(image)},
    ]


@pytest.mark.asyncio
async def test_attachment_only_file_becomes_one_manifest_turn(tmp_path: Path) -> None:
    document = tmp_path / "notes.txt"
    document.write_text("notes", encoding="utf-8")
    gateway, channel, client = compose(tmp_path)
    message = inbound(
        "file-only",
        content=(
            AttachmentContent(
                attachment_id="file-1",
                media_type="text/plain",
                source=LocalPath(str(document)),
                filename="notes.txt",
                size_bytes=document.stat().st_size,
            ),
        ),
    )
    await gateway.start()
    try:
        await channel.emit_message(message)
    finally:
        await gateway.stop()

    assert client.started_turns == [("thread-1", f"[Attachments]\n- notes.txt: {document}", {})]


@pytest.mark.asyncio
async def test_attachment_only_image_stays_native_without_synthetic_text(tmp_path: Path) -> None:
    image = tmp_path / "photo.png"
    image.write_bytes(b"png")
    gateway, channel, client = compose(tmp_path)
    message = inbound(
        "image-only",
        content=(
            AttachmentContent(
                attachment_id="image-1",
                media_type="image/png",
                source=LocalPath(str(image)),
                filename="photo.png",
                size_bytes=image.stat().st_size,
            ),
        ),
    )
    await gateway.start()
    try:
        await channel.emit_message(message)
    finally:
        await gateway.stop()

    assert client.started_turns == [
        (
            "thread-1",
            None,
            {
                "input_items": [{"type": "localImage", "path": str(image)}],
                "expected_local_image_epoch": 1,
            },
        )
    ]


@pytest.mark.asyncio
async def test_application_failure_is_reported_to_the_originating_message(tmp_path: Path) -> None:
    client = FakeAppServer()
    client.fail_turn = RuntimeError("thread is busy")
    gateway, channel, _ = compose(tmp_path, client)
    await gateway.start()
    try:
        message = inbound("m1", "hello")
        await channel.emit_message(message)
        await channel.emit_message(message)
    finally:
        await gateway.stop()

    errors = [message for message in channel.sent if "thread is busy" in sent_texts_for(message)]
    assert len(errors) == 1
    assert "Zen could not process this message" in sent_texts_for(errors[0])
    assert errors[0].reply_to == "m1"
    assert len(client.started_turns) == 1


def sent_texts_for(message) -> str:
    return "\n".join(part.text for part in message.content if isinstance(part, TextContent))
