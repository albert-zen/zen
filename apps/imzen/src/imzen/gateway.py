from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from imcodex.models import InboundMessage, OutboundMessage

Deliver = Callable[[OutboundMessage], Awaitable[None]]
ConversationKey = tuple[str, str]


class AppServerClient(Protocol):
    def add_notification_handler(self, handler: Callable[[dict], Awaitable[None]]) -> None: ...

    def add_server_request_handler(self, handler: Callable[[dict], Awaitable[None]]) -> None: ...

    async def initialize(self) -> dict: ...

    async def start_thread(self, **params: Any) -> dict: ...

    async def start_turn(self, thread_id: str, **params: Any) -> dict: ...

    async def reply_to_transport_request(
        self,
        transport_request_id: str | int,
        result: dict,
        **params: Any,
    ) -> dict: ...

    async def close(self) -> None: ...


@dataclass(frozen=True, slots=True)
class _PendingApproval:
    transport_request_id: str | int
    conversation: ConversationKey


class ImZenGateway:
    """Map neutral IM messages to one Zen App Server connection."""

    def __init__(
        self,
        *,
        client: AppServerClient,
        default_cwd: str | Path,
        deliver: Deliver,
    ) -> None:
        self.client = client
        self.default_cwd = str(Path(default_cwd).resolve())
        self.deliver = deliver
        self._thread_by_conversation: dict[ConversationKey, str] = {}
        self._conversation_by_thread: dict[str, ConversationKey] = {}
        self._pending_approvals: dict[str, _PendingApproval] = {}
        self._terminal_items: set[tuple[str, str]] = set()
        self._started = False

    async def start(self) -> None:
        if self._started:
            return
        self.client.add_notification_handler(self.handle_notification)
        self.client.add_server_request_handler(self.handle_server_request)
        await self.client.initialize()
        self._started = True

    async def close(self) -> None:
        for pending in tuple(self._pending_approvals.values()):
            try:
                await self.client.reply_to_transport_request(
                    pending.transport_request_id,
                    {"decision": "cancel"},
                )
            except Exception:
                pass
        self._pending_approvals.clear()
        self._terminal_items.clear()
        self._started = False
        await self.client.close()

    def thread_for(self, channel_id: str, conversation_id: str) -> str | None:
        return self._thread_by_conversation.get((channel_id, conversation_id))

    async def handle_inbound(self, inbound: InboundMessage) -> None:
        if inbound.input_error:
            await self._send_to_conversation(
                self._key(inbound),
                message_type="error",
                text=f"Input could not be prepared: {inbound.input_error}",
                delivery_id=self._inbound_delivery_id(inbound, "input-error"),
            )
            return

        command, _, argument = inbound.text.strip().partition(" ")
        command = command.casefold()
        if command in {"/approve", "/deny", "/cancel"}:
            await self._answer_approval(inbound, command=command, handle=argument.strip())
            return
        if command == "/new":
            await self._new_thread(inbound)
            return
        if command == "/help":
            await self._send_to_conversation(
                self._key(inbound),
                message_type="status",
                text="IMZen commands: /new, /approve [id], /deny [id], /cancel [id], /help",
                delivery_id=self._inbound_delivery_id(inbound, "help"),
            )
            return

        input_items = self._input_items(inbound)
        key = self._key(inbound)
        thread_id = self._thread_by_conversation.get(key)
        if thread_id is None:
            result = await self.client.start_thread(cwd=self.default_cwd)
            thread_id = _thread_id(result)
            self._bind(key, thread_id)
        await self.client.start_turn(thread_id, input_items=input_items)

    async def handle_notification(self, notification: dict) -> None:
        method = str(notification.get("method") or "")
        params = notification.get("params")
        if not isinstance(params, dict):
            return
        if method == "item/completed":
            await self._handle_completed_item(params)
        elif method == "turn/completed":
            await self._handle_completed_turn(params)
        elif method == "error":
            await self._handle_error(params)
        elif method == "serverRequest/resolved":
            request_id = params.get("requestId")
            if request_id is not None:
                self._pending_approvals.pop(str(request_id), None)

    async def handle_server_request(self, request: dict) -> None:
        method = str(request.get("method") or "")
        transport_request_id = request.get("id")
        if transport_request_id is None:
            return
        if method not in {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        }:
            await self._reply_unsupported(transport_request_id, method)
            return
        params = request.get("params")
        if not isinstance(params, dict):
            await self._reply_unsupported(transport_request_id, method)
            return
        thread_id = str(params.get("threadId") or "")
        conversation = self._conversation_by_thread.get(thread_id)
        if conversation is None:
            await self._reply_unsupported(transport_request_id, method)
            return
        handle = str(transport_request_id)
        self._pending_approvals[handle] = _PendingApproval(
            transport_request_id=transport_request_id,
            conversation=conversation,
        )
        await self._send_to_conversation(
            conversation,
            message_type="approval_request",
            text=_render_approval(handle, params),
            request_id=handle,
            delivery_id=f"imzen:approval:{thread_id}:{handle}",
        )

    async def _new_thread(self, inbound: InboundMessage) -> None:
        key = self._key(inbound)
        pending_handles = [
            (handle, pending)
            for handle, pending in self._pending_approvals.items()
            if pending.conversation == key
        ]
        for _handle, pending in pending_handles:
            await self.client.reply_to_transport_request(
                pending.transport_request_id,
                {"decision": "cancel"},
            )
        old_thread_id = self._thread_by_conversation.pop(key, None)
        if old_thread_id is not None:
            self._conversation_by_thread.pop(old_thread_id, None)
        for handle, _pending in pending_handles:
            self._pending_approvals.pop(handle, None)
        await self._send_to_conversation(
            key,
            message_type="status",
            text="The next message will start a new Zen thread.",
            delivery_id=self._inbound_delivery_id(inbound, "new"),
        )

    async def _answer_approval(
        self,
        inbound: InboundMessage,
        *,
        command: str,
        handle: str,
    ) -> None:
        key = self._key(inbound)
        if not handle:
            candidates = [
                candidate
                for candidate, pending in self._pending_approvals.items()
                if pending.conversation == key
            ]
            if len(candidates) == 1:
                handle = candidates[0]
        pending = self._pending_approvals.get(handle)
        if pending is None or pending.conversation != key:
            await self._send_to_conversation(
                key,
                message_type="error",
                text="No matching approval request is pending.",
                delivery_id=self._inbound_delivery_id(inbound, "approval-missing"),
            )
            return
        decision = {
            "/approve": "accept",
            "/deny": "decline",
            "/cancel": "cancel",
        }[command]
        await self.client.reply_to_transport_request(
            pending.transport_request_id,
            {"decision": decision},
        )
        self._pending_approvals.pop(handle, None)
        await self._send_to_conversation(
            key,
            message_type="status",
            text=f"Approval {handle}: {decision}.",
            delivery_id=self._inbound_delivery_id(inbound, f"approval-{decision}"),
        )

    async def _handle_completed_item(self, params: dict) -> None:
        item = params.get("item")
        if not isinstance(item, dict):
            return
        thread_id = str(params.get("threadId") or item.get("threadId") or "")
        turn_id = str(params.get("turnId") or item.get("turnId") or "")
        conversation = self._conversation_by_thread.get(thread_id)
        if conversation is None:
            return
        item_type = str(item.get("type") or "")
        normalized = item_type.replace("_", "").casefold()
        item_id = str(item.get("id") or "unknown")
        if normalized == "agentmessage":
            text = _item_text(item)
            if text:
                await self._send_to_conversation(
                    conversation,
                    message_type="agent_message",
                    text=text,
                    delivery_id=f"imzen:item:{thread_id}:{item_id}",
                )
            return
        if normalized == "failure":
            self._terminal_items.add((thread_id, turn_id))
            await self._send_to_conversation(
                conversation,
                message_type="error",
                text=str(item.get("message") or "The Zen turn failed."),
                delivery_id=f"imzen:item:{thread_id}:{item_id}",
            )
        elif normalized == "interruption":
            self._terminal_items.add((thread_id, turn_id))
            await self._send_to_conversation(
                conversation,
                message_type="status",
                text=str(item.get("reason") or "The Zen turn was interrupted."),
                delivery_id=f"imzen:item:{thread_id}:{item_id}",
            )

    async def _handle_completed_turn(self, params: dict) -> None:
        turn = params.get("turn")
        turn_payload = turn if isinstance(turn, dict) else {}
        thread_id = str(params.get("threadId") or turn_payload.get("threadId") or "")
        turn_id = str(
            params.get("turnId") or turn_payload.get("id") or turn_payload.get("turnId") or ""
        )
        status = str(params.get("status") or turn_payload.get("status") or "").casefold()
        key = (thread_id, turn_id)
        conversation = self._conversation_by_thread.get(thread_id)
        already_projected = key in self._terminal_items
        self._terminal_items.discard(key)
        if conversation is None or already_projected or status not in {"failed", "interrupted"}:
            return
        await self._send_to_conversation(
            conversation,
            message_type="error" if status == "failed" else "status",
            text=f"The Zen turn {status}.",
            delivery_id=f"imzen:turn:{thread_id}:{turn_id}:{status}",
        )

    async def _handle_error(self, params: dict) -> None:
        thread_id = str(params.get("threadId") or "")
        turn_id = str(params.get("turnId") or "")
        conversation = self._conversation_by_thread.get(thread_id)
        if conversation is None or not turn_id:
            return
        key = (thread_id, turn_id)
        if key in self._terminal_items:
            return
        error = params.get("error")
        message = str(error.get("message") or "") if isinstance(error, dict) else str(error or "")
        self._terminal_items.add(key)
        await self._send_to_conversation(
            conversation,
            message_type="error",
            text=message or "The Zen turn failed.",
            delivery_id=f"imzen:error:{thread_id}:{turn_id}",
        )

    async def _reply_unsupported(self, request_id: str | int, method: str) -> None:
        reply_error = getattr(self.client, "reply_error_to_transport_request", None)
        if callable(reply_error):
            await reply_error(
                request_id,
                code=-32601,
                message=f"IMZen does not support server request {method or '<unknown>'}",
            )
            return
        await self.client.reply_to_transport_request(
            request_id,
            {"decision": "cancel"},
        )

    async def _send_to_conversation(
        self,
        conversation: ConversationKey,
        *,
        message_type: str,
        text: str,
        delivery_id: str,
        request_id: str | None = None,
    ) -> None:
        await self.deliver(
            OutboundMessage(
                channel_id=conversation[0],
                conversation_id=conversation[1],
                message_type=message_type,
                text=text,
                request_id=request_id,
                metadata={"delivery_id": delivery_id},
            )
        )

    def _bind(self, conversation: ConversationKey, thread_id: str) -> None:
        previous = self._thread_by_conversation.get(conversation)
        if previous is not None and previous != thread_id:
            self._conversation_by_thread.pop(previous, None)
        previous_conversation = self._conversation_by_thread.get(thread_id)
        if previous_conversation is not None and previous_conversation != conversation:
            self._thread_by_conversation.pop(previous_conversation, None)
        self._thread_by_conversation[conversation] = thread_id
        self._conversation_by_thread[thread_id] = conversation

    @staticmethod
    def _key(inbound: InboundMessage) -> ConversationKey:
        return inbound.channel_id, inbound.conversation_id

    @staticmethod
    def _inbound_delivery_id(inbound: InboundMessage, suffix: str) -> str:
        return (
            f"imzen:inbound:{inbound.channel_id}:{inbound.conversation_id}:"
            f"{inbound.message_id}:{suffix}"
        )

    @staticmethod
    def _input_items(inbound: InboundMessage) -> list[dict[str, str]]:
        text = inbound.text.strip()
        file_lines: list[str] = []
        for attachment in inbound.attachments:
            if attachment.kind == "file":
                filename = attachment.filename or Path(attachment.local_path).name or "attachment"
                file_lines.append(f"- {filename}: {attachment.local_path}")
        if file_lines:
            manifest = "[Attachments]\n" + "\n".join(file_lines)
            text = f"{text}\n\n{manifest}".strip()
        if not text and inbound.attachments:
            text = "[Image]"
        items: list[dict[str, str]] = []
        if text:
            items.append({"type": "text", "text": text})
        for attachment in inbound.attachments:
            if attachment.kind == "image":
                items.append({"type": "localImage", "path": attachment.local_path})
        if not items:
            raise ValueError("message text and attachments are empty")
        return items


