from __future__ import annotations

import asyncio
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from imagent import Gateway, GatewayExtensions, MemoryGatewayStore, SQLiteGatewayStore
from imagent.applications import (
    AgentInput,
    ApplicationInputRejected,
    ZenApplicationAdapter,
)
from imagent.applications.adapters.appserver.client import AppServerError
from imagent.gateway.input import InboundFailurePhase
from imagent.gateway.routing import ProjectionPolicy
from imagent.interaction.media import AttachmentContent, LocalPath
from imagent.interaction.messages import ConversationRef, InboundMessage, TextContent, TextFormat
from imagent.testing import FakeChannelAdapter

from imzen.config import Settings
from imzen.controller import (
    ImZenContentTransformer,
    ImZenController,
    ImZenFailurePresenter,
    ImZenRequestPresenter,
    thread_start_options,
)
from imzen.main import create_gateway


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
        self.fail_model_update: Exception | None = None

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
        if method == "thread/settings/update" and self.fail_model_update is not None:
            raise self.fail_model_update
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
            "_connection_epoch": self.connection_epoch,
            "method": "item/commandExecution/requestApproval",
            "params": {
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


def compose(
    tmp_path: Path,
    client: FakeAppServer | None = None,
    *,
    idempotency=None,
    allow_unique_prefix=False,
):
    resolved_client = client or FakeAppServer()
    channel = FakeChannelAdapter("test")
    application = ZenApplicationAdapter(
        application_instance_id="zen-main",
        workspace_id="imzen-workspace",
        client=resolved_client,
        cwd=str(tmp_path),
        shared_filesystem_root=tmp_path,
        thread_start_options=thread_start_options("full-access"),
        thread_creation_profiles={
            mode: thread_start_options(mode) for mode in ("full-access", "approval-required")
        },
    )
    controller = ImZenController(
        application=application, client=resolved_client, allow_unique_prefix=allow_unique_prefix
    )
    gateway = Gateway(
        gateway_id="imzen",
        channels=[channel],
        applications=[application],
        store=idempotency if idempotency is not None else MemoryGatewayStore(),
        controller=controller,
        projection_policy=ProjectionPolicy.FOREGROUND_ONLY,
        extensions=GatewayExtensions(
            inbound_content_transformer=ImZenContentTransformer(),
            inbound_failure_presenter=ImZenFailurePresenter(),
            request_presenter=ImZenRequestPresenter(),
        ),
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
    assert projected.content[0].format is TextFormat.MARKDOWN


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
        ):
            await channel.emit_message(inbound(message_id, text))
        # The selected desktop-origin Turn must finish before a new IM Turn.
        # Active Turns without IM reply correlation are covered by test_steering.
        client.turn_pages["thread-new"][0]["status"] = "completed"
        await channel.emit_message(inbound("m7", "continue from IM"))
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
async def test_model_transport_failure_reports_ambiguous_native_outcome(tmp_path: Path) -> None:
    gateway, channel, client = compose(tmp_path)
    await gateway.start()
    try:
        await channel.emit_message(inbound("m1", "start"))
        client.fail_model_update = RuntimeError("connection lost")
        await channel.emit_message(inbound("m2", "/model model-two"))
    finally:
        await gateway.stop()

    rendered = "\n".join(sent_texts(channel))
    assert "Zen may already have applied it" in rendered
    assert "Retrying the same model is safe" in rendered


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
        {"type": "image", "url": "data:image/png;base64,cG5n"},
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
                "input_items": [{"type": "image", "url": "data:image/png;base64,cG5n"}],
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

    errors = [
        message for message in channel.sent if "outcome is unknown" in sent_texts_for(message)
    ]
    assert len(errors) == 1
    assert "Zen may have accepted this message" in sent_texts_for(errors[0])
    assert errors[0].reply_to == "m1"
    assert len(client.started_turns) == 1


@pytest.mark.asyncio
async def test_outcome_unknown_is_not_reauthorized_after_restart(tmp_path: Path) -> None:
    state_path = tmp_path / "gateway.sqlite3"
    message = inbound("m1", "hello")
    first_state = SQLiteGatewayStore(state_path)
    first_client = FakeAppServer()
    first_client.fail_turn = RuntimeError("connection lost")
    first_gateway, first_channel, _ = compose(
        tmp_path,
        first_client,
        idempotency=first_state,
    )
    await first_gateway.start()
    try:
        await first_channel.emit_message(message)
    finally:
        await first_gateway.stop()
        await first_state.close()

    reopened_state = SQLiteGatewayStore(state_path, stale_claim_after_seconds=0)
    second_client = FakeAppServer()
    second_gateway, second_channel, _ = compose(
        tmp_path,
        second_client,
        idempotency=reopened_state,
    )
    await second_gateway.start()
    try:
        await second_channel.emit_message(message)
    finally:
        await second_gateway.stop()
        await reopened_state.close()

    assert len(first_client.started_turns) == 1
    assert second_client.started_threads == []
    assert second_client.started_turns == []


@pytest.mark.asyncio
async def test_proven_start_rejection_has_one_plain_reply_and_dedupes_after_restart(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "gateway.sqlite3"
    message = inbound("proven-rejection", "synthetic input")
    first_state = SQLiteGatewayStore(state_path)
    first_client = FakeAppServer()
    first_client.fail_turn = ApplicationInputRejected("thread_busy")
    gateway, channel, _ = compose(tmp_path, first_client, idempotency=first_state)
    await gateway.start()
    try:
        await channel.emit_message(message)
        await channel.emit_message(message)
    finally:
        await gateway.stop()
        await first_state.close()
    replies = [out for out in channel.sent if "message was not sent" in sent_texts_for(out)]
    assert len(replies) == 1
    assert replies[0].content[0].format is TextFormat.PLAIN
    assert len(first_client.started_turns) == 1

    reopened = SQLiteGatewayStore(state_path, stale_claim_after_seconds=0)
    second_client = FakeAppServer()
    second, second_channel, _ = compose(tmp_path, second_client, idempotency=reopened)
    await second.start()
    try:
        await second_channel.emit_message(message)
    finally:
        await second.stop()
        await reopened.close()
    assert not second_client.started_turns
    assert not second_channel.sent


@pytest.mark.parametrize(
    ("phase", "expected"),
    (
        (InboundFailurePhase.PRE_ACCEPTANCE, "could not process"),
        (InboundFailurePhase.OUTCOME_UNKNOWN, "outcome is unknown"),
        (InboundFailurePhase.POST_ACCEPTANCE, "projection failed"),
        (InboundFailurePhase.TURN_ENDED, "turn has ended"),
        (InboundFailurePhase.THREAD_BUSY, "still running"),
    ),
)
@pytest.mark.asyncio
async def test_failure_presenter_preserves_sdk_classification(phase, expected) -> None:
    presented = await ImZenFailurePresenter().present_failure(
        phase,
        conversation_ref=ConversationRef("test", "chat-1"),
        delivery_id="failure-1",
        reply_to_message_id="native-1",
    )

    assert presented.delivery_id == "failure-1"
    assert presented.conversation_ref == ConversationRef("test", "chat-1")
    assert presented.reply_to == "native-1"
    assert expected in sent_texts_for(presented)
    assert presented.content[0].format is TextFormat.PLAIN
    assert "**" not in sent_texts_for(presented)
    if phase in {InboundFailurePhase.TURN_ENDED, InboundFailurePhase.THREAD_BUSY}:
        assert "message was not sent" in sent_texts_for(presented)


def sent_texts_for(message) -> str:
    return "\n".join(part.text for part in message.content if isinstance(part, TextContent))


@pytest.mark.asyncio
async def test_unique_prefix_exact_commands_and_ambiguity_have_one_dispatch(tmp_path: Path) -> None:
    gateway, channel, client = compose(tmp_path, allow_unique_prefix=True)
    await gateway.start()
    try:
        await channel.emit_message(inbound("p1", "/per approval-required"))
        assert any("Commands require approval" in text for text in sent_texts(channel))
        await channel.emit_message(inbound("p2", "/model"))
        assert any("model-one" in text for text in sent_texts(channel))
        before = (list(client.started_threads), list(client.started_turns), list(client.calls))
        await channel.emit_message(inbound("p3", "/a"))
        assert "Ambiguous" in sent_texts(channel)[-1]
        assert (client.started_threads, client.started_turns, client.calls) == before
        await channel.emit_message(inbound("p4", "/th"))
        assert "Ambiguous" in sent_texts(channel)[-1]
        await channel.emit_message(inbound("p5", "/thread"))
        assert "Ambiguous" not in sent_texts(channel)[-1]
    finally:
        await gateway.stop()


@pytest.mark.asyncio
async def test_prefix_default_is_exact_and_plain_messages_are_unchanged(tmp_path: Path) -> None:
    gateway, channel, client = compose(tmp_path)
    await gateway.start()
    try:
        await channel.emit_message(inbound("d1", "/per approval-required"))
        assert "Unknown command" in sent_texts(channel)[-1]
        text = "normal /per text\nwith a second line"
        await channel.emit_message(inbound("d2", text))
        assert client.started_turns[-1][1] == text
        assert client.started_threads[-1]["approval_policy"] == "never"
    finally:
        await gateway.stop()


@pytest.mark.asyncio
async def test_prefix_preserves_quoted_parameters_and_multipart_content(tmp_path: Path) -> None:
    from imzen.controller import _replace_command_name

    attachment = AttachmentContent(
        attachment_id="file",
        source=LocalPath(str(tmp_path / "file.txt")),
        media_type="text/plain",
        filename="file.txt",
    )
    message = inbound(
        "quote",
        "",
        content=(
            TextContent("  \n"),
            attachment,
            TextContent('  /ans  zen-main request-1 "q=two words"\nextra line'),
            TextContent("tail text"),
        ),
    )
    rewritten = _replace_command_name(message, "answer")
    assert rewritten.content == (
        message.content[0],
        attachment,
        TextContent('  /answer  zen-main request-1 "q=two words"\nextra line'),
        message.content[3],
    )
    assert rewritten.message_id == message.message_id
    assert rewritten.conversation_ref == message.conversation_ref


def _media_input(image: Path) -> AgentInput:
    return AgentInput(
        client_message_id="image-message",
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


def _qq_channel_config(media_dir: Path | None) -> dict[str, object]:
    config: dict[str, object] = {
        "enabled": True,
        "app_id": "123",
        "client_secret": "secret",
        "allowed_user_ids": ["user-1"],
    }
    if media_dir is not None:
        config["media_dir"] = str(media_dir)
    return {"qq": config}


@pytest.mark.asyncio
@pytest.mark.parametrize("raw_media", ["inbound-media", " inbound-media ", "~/qq-media"])
async def test_create_gateway_derives_shared_root_from_channel_media(
    tmp_path, monkeypatch, raw_media
):
    process_cwd = tmp_path / "process"
    process_cwd.mkdir()
    monkeypatch.chdir(process_cwd)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    if os.name == "nt" and raw_media.endswith(" "):
        pytest.skip("trailing whitespace is not a native Windows directory name")
    media = tmp_path / "qq-media" if raw_media.startswith("~/") else process_cwd / raw_media
    client = FakeAppServer()
    channel = FakeChannelAdapter("test")
    gateway, state = create_gateway(
        Settings(
            app_server_url="ws://127.0.0.1:4500",
            cwd=tmp_path,
            gateway_state_file=tmp_path / "gateway.sqlite3",
        ),
        client=client,
        channels=[channel],
        local_app_server=True,
        channel_config=_qq_channel_config(Path(raw_media)),
    )
    assert media.is_dir()
    image = media / "photo.png"
    image.write_bytes(b"png")
    await gateway.start()
    try:
        await channel.emit_message(inbound("image", content=_media_input(image).content))
    finally:
        await gateway.stop()
    assert client.started_turns[0][1:] == (
        None,
        {"input_items": [{"type": "image", "url": "data:image/png;base64,cG5n"}]},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("local_app_server", [False, True])
async def test_create_gateway_prefers_explicit_shared_root_over_derivation(
    tmp_path, local_app_server
):
    explicit, media = tmp_path / "explicit", tmp_path / "inbound-media"
    explicit.mkdir()
    media.mkdir()
    image, outside = explicit / "photo.png", media / "other.png"
    image.write_bytes(b"png")
    outside.write_bytes(b"png")
    client = FakeAppServer()
    channel = FakeChannelAdapter("test")
    gateway, state = create_gateway(
        Settings(
            app_server_url="wss://remote.invalid:4500",
            cwd=tmp_path,
            gateway_state_file=tmp_path / "gateway.sqlite3",
            app_server_shared_filesystem_root=explicit,
        ),
        client=client,
        channels=[channel],
        local_app_server=local_app_server,
        channel_config=_qq_channel_config(media),
    )
    await gateway.start()
    try:
        await channel.emit_message(inbound("image", content=_media_input(image).content))
        await channel.emit_message(inbound("outside", content=_media_input(outside).content))
    finally:
        await gateway.stop()
    assert len(client.started_turns) == 1
    assert any("not accepted" in text for text in sent_texts(channel))


@pytest.mark.asyncio
async def test_create_gateway_rejects_images_outside_disjoint_media_roots(tmp_path):
    first, second = tmp_path / "qq" / "media", tmp_path / "telegram" / "media"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    image = tmp_path / "private" / "outside.png"
    image.parent.mkdir()
    image.write_bytes(b"synthetic image")
    config = _qq_channel_config(first)
    config["telegram"] = {
        "enabled": True,
        "bot_token": "synthetic",
        "allowed_user_ids": ["user-1"],
        "media_dir": str(second),
    }
    client = FakeAppServer()
    channel = FakeChannelAdapter("test")
    gateway, state = create_gateway(
        Settings(
            app_server_url="ws://127.0.0.1:4500",
            cwd=tmp_path,
            gateway_state_file=tmp_path / "gateway.sqlite3",
        ),
        client=client,
        channels=[channel],
        local_app_server=True,
        channel_config=config,
    )
    await gateway.start()
    try:
        await channel.emit_message(inbound("outside", content=_media_input(image).content))
    finally:
        await gateway.stop()
    assert not client.started_turns
    assert any("not accepted" in text for text in sent_texts(channel))


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["wss://remote.invalid:4500", "ws://127.0.0.1:4500"])
async def test_standalone_server_does_not_infer_shared_filesystem(tmp_path, url):
    media = tmp_path / "local-spool"
    media.mkdir()
    image = media / "photo.png"
    image.write_bytes(b"synthetic image")
    client = FakeAppServer()
    channel = FakeChannelAdapter("test")
    gateway, state = create_gateway(
        Settings(app_server_url=url, cwd=tmp_path, gateway_state_file=tmp_path / "gateway.sqlite3"),
        client=client,
        channels=[channel],
        channel_config=_qq_channel_config(media),
    )
    await gateway.start()
    try:
        await channel.emit_message(inbound("image", content=_media_input(image).content))
    finally:
        await gateway.stop()
    assert not client.started_turns
    assert any("not accepted" in text for text in sent_texts(channel))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind", ["sibling", "symlink-escape", "missing", "directory", "missing-size", "oversize"]
)
async def test_local_media_dispatch_keeps_sdk_path_guards(tmp_path, kind):
    media = tmp_path / "media"
    media.mkdir()
    outside = tmp_path / "private.png"
    outside.write_bytes(b"synthetic image")
    image = media / "photo.png"
    if kind == "sibling":
        image = outside
    elif kind == "symlink-escape":
        try:
            image.symlink_to(outside)
        except OSError:
            pytest.skip("file symlinks unavailable")
    elif kind == "directory":
        image.mkdir()
    else:
        image.write_bytes(b"png")
    attachment = AttachmentContent(
        attachment_id="image",
        media_type="image/png",
        source=LocalPath(str(image)),
        size_bytes=None
        if kind == "missing-size"
        else 21 * 1024 * 1024
        if kind == "oversize"
        else image.stat().st_size,
    )
    if kind == "missing":
        image.unlink()
    client = FakeAppServer()
    channel = FakeChannelAdapter("test")
    gateway, state = create_gateway(
        Settings(
            app_server_url="ws://127.0.0.1:4500",
            cwd=tmp_path,
            gateway_state_file=tmp_path / "gateway.sqlite3",
        ),
        client=client,
        channels=[channel],
        channel_config=_qq_channel_config(media),
        local_app_server=True,
    )
    await gateway.start()
    try:
        await channel.emit_message(inbound("unsafe", content=(attachment,)))
    finally:
        await gateway.stop()
    assert not client.started_turns
    assert any("not accepted" in text for text in sent_texts(channel))


@pytest.mark.asyncio
async def test_local_gateway_fails_when_declared_media_root_is_a_file(tmp_path):
    media = tmp_path / "media"
    media.write_bytes(b"synthetic non-directory")
    with pytest.raises(FileExistsError):
        create_gateway(
            Settings(
                app_server_url="ws://127.0.0.1:4500",
                cwd=tmp_path,
                gateway_state_file=tmp_path / "gateway.sqlite3",
            ),
            channels=[FakeChannelAdapter("test")],
            channel_config=_qq_channel_config(media),
            local_app_server=True,
        )


@pytest.mark.asyncio
async def test_concurrent_conversations_keep_explicit_thread_creation_profiles(tmp_path):
    class ConcurrentServer(FakeAppServer):
        async def start_thread(self, **params):
            await asyncio.sleep(0)
            return await super().start_thread(**params)

    gateway, channel, client = compose(tmp_path, ConcurrentServer())
    await gateway.start()
    try:
        await channel.emit_message(
            inbound("permission-a", "/permission approval-required", conversation_id="a")
        )
        await asyncio.gather(
            channel.emit_message(inbound("a", "ask first", conversation_id="a")),
            channel.emit_message(inbound("b", "full access", conversation_id="b")),
        )
        by_text = {
            text: client.started_threads[int(thread_id.rsplit("-", 1)[1]) - 1]["approval_policy"]
            for thread_id, text, _ in client.started_turns
        }
        assert by_text == {"ask first": "on-request", "full access": "never"}
        await channel.emit_message(inbound("a", "ask first", conversation_id="a"))
        assert len(client.started_threads) == 2
        assert len(client.started_turns) == 2
    finally:
        await gateway.stop()
