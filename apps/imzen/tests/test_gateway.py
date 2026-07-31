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
        self.calls: list[tuple[str, dict]] = []
        self.models: list[dict[str, Any]] = [
            {
                "id": "model-one",
                "displayName": "Model One",
                "isDefault": True,
            },
            {"id": "model-two", "displayName": "Model Two"},
        ]
        self.listed_threads: list[dict[str, Any]] = []
        self.list_threads_calls = 0
        self.resumed_threads: list[str] = []
        self.read_threads: list[str] = []
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

    async def call(self, method: str, params: dict | None = None) -> dict:
        self.calls.append((method, dict(params or {})))
        return {}

    async def list_models(self, **_params: Any) -> dict:
        return {"data": self.models}

    async def start_thread(self, **params: Any) -> dict:
        self.started_threads.append(params)
        self._thread_sequence += 1
        return {"thread": {"id": f"thread-{self._thread_sequence}"}}

    async def list_threads(self, **_params: Any) -> dict:
        self.list_threads_calls += 1
        return {"data": self.listed_threads}

    async def resume_thread(self, **params: Any) -> dict:
        thread_id = str(params["thread_id"])
        self.resumed_threads.append(thread_id)
        thread = next(thread for thread in self.listed_threads if thread["id"] == thread_id)
        return {
            "thread": thread,
            "approvalPolicy": thread.get("approvalPolicy", "never"),
        }

    async def read_thread(self, thread_id: str, **_params: Any) -> dict:
        self.read_threads.append(thread_id)
        thread = next(
            (thread for thread in self.listed_threads if thread["id"] == thread_id),
            {
                "id": thread_id,
                "preview": "",
                "cwd": "",
                "status": {"type": "idle"},
            },
        )
        return {"thread": thread}

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
    assert client.started_threads == [
        {
            "cwd": str(tmp_path),
            "sandbox": "danger-full-access",
            "approval_policy": "never",
        }
    ]
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
async def test_model_lists_host_catalog_and_switches_the_bound_thread(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(adapter, inbound("m1", "/model"))
    assert adapter.sent[-1].message_type == "status"
    assert "**Model One** (`model-one`) — default" in adapter.sent[-1].text
    assert "**Model Two** (`model-two`)" in adapter.sent[-1].text

    await middleware.handle_inbound(adapter, inbound("m2", "start work"))
    await middleware.handle_inbound(adapter, inbound("m3", "/model model-two"))

    assert client.calls == [
        (
            "thread/settings/update",
            {"threadId": "thread-1", "model": "model-two"},
        )
    ]
    assert adapter.sent[-1].text == "Model switched to **model-two** for subsequent turns."


@pytest.mark.asyncio
async def test_model_rejects_unavailable_model_and_requires_a_bound_thread(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(adapter, inbound("m1", "/model model-two"))
    assert adapter.sent[-1].message_type == "error"
    assert "No Zen thread is selected" in adapter.sent[-1].text

    await middleware.handle_inbound(adapter, inbound("m2", "start work"))
    await middleware.handle_inbound(adapter, inbound("m3", "/model missing"))
    assert adapter.sent[-1].message_type == "error"
    assert adapter.sent[-1].text == "Model is not available from this Zen host: missing"
    assert client.calls == []


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
async def test_permission_mode_is_selectable_and_applies_to_the_next_thread(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(adapter, inbound("m1", "first"))
    await middleware.handle_inbound(
        adapter,
        inbound("m2", "/permission approval-required"),
    )
    await middleware.handle_inbound(adapter, inbound("m3", "second"))
    await middleware.handle_inbound(adapter, inbound("m4", "/permission"))

    assert client.started_threads == [
        {
            "cwd": str(tmp_path),
            "sandbox": "danger-full-access",
            "approval_policy": "never",
        },
        {
            "cwd": str(tmp_path),
            "sandbox": "danger-full-access",
            "approval_policy": "on-request",
        },
    ]
    assert "Commands require approval" in adapter.sent[-2].text
    assert adapter.sent[-1].text.startswith("Permission mode: approval-required.")


@pytest.mark.asyncio
async def test_agent_markdown_is_delivered_unchanged(tmp_path):
    client = FakeAppServer()
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)
    await middleware.start()
    await middleware.handle_inbound(adapter, inbound("m1", "format it"))

    markdown = "**bold**\n\n- one\n- two\n\n```sh\nprintf hello\n```"
    await client.notify(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "agent-markdown",
                    "type": "agentMessage",
                    "text": markdown,
                },
            },
        }
    )

    assert adapter.sent[-1].text == markdown


@pytest.mark.asyncio
async def test_list_pick_and_status_continue_an_existing_app_server_thread(tmp_path):
    client = FakeAppServer()
    client.listed_threads = [
        {
            "id": "thread-older",
            "preview": "older work",
            "cwd": str(tmp_path),
            "updatedAt": 10,
            "status": {"type": "idle"},
            "approvalPolicy": "never",
        },
        {
            "id": "thread-t3",
            "preview": "T3 desktop handoff",
            "cwd": str(tmp_path),
            "updatedAt": 20,
            "status": {"type": "idle"},
            "approvalPolicy": "never",
        },
    ]
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(adapter, inbound("m1", "/threads"))
    await middleware.handle_inbound(adapter, inbound("m2", "/pick 1"))
    await middleware.handle_inbound(adapter, inbound("m3", "/status"))
    await middleware.handle_inbound(adapter, inbound("m4", "continue from IM"))

    assert "T3 desktop handoff" in adapter.sent[0].text
    assert adapter.sent[0].text.index("T3 desktop handoff") < adapter.sent[0].text.index(
        "older work"
    )
    assert client.resumed_threads == ["thread-t3"]
    assert client.read_threads == ["thread-t3"]
    assert middleware.gateway.thread_for("test", "chat-1") == "thread-t3"
    assert client.started_turns[-1] == (
        "thread-t3",
        {"input_items": [{"type": "text", "text": "continue from IM"}]},
    )


