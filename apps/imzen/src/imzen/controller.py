from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path

from imagent.applications import ZenApplicationAdapter
from imagent.applications.appserver_client import AppServerClient, AppServerError
from imagent.contracts import (
    ApplicationOperationFailed,
    ApprovalRequest,
    ApprovalResponse,
    AttachmentContent,
    BindConversationToThread,
    ClearConversationThread,
    ConversationBinding,
    ConversationBound,
    ConversationRef,
    GatewayOperationFailed,
    GetThread,
    InboundMessage,
    LocalPath,
    OutboundMessage,
    RequestRef,
    RequestResponseRouted,
    RespondToRequest,
    SelectApplication,
    TextContent,
    TextFormat,
    ThreadRead,
)
from imagent.controllers import (
    ControllerActions,
    InboundFailurePhase,
    MarkdownRequestPresenter,
    RequestPresentation,
    SlashController,
)
from imagent.controllers.markdown import MarkdownSlashPresenter
from imagent.controllers.slash import SlashCommand, parse_slash_command

from .config import PermissionMode


def thread_start_options(mode: PermissionMode) -> dict[str, object]:
    return {
        "sandbox": "danger-full-access",
        "approval_policy": "never" if mode == "full-access" else "on-request",
    }


def adapt_inbound_content(message: InboundMessage):
    """Preserve images and encode generic staged files as Zen-readable text."""
    text = "\n".join(part.text for part in message.content if isinstance(part, TextContent)).strip()
    images: list[AttachmentContent] = []
    file_lines: list[str] = []
    for part in message.content:
        if not isinstance(part, AttachmentContent):
            continue
        if part.media_type.casefold().startswith("image/"):
            images.append(part)
            continue
        if not isinstance(part.source, LocalPath):
            raise ValueError("Zen generic files require a staged local path")
        filename = part.filename or Path(part.source.path).name or "attachment"
        file_lines.append(f"- {filename}: {part.source.path}")
    if file_lines:
        manifest = "[Attachments]\n" + "\n".join(file_lines)
        text = f"{text}\n\n{manifest}".strip()
    content = ((TextContent(text),) if text else ()) + tuple(images)
    if not content:
        raise ValueError("message text and attachments are empty")
    return content


