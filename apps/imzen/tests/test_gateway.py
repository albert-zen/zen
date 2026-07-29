from __future__ import annotations

from typing import Any

import pytest
from imcodex.models import InboundMessage

from imzen.middleware import ImZenMiddleware


class FakeAppServer:
    def __init__(self) -> None:
        self.notification_handlers = []
        self.server_request_handlers = []
        self.connection_reset_handlers = []
        self.started_threads: list[dict[str, Any]] = []
        self.started_turns: list[tuple[str, dict[str, Any]]] = []
        self.replies: list[tuple[str | int, dict]] = []
        self.error_replies: list[tuple[str | int, int, str]] = []
        self.initialized = False
        self.closed = False
        self._thread_sequence = 0

    def add_notification_handler(self, handler) -> None:
        self.notification_handlers.append(handler)

    def add_server_request_handler(self, handler) -> None:
        self.server_request_handlers.append(handler)

    def add_connection_reset_handler(self, handler) -> None:
        self.connection_reset_handlers.append(handler)

    async def initialize(self) -> dict:
        self.initialized = True
        return {}

    async def start_thread(self, **params: Any) -> dict:
        self.started_threads.append(params)
        self._thread_sequence += 1
        return {"thread": {"id": f"thread-{self._thread_sequence}"}}

    async def start_turn(self, thread_id: str, **params: Any) -> dict:
        self.started_turns.append((thread_id, params))
        return {"turn": {"id": f"turn-{len(self.started_turns)}"}}

    async def reply_to_transport_request(
        self,
        request_id: str | int,
        result: dict,
        **_params: Any,
    ) -> dict:
        self.replies.append((request_id, result))
        return {}

    async def reply_error_to_transport_request(
        self,
        request_id: str | int,
        *,
        code: int,
        message: str,
    ) -> dict:
        self.error_replies.append((request_id, code, message))
        return {}

    async def close(self) -> None:
        self.closed = True

    async def notify(self, payload: dict) -> None:
        for handler in self.notification_handlers:
            await handler(payload)

    async def request(self, payload: dict) -> None:
        for handler in self.server_request_handlers:
            await handler(payload)

    async def reset(self, epoch: int) -> None:
        for handler in self.connection_reset_handlers:
            await handler(epoch)


class FakeAdapter:
    channel_id = "test"

    def __init__(self) -> None:
        self.sent = []

    async def send_message(self, message) -> None:
        self.sent.append(message)


def inbound(message_id: str, text: str, *, conversation_id: str = "chat-1") -> InboundMessage:
    return InboundMessage(
        channel_id="test",
        conversation_id=conversation_id,
        user_id="owner",
        message_id=message_id,
        text=text,
    )


@pytest.mark.asyncio
async def test_conversation_reuses_one_thread_and_projects_completed_item(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)
    await middleware.start()

    await middleware.handle_inbound(adapter, inbound("m1", "first"))
    await middleware.handle_inbound(adapter, inbound("m2", "second"))

    assert client.initialized is True
    assert client.started_threads == [{"cwd": str(tmp_path)}]
    assert [thread_id for thread_id, _ in client.started_turns] == [
        "thread-1",
        "thread-1",
    ]
    assert client.started_turns[0][1]["input_items"] == [{"type": "text", "text": "first"}]

    await client.notify(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-2",
                "item": {
                    "id": "agent-1",
                    "type": "agentMessage",
                    "text": "answer",
                },
            },
        }
    )

    assert len(adapter.sent) == 1
    assert adapter.sent[0].text == "answer"
    assert adapter.sent[0].metadata["delivery_id"] == "imzen:item:thread-1:agent-1"
    assert adapter.sent[0].metadata["reply_to_message_id"] == "m2"

    await middleware.stop()
    assert client.closed is True


@pytest.mark.asyncio
async def test_conversations_get_distinct_threads(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(adapter, inbound("m1", "one", conversation_id="chat-1"))
    await middleware.handle_inbound(adapter, inbound("m2", "two", conversation_id="chat-2"))

    assert len(client.started_threads) == 2
    assert [thread_id for thread_id, _ in client.started_turns] == [
        "thread-1",
        "thread-2",
    ]


@pytest.mark.asyncio
async def test_new_clears_only_the_client_binding(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(adapter, inbound("m1", "one"))
    await middleware.handle_inbound(adapter, inbound("m2", "/new"))
    await middleware.handle_inbound(adapter, inbound("m3", "two"))

    assert len(client.started_threads) == 2
    assert [thread_id for thread_id, _ in client.started_turns] == [
        "thread-1",
        "thread-2",
    ]
    assert adapter.sent[0].text == "The next message will start a new Zen thread."


@pytest.mark.asyncio
async def test_app_server_failure_is_reported_without_a_client_queue(tmp_path):
    class FailingAppServer(FakeAppServer):
        async def start_turn(self, thread_id: str, **params: Any) -> dict:
            del thread_id, params
            raise RuntimeError("thread is busy")

    client = FailingAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(adapter, inbound("m1", "hello"))

    assert len(adapter.sent) == 1
    assert adapter.sent[0].message_type == "error"
    assert "thread is busy" in adapter.sent[0].text
    assert not hasattr(middleware.gateway, "outbox")


@pytest.mark.asyncio
async def test_approval_request_round_trip(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)
    await middleware.start()
    await middleware.handle_inbound(adapter, inbound("m1", "run it"))

    await client.request(
        {
            "id": 42,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "command": ["echo", "hello"],
                    "cwd": str(tmp_path),
                },
            },
        }
    )

    assert adapter.sent[-1].message_type == "approval_request"
    assert "echo hello" in adapter.sent[-1].text
    assert adapter.sent[-1].request_id == "42"

    await middleware.handle_inbound(adapter, inbound("m2", "/approve 42"))

    assert client.replies == [(42, {"decision": "accept"})]
    assert adapter.sent[-1].text == "Approval 42: accept."