def _thread_id(result: dict) -> str:
    thread = result.get("thread")
    if isinstance(thread, dict):
        value = thread.get("id") or thread.get("threadId")
        if value:
            return str(value)
    value = result.get("threadId")
    if value:
        return str(value)
    raise RuntimeError("thread/start did not return a thread id")


def _item_text(item: dict) -> str:
    text = item.get("text")
    if isinstance(text, str):
        return text
    content = item.get("content")
    if not isinstance(content, list):
        return ""
    return "".join(
        str(part.get("text") or "")
        for part in content
        if isinstance(part, dict) and part.get("type") in {None, "text", "outputText"}
    )


def _render_approval(handle: str, params: dict) -> str:
    item = params.get("item")
    item_payload = item if isinstance(item, dict) else {}
    command = params.get("command") or item_payload.get("command") or ""
    if isinstance(command, list):
        command = " ".join(str(part) for part in command)
    cwd = str(params.get("cwd") or item_payload.get("cwd") or "")
    lines = [f"Approval required [{handle}]."]
    if command:
        lines.append(f"Command: {command}")
    if cwd:
        lines.append(f"Working directory: {cwd}")
    lines.append(f"Reply /approve {handle}, /deny {handle}, or /cancel {handle}.")
    return "\n".join(lines)