class ImZenController:
    """Compose IMZen-only commands and presets over SDK typed operations."""

    def __init__(
        self,
        *,
        application: ZenApplicationAdapter,
        client: AppServerClient,
        default_permission_mode: PermissionMode = "full-access",
    ) -> None:
        self._application = application
        self._client = client
        self._default_permission_mode = default_permission_mode
        self._permission_by_conversation: dict[ConversationRef, PermissionMode] = {}
        self._slash = SlashController()
        self._presenter = MarkdownSlashPresenter()

    async def handle(
        self,
        message: InboundMessage,
        actions: ControllerActions,
    ) -> tuple[OutboundMessage, ...] | None:
        try:
            command = parse_slash_command(message)
            if command is None:
                await self._ensure_thread(message, actions)
                return None
            if command.name == "new":
                text = await self._clear_thread(message, actions)
            elif command.name == "permission":
                text = await self._permission(message, command, actions)
            elif command.name == "model":
                text = await self._model(message, command, actions)
            elif command.name == "status":
                text = await self._status(message, actions)
            elif command.name in {"approve", "deny", "cancel"}:
                text = await self._approval(message, command, actions)
            elif command.name in {"help", "start"}:
                text = self._help()
            else:
                return await self._slash.handle(message, actions)
            return (self._presenter.response(message, text),)
        except Exception as error:
            return (self._presenter.response(message, str(error), error=True),)

    async def _ensure_thread(
        self,
        message: InboundMessage,
        actions: ControllerActions,
    ) -> ConversationBinding:
        binding = await actions.get_binding(message.conversation_ref)
        if binding is None or binding.application_ref is None:
            selected = await actions.execute_gateway(
                SelectApplication(
                    operation_id=_operation_id(message, "application.select"),
                    conversation_ref=message.conversation_ref,
                    actor=message.sender,
                    application_ref=self._application.summary.ref,
                    expected_revision=binding.revision if binding is not None else None,
                    created_at=message.created_at,
                )
            )
            binding = _require_binding(selected)
        elif binding.application_ref != self._application.summary.ref:
            raise RuntimeError("The selected Agent application is not Zen.")
        if binding.thread_ref is not None:
            return binding
        mode = self._permission_by_conversation.get(
            message.conversation_ref,
            self._default_permission_mode,
        )
        thread = await self._application.create_thread_with_options(
            thread_start_options=thread_start_options(mode)
        )
        bound = await actions.execute_gateway(
            BindConversationToThread(
                operation_id=_operation_id(message, "conversation.bind_thread"),
                conversation_ref=message.conversation_ref,
                actor=message.sender,
                thread_ref=thread.ref,
                expected_revision=binding.revision,
                created_at=message.created_at,
            )
        )
        return _require_binding(bound)

    async def _clear_thread(
        self,
        message: InboundMessage,
        actions: ControllerActions,
    ) -> str:
        binding = await actions.get_binding(message.conversation_ref)
        if binding is not None and binding.thread_ref is not None:
            result = await actions.execute_gateway(
                ClearConversationThread(
                    operation_id=_operation_id(message, "conversation.clear_thread"),
                    conversation_ref=message.conversation_ref,
                    actor=message.sender,
                    expected_revision=binding.revision,
                    created_at=message.created_at,
                )
            )
            _require_binding(result)
        return "The next message will start a new Zen thread."

    async def _permission(
        self,
        message: InboundMessage,
        command: SlashCommand,
        actions: ControllerActions,
    ) -> str:
        current = self._permission_by_conversation.get(
            message.conversation_ref,
            self._default_permission_mode,
        )
        if not command.arguments:
            return (
                f"Permission mode: {current}. "
                "Use /permission full-access or /permission approval-required."
            )
        if len(command.arguments) != 1 or command.arguments[0] not in {
            "full-access",
            "approval-required",
        }:
            raise ValueError("Permission mode must be full-access or approval-required.")
        mode: PermissionMode = command.arguments[0]  # type: ignore[assignment]
        if mode != current:
            await self._clear_thread(message, actions)
            self._permission_by_conversation[message.conversation_ref] = mode
        behavior = (
            "Commands run without approval prompts."
            if mode == "full-access"
            else "Commands require approval."
        )
        return f"Permission mode: {mode}. {behavior} The next message will start a new Zen thread."

    async def _model(
        self,
        message: InboundMessage,
        command: SlashCommand,
        actions: ControllerActions,
    ) -> str:
        if not command.arguments:
            return await self._model_catalog_markdown()
        model = " ".join(command.arguments)
        binding = await actions.get_binding(message.conversation_ref)
        if binding is None or binding.thread_ref is None:
            raise RuntimeError(
                "No Zen thread is selected. Send a message or use `/threads` and `/pick`."
            )
        try:
            await self._client.call(
                "thread/settings/update",
                {"threadId": binding.thread_ref.native_thread_id, "model": model},
            )
        except Exception as error:
            text = f"Could not switch model to **{model}**: {error}"
            if _zen_error_code(error) == "model_unavailable":
                try:
                    text = f"{text}\n\n{await self._model_catalog_markdown()}"
                except Exception:
                    text = f"{text}\n\nUse `/model` to list available models."
            raise RuntimeError(text) from error
        return f"Model switched to **{model}** for subsequent turns."

    async def _model_catalog_markdown(self) -> str:
        result = await self._client.list_models()
        data = result.get("data")
        if not isinstance(data, list):
            raise RuntimeError("model/list did not return a model list")
        models = [
            model
            for model in data
            if isinstance(model, Mapping)
            and isinstance(model.get("id"), str)
            and model["id"]
            and model.get("hidden") is not True
        ]
        lines = ["## Zen models"]
        for model in models:
            model_id = str(model["id"])
            display_name = str(model.get("displayName") or model_id)
            default = " — default" if model.get("isDefault") is True else ""
            lines.append(f"- **{display_name}** (`{model_id}`){default}")
        lines.append("Use `/model <name>` to switch the selected thread.")
        return "\n".join(lines)

    async def _status(
        self,
        message: InboundMessage,
        actions: ControllerActions,
    ) -> str:
        binding = await actions.get_binding(message.conversation_ref)
        if binding is None or binding.thread_ref is None:
            return "No Zen thread is selected. Send a message or use `/threads` and `/pick`."
        result = await actions.execute_application(
            GetThread(
                operation_id=_operation_id(message, "thread.get"),
                application_ref=self._application.summary.ref,
                thread_ref=binding.thread_ref,
                created_at=message.created_at,
            )
        )
        if isinstance(result, ApplicationOperationFailed):
            raise RuntimeError(result.error.message)
        if not isinstance(result, ThreadRead):
            raise RuntimeError("Thread read returned an incompatible result.")
        thread = result.thread
        preview = str(thread.metadata.get("preview") or thread.title or "(empty thread)")
        workspace = str(thread.metadata.get("cwd") or "")
        return (
            "## Zen thread\n"
            f"- Status: **{thread.status.value}**\n"
            f"- Preview: {preview}\n"
            f"- ID: `{thread.ref.native_thread_id}`\n"
            f"- Workspace: `{workspace}`"
        )

    async def _approval(
        self,
        message: InboundMessage,
        command: SlashCommand,
        actions: ControllerActions,
    ) -> str:
        if len(command.arguments) != 1:
            raise ValueError(f"Use /{command.name} <request-id>.")
        request_ref = RequestRef(
            application_ref=self._application.summary.ref,
            native_request_id=command.arguments[0],
        )
        choice_id = {
            "approve": "accept",
            "deny": "decline",
            "cancel": "cancel",
        }[command.name]
        result = await actions.execute_gateway(
            RespondToRequest(
                operation_id=_operation_id(message, "conversation.respond_request"),
                conversation_ref=message.conversation_ref,
                actor=message.sender,
                request_ref=request_ref,
                response=ApprovalResponse(choice_id),
                created_at=message.created_at,
            )
        )
        if isinstance(result, GatewayOperationFailed):
            raise RuntimeError(result.error.message)
        if not isinstance(result, RequestResponseRouted):
            raise RuntimeError("Approval response returned an incompatible result.")
        return f"Approval {command.arguments[0]}: {choice_id}."

    def _help(self) -> str:
        return (
            f"{self._presenter.help()}\n"
            "- `/model [name]` — list or switch Zen models\n"
            "- `/permission [full-access|approval-required]` — choose the next Thread preset\n"
            "- `/approve|/deny|/cancel <request-id>` — approval response shortcuts"
        )