@pytest.mark.asyncio
async def test_pick_number_uses_the_current_threads_cache(tmp_path):
    client = FakeAppServer()
    client.listed_threads = [
        {
            "id": "thread-cached",
            "preview": "cached result",
            "updatedAt": 10,
            "status": {"type": "idle"},
        }
    ]
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(adapter, inbound("m1", "/threads"))
    client.listed_threads = [
        {
            "id": "thread-newer",
            "preview": "new server result",
            "updatedAt": 20,
            "status": {"type": "idle"},
        },
        *client.listed_threads,
    ]
    await middleware.handle_inbound(adapter, inbound("m2", "/pick 1"))

    assert client.list_threads_calls == 1
    assert client.resumed_threads == ["thread-cached"]
    assert middleware.gateway.thread_for("test", "chat-1") == "thread-cached"


@pytest.mark.parametrize("selector", ["thread-new", "fresh handoff"])
@pytest.mark.asyncio
async def test_pick_id_or_query_refreshes_the_full_thread_list(tmp_path, selector):
    client = FakeAppServer()
    client.listed_threads = [
        {
            "id": "thread-cached",
            "preview": "cached result",
            "updatedAt": 10,
            "status": {"type": "idle"},
        }
    ]
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(adapter, inbound("m1", "/threads"))
    client.listed_threads = [
        {
            "id": "thread-new",
            "preview": "fresh handoff",
            "updatedAt": 20,
            "status": {"type": "idle"},
        },
        *client.listed_threads,
    ]
    await middleware.handle_inbound(adapter, inbound("m2", f"/pick {selector}"))

    assert client.list_threads_calls == 2
    assert client.resumed_threads == ["thread-new"]
    assert middleware.gateway.thread_for("test", "chat-1") == "thread-new"


@pytest.mark.asyncio
async def test_threads_limits_the_displayed_and_numbered_results(tmp_path):
    client = FakeAppServer()
    client.listed_threads = [
        {
            "id": f"thread-{index:02}",
            "preview": f"work-{index:02}",
            "updatedAt": 100 - index,
            "status": {"type": "idle"},
        }
        for index in range(25)
    ]
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(adapter, inbound("m1", "/threads"))

    text = adapter.sent[-1].text
    assert "`thread-19`" in text
    assert "`thread-20`" not in text
    assert "Showing 20 of 25 matching threads." in text
    assert "Narrow the list with `/threads <query>`." in text

    await middleware.handle_inbound(adapter, inbound("m2", "/pick 21"))

    assert client.list_threads_calls == 1
    assert client.resumed_threads == []
    assert adapter.sent[-1].message_type == "error"
    assert adapter.sent[-1].text == "No matching Zen thread."


@pytest.mark.asyncio
async def test_pick_rejects_a_thread_selected_by_another_conversation(tmp_path):
    client = FakeAppServer()
    client.listed_threads = [
        {
            "id": "thread-shared",
            "preview": "shared work",
            "updatedAt": 10,
            "status": {"type": "idle"},
        }
    ]
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)

    await middleware.handle_inbound(
        adapter,
        inbound("m1", "/pick thread-shared", conversation_id="chat-1"),
    )
    await middleware.handle_inbound(
        adapter,
        inbound("m2", "/pick thread-shared", conversation_id="chat-2"),
    )

    assert client.resumed_threads == ["thread-shared"]
    assert middleware.gateway.thread_for("test", "chat-1") == "thread-shared"
    assert middleware.gateway.thread_for("test", "chat-2") is None
    assert adapter.sent[-1].message_type == "error"
    assert "already selected by another IM conversation" in adapter.sent[-1].text
    assert "was not rebound" in adapter.sent[-1].text


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
    await middleware.handle_inbound(adapter, inbound("m3", "/approve 7"))

    assert client.replies == [(7, {"decision": "cancel"})]
    assert middleware.gateway.thread_for("test", "chat-1") is None
    assert adapter.sent[-1].message_type == "error"
    assert adapter.sent[-1].text == "No matching approval request is pending."


@pytest.mark.asyncio
async def test_pick_cancels_old_thread_approval_before_rebinding(tmp_path):
    client = FakeAppServer()
    client.listed_threads = [
        {
            "id": "thread-handoff",
            "preview": "handoff target",
            "updatedAt": 20,
            "status": {"type": "idle"},
        }
    ]
    adapter = FakeAdapter()
    middleware = ImZenMiddleware(client=client, default_cwd=str(tmp_path))
    middleware.register_adapter(adapter)
    await middleware.start()
    await middleware.handle_inbound(adapter, inbound("m1", "run it"))
    await client.request(
        {
            "id": "approval-old",
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "command": "printf old",
            },
        }
    )

    await middleware.handle_inbound(adapter, inbound("m2", "/pick thread-handoff"))
    await middleware.handle_inbound(adapter, inbound("m3", "/approve approval-old"))

    assert client.replies == [("approval-old", {"decision": "cancel"})]
    assert client.resumed_threads == ["thread-handoff"]
    assert middleware.gateway.thread_for("test", "chat-1") == "thread-handoff"
    assert adapter.sent[-1].message_type == "error"
    assert adapter.sent[-1].text == "No matching approval request is pending."


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