@pytest.mark.asyncio
async def test_resolved_approval_is_removed_without_recovery_state(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)
    await middleware.start()
    await middleware.handle_inbound(adapter, inbound("m1", "run it"))
    await client.request(
        {
            "id": "approval-1",
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "command": "printf hello",
            },
        }
    )

    await client.notify(
        {
            "method": "serverRequest/resolved",
            "params": {
                "threadId": "thread-1",
                "requestId": "approval-1",
            },
        }
    )
    await middleware.handle_inbound(adapter, inbound("m2", "/approve approval-1"))

    assert client.replies == []
    assert adapter.sent[-1].message_type == "error"
    assert adapter.sent[-1].text == "No matching approval request is pending."


@pytest.mark.asyncio
async def test_connection_reset_clears_transport_state_and_warns_bound_conversation(
    tmp_path,
):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)
    await middleware.start()
    await middleware.handle_inbound(adapter, inbound("m1", "run it"))
    await client.request(
        {
            "id": "approval-1",
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "command": "printf hello",
            },
        }
    )

    await client.reset(7)
    await middleware.handle_inbound(adapter, inbound("m2", "/approve approval-1"))

    assert client.replies == []
    assert adapter.sent[-2].message_type == "error"
    assert "connection was reset" in adapter.sent[-2].text
    assert adapter.sent[-2].metadata["delivery_id"] == "imzen:connection-reset:7:test:chat-1"
    assert adapter.sent[-1].text == "No matching approval request is pending."
    assert middleware.gateway.thread_for("test", "chat-1") == "thread-1"


@pytest.mark.asyncio
async def test_new_explicitly_cancels_pending_approval(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)
    await middleware.start()
    await middleware.handle_inbound(adapter, inbound("m1", "run it"))
    await client.request(
        {
            "id": 7,
            "method": "item/fileChange/requestApproval",
            "params": {"threadId": "thread-1", "turnId": "turn-1"},
        }
    )

    await middleware.handle_inbound(adapter, inbound("m2", "/new"))

    assert client.replies == [(7, {"decision": "cancel"})]
    assert middleware.gateway.thread_for("test", "chat-1") is None


@pytest.mark.asyncio
async def test_unsupported_server_request_is_explicitly_rejected(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)
    await middleware.start()

    await client.request(
        {
            "id": "request-1",
            "method": "mcpServer/elicitation/request",
            "params": {},
        }
    )

    assert client.error_replies == [
        (
            "request-1",
            -32601,
            "IMZen does not support server request mcpServer/elicitation/request",
        )
    ]


@pytest.mark.asyncio
async def test_turn_failure_without_failure_item_is_visible(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)
    await middleware.start()
    await middleware.handle_inbound(adapter, inbound("m1", "hello"))
    await client.notify(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "pre-tool-message",
                    "type": "agentMessage",
                    "text": "I will try the tool.",
                },
            },
        }
    )

    await client.notify(
        {
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {"id": "turn-1", "status": "failed"},
            },
        }
    )

    assert adapter.sent[-1].message_type == "error"
    assert adapter.sent[-1].text == "The Zen turn failed."


@pytest.mark.asyncio
async def test_error_notification_reports_exact_failure_once_after_agent_text(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)
    await middleware.start()
    await middleware.handle_inbound(adapter, inbound("m1", "hello"))
    await client.notify(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "pre-tool-message",
                    "type": "agentMessage",
                    "text": "I will try the tool.",
                },
            },
        }
    )
    await client.notify(
        {
            "method": "error",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "error": {"message": "tool execution exploded"},
                "willRetry": False,
            },
        }
    )
    await client.notify(
        {
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {"id": "turn-1", "status": "failed"},
            },
        }
    )

    assert [message.text for message in adapter.sent] == [
        "I will try the tool.",
        "tool execution exploded",
    ]
    assert adapter.sent[-1].message_type == "error"