class ImZenRequestPresenter(MarkdownRequestPresenter):
    """Keep SDK request safety while exposing IMZen approval aliases."""

    def present_request(
        self,
        request,
        *,
        conversation_ref: ConversationRef,
        delivery_id: str,
        reply_to_message_id: str | None,
    ) -> RequestPresentation:
        presented = super().present_request(
            request,
            conversation_ref=conversation_ref,
            delivery_id=delivery_id,
            reply_to_message_id=reply_to_message_id,
        )
        if not isinstance(request, ApprovalRequest):
            return presented
        content = presented.message.content[0]
        if not isinstance(content, TextContent):
            return presented
        choices = {choice.choice_id for choice in request.choices}
        handle = request.request_ref.native_request_id
        aliases = []
        for choice, command in (
            ("accept", "approve"),
            ("decline", "deny"),
            ("cancel", "cancel"),
        ):
            if choice in choices:
                aliases.append(f"`/{command} {handle}`")
        if not aliases:
            return presented
        body = f"{content.text}\n\nIMZen shortcuts: {', '.join(aliases)}."
        message = OutboundMessage(
            delivery_id=presented.message.delivery_id,
            conversation_ref=presented.message.conversation_ref,
            content=(TextContent(body, content.format),),
            created_at=presented.message.created_at,
            reply_to=presented.message.reply_to,
            metadata=presented.message.metadata,
        )
        return RequestPresentation(
            message=message,
            response_supported=presented.response_supported,
        )


class ImZenFailurePresenter:
    """Render terminal SDK inbound failures as explicit IMZen messages."""

    def present_failure(
        self,
        error: BaseException,
        *,
        phase: InboundFailurePhase,
        conversation_ref: ConversationRef,
        delivery_id: str,
        reply_to_message_id: str,
    ) -> OutboundMessage:
        if phase is InboundFailurePhase.OUTCOME_UNKNOWN:
            prefix = "Zen may have accepted this message, but its outcome is unknown"
        elif phase is InboundFailurePhase.POST_ACCEPTANCE:
            prefix = "Zen accepted this message, but IM projection failed"
        else:
            prefix = "Zen could not process this message"
        return OutboundMessage(
            delivery_id=delivery_id,
            conversation_ref=conversation_ref,
            content=(TextContent(f"**Error:** {prefix}: {error}", TextFormat.MARKDOWN),),
            created_at=datetime.now(UTC),
            reply_to=reply_to_message_id,
        )


def _require_binding(result) -> ConversationBinding:
    if isinstance(result, GatewayOperationFailed):
        raise RuntimeError(result.error.message)
    if not isinstance(result, ConversationBound):
        raise RuntimeError("Binding operation returned an incompatible result.")
    return result.binding


def _operation_id(message: InboundMessage, operation: str) -> str:
    return f"imzen:operation:{message.message_id}:{operation}"


def _zen_error_code(error: Exception) -> str | None:
    if not isinstance(error, AppServerError) or not isinstance(error.data, dict):
        return None
    code = error.data.get("zenCode")
    return code if isinstance(code, str) else None
