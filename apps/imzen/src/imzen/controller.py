from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path

from imagent import Failed, OutcomeUnknown, Partial, Succeeded
from imagent.applications import ZenApplicationAdapter
from imagent.applications.adapters.appserver.client import AppServerClient, AppServerError
from imagent.applications.requests import ApprovalRequest, ApprovalResponse, RequestRef
from imagent.gateway import ConversationActions
from imagent.gateway.input import InboundFailurePhase
from imagent.interaction.controllers import (
    CommandArgumentContract,
    CommandDefinition,
    CommandExecutionSafety,
    CommandInvocation,
    CommandRegistry,
    CommandResult,
    MarkdownRequestPresenter,
    RequestPresentation,
    include_common_commands,
)
from imagent.interaction.media import AttachmentContent, LocalPath
from imagent.interaction.messages import (
    Content,
    InboundMessage,
    OutboundMessage,
    TextContent,
    TextFormat,
)

from .config import PermissionMode


def thread_start_options(mode: PermissionMode) -> dict[str, object]:
    """Return the Zen-native profile owned by the IMZen product."""

    return {
        "sandbox": "danger-full-access",
        "approval_policy": "never" if mode == "full-access" else "on-request",
    }


def adapt_inbound_content(message: InboundMessage) -> tuple[Content, ...]:
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


class ImZenContentTransformer:
    """Replay-safe typed projection from staged IM content to Zen input."""

    async def transform_content(self, message: InboundMessage) -> tuple[Content, ...]:
        return adapt_inbound_content(message)


class ImZenController:
    """Compose IMZen commands and presets over SDK v1 scoped actions."""

    _COMMON_COMMANDS = (
        "apps",
        "app",
        "projects",
        "use",
        "threads",
        "pick",
        "delete",
        "catchup",
        "history",
        "respond",
        "answer",
    )

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
        self._permission_by_conversation: dict[object, PermissionMode] = {}
        self._commands = CommandRegistry()
        include_common_commands(self._commands, names=self._COMMON_COMMANDS)
        self._register_product_commands()
        self._commands.freeze()

    def validate_startup(self) -> None:
        self._commands.validate_startup()

    async def close(self) -> None:
        await self._commands.close()

    async def handle(
        self,
        message: InboundMessage,
        actions: ConversationActions,
    ) -> tuple[OutboundMessage, ...] | None:
        command_name = _first_command_name(message)
        if command_name is not None:
            await self._prepare_command_scope(message, actions, command_name)
        else:
            await self._ensure_thread(message, actions)
            return None
        return await self._commands.handle(message, actions)

    def _register_product_commands(self) -> None:
        self._commands.register(
            self._command_definition(
                "help",
                aliases=("start",),
                maximum=0,
                summary="Show IMZen commands.",
                usage="/help",
                handler=self._help,
            )
        )
        self._commands.register(
            self._command_definition(
                "new",
                maximum=0,
                summary="Clear the selected Zen Thread.",
                usage="/new",
                safety=CommandExecutionSafety.EFFECTFUL,
                handler=self._new,
            )
        )
        self._commands.register(
            self._command_definition(
                "permission",
                maximum=1,
                summary="Choose the next Zen Thread permission preset.",
                usage="/permission [full-access|approval-required]",
                safety=CommandExecutionSafety.EFFECTFUL,
                handler=self._permission,
            )
        )
        self._commands.register(
            self._command_definition(
                "model",
                maximum=32,
                summary="List or switch Zen models.",
                usage="/model [name]",
                safety=CommandExecutionSafety.EFFECTFUL,
                handler=self._model,
            )
        )
        self._commands.register(
            self._command_definition(
                "status",
                maximum=0,
                summary="Read the selected Zen Thread.",
                usage="/status",
                handler=self._status,
            )
        )
        for name, choice in (
            ("approve", "accept"),
            ("deny", "decline"),
            ("cancel", "cancel"),
        ):
            self._commands.register(
                self._command_definition(
                    name,
                    minimum=1,
                    maximum=1,
                    summary=f"{name.title()} a Zen command approval.",
                    usage=f"/{name} <request-id>",
                    safety=CommandExecutionSafety.EFFECTFUL,
                    handler=self._approval_handler(choice),
                )
            )

    @staticmethod
    def _command_definition(
        name: str,
        *,
        handler,
        aliases: tuple[str, ...] = (),
        minimum: int = 0,
        maximum: int,
        summary: str,
        usage: str,
        safety: CommandExecutionSafety = CommandExecutionSafety.READ_ONLY,
    ) -> CommandDefinition:
        return CommandDefinition(
            name=name,
            handler=handler,
            aliases=aliases,
            arguments=CommandArgumentContract(minimum, maximum),
            summary=summary,
            usage=usage,
            safety=safety,
        )

    async def _help(
        self,
        _invocation: CommandInvocation,
        _actions: ConversationActions,
    ) -> CommandResult:
        return CommandResult.text(
            "\n".join(
                (
                    self._commands_help(),
                    "- `/model [name]` — list or switch Zen models",
                    "- `/permission [full-access|approval-required]` — choose the next "
                    "Thread preset",
                    "- `/approve|/deny|/cancel <request-id>` — approval response shortcuts",
                )
            )
        )

    async def _new(
        self,
        invocation: CommandInvocation,
        actions: ConversationActions,
    ) -> CommandResult:
        try:
            binding = await actions.get_binding()
            if binding is not None and binding.thread_ref is not None:
                _require_action(
                    await actions.clear_thread(
                        action_id=_action_id(invocation, "conversation.clear_thread"),
                        expected_generation=binding.generation,
                    )
                )
            return CommandResult.text("The next message will start a new Zen thread.")
        except Exception as error:
            return CommandResult.failure(str(error))

    async def _permission(
        self,
        invocation: CommandInvocation,
        actions: ConversationActions,
    ) -> CommandResult:
        current = self._permission_by_conversation.get(
            invocation.conversation_ref,
            self._default_permission_mode,
        )
        if not invocation.arguments:
            return CommandResult.text(
                f"Permission mode: {current}. Use /permission full-access or "
                "/permission approval-required."
            )
        mode_text = invocation.arguments[0]
        if mode_text not in {"full-access", "approval-required"}:
            return CommandResult.failure(
                "Permission mode must be full-access or approval-required."
            )
        mode: PermissionMode = mode_text  # type: ignore[assignment]
        try:
            if mode != current:
                binding = await actions.get_binding()
                if binding is not None and binding.thread_ref is not None:
                    _require_action(
                        await actions.clear_thread(
                            action_id=_action_id(invocation, "conversation.clear_thread"),
                            expected_generation=binding.generation,
                        )
                    )
                self._permission_by_conversation[invocation.conversation_ref] = mode
            behavior = (
                "Commands run without approval prompts."
                if mode == "full-access"
                else "Commands require approval."
            )
            return CommandResult.text(
                f"Permission mode: {mode}. {behavior} The next message will start a new Zen thread."
            )
        except Exception as error:
            return CommandResult.failure(str(error))

    async def _model(
        self,
        invocation: CommandInvocation,
        actions: ConversationActions,
    ) -> CommandResult:
        model = " ".join(invocation.arguments)
        try:
            if not invocation.arguments:
                return CommandResult.text(await self._model_catalog_markdown())
            binding = await actions.get_binding()
            if binding is None or binding.thread_ref is None:
                raise RuntimeError(
                    "No Zen thread is selected. Send a message or use `/threads` and `/pick`."
                )
            await self._client.call(
                "thread/settings/update",
                {"threadId": binding.thread_ref.thread_id, "model": model},
            )
            return CommandResult.text(f"Model switched to **{model}** for subsequent turns.")
        except Exception as error:
            if _zen_error_code(error) == "model_unavailable":
                try:
                    detail = (
                        f"Could not switch model to **{model}**: {error}\n\n"
                        f"{await self._model_catalog_markdown()}"
                    )
                except Exception:
                    detail = (
                        f"Could not switch model to **{model}**: {error}\n\n"
                        "Use `/model` to list available models."
                    )
                return CommandResult.failure(detail)
            if invocation.arguments:
                return CommandResult.failure(
                    "Model update did not complete cleanly; Zen may already have applied it. "
                    "Retrying the same model is safe."
                )
            return CommandResult.failure(str(error))

    async def _status(
        self,
        invocation: CommandInvocation,
        actions: ConversationActions,
    ) -> CommandResult:
        try:
            binding = await actions.get_binding()
            if binding is None or binding.thread_ref is None:
                return CommandResult.text(
                    "No Zen thread is selected. Send a message or use `/threads` and `/pick`."
                )
            thread = _require_read(await actions.get_thread(binding.thread_ref))
            preview = str(thread.metadata.get("preview") or thread.title or "(empty thread)")
            workspace = str(thread.metadata.get("cwd") or "")
            return CommandResult.text(
                "## Zen thread\n"
                f"- Status: **{thread.status.value}**\n"
                f"- Preview: {preview}\n"
                f"- ID: `{thread.ref.thread_id}`\n"
                f"- Workspace: `{workspace}`"
            )
        except Exception as error:
            return CommandResult.failure(str(error))

    def _approval_handler(self, choice_id: str):
        async def handle(
            invocation: CommandInvocation,
            actions: ConversationActions,
        ) -> CommandResult:
            try:
                request_ref = RequestRef(
                    application_ref=self._application.summary.ref,
                    native_request_id=invocation.arguments[0],
                )
                _require_action(
                    await actions.respond_request(
                        request_ref,
                        ApprovalResponse(choice_id),
                        action_id=_action_id(invocation, "conversation.respond_request"),
                    )
                )
                return CommandResult.text(f"Approval {invocation.arguments[0]}: {choice_id}.")
            except Exception as error:
                return CommandResult.failure(str(error))

        return handle

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

    async def _prepare_command_scope(
        self,
        message: InboundMessage,
        actions: ConversationActions,
        command_name: str,
    ) -> None:
        no_scope = {
            "help",
            "start",
            "apps",
            "app",
            "permission",
            "model",
            "new",
            "approve",
            "deny",
            "cancel",
        }
        if command_name in no_scope:
            if command_name in {"model", "approve", "deny", "cancel"}:
                await self._ensure_application(message, actions)
            return
        await self._ensure_application(message, actions)
        if command_name not in {"projects", "respond", "answer"}:
            await self._ensure_project(message, actions)

    async def _ensure_application(
        self,
        message: InboundMessage,
        actions: ConversationActions,
    ) -> object:
        binding = await actions.get_binding()
        application_ref = self._application.summary.ref
        if binding is not None and binding.application_ref == application_ref:
            return binding
        if binding is not None and binding.application_ref is not None:
            raise RuntimeError("The selected Agent application is not Zen.")
        result = await actions.select_application(
            application_ref,
            action_id=_operation_id(message, "application.select"),
            expected_generation=binding.generation if binding is not None else None,
        )
        _require_action(result)
        return await actions.get_binding()

    async def _ensure_project(
        self,
        message: InboundMessage,
        actions: ConversationActions,
    ) -> object:
        binding = await self._ensure_application(message, actions)
        if binding is not None and binding.project_ref is not None:
            return binding
        page = _require_read(await actions.list_projects(self._application.summary.ref))
        if len(page.items) != 1:
            raise RuntimeError("Zen must expose exactly one configured workspace project.")
        current = await actions.get_binding()
        result = await actions.select_project(
            page.items[0].ref,
            action_id=_operation_id(message, "conversation.select_project"),
            expected_generation=current.generation if current is not None else None,
        )
        _require_action(result)
        return await actions.get_binding()

    async def _ensure_thread(
        self,
        message: InboundMessage,
        actions: ConversationActions,
    ) -> object:
        binding = await self._ensure_project(message, actions)
        if binding is not None and binding.thread_ref is not None:
            return binding
        mode = self._permission_by_conversation.get(
            message.conversation_ref,
            self._default_permission_mode,
        )
        thread = await self._application.create_thread_with_options(
            thread_start_options=thread_start_options(mode)
        )
        current = await actions.get_binding()
        if current is None or current.project_ref is None:
            raise RuntimeError("Zen workspace selection was lost before Thread binding.")
        result = await actions.bind_thread(
            thread.ref,
            action_id=_operation_id(message, "conversation.bind_thread"),
            expected_generation=current.generation,
        )
        return _require_action(result)

    def _commands_help(self) -> str:
        return (
            "## IMZen commands\n"
            "- `/threads [query]` and `/pick <number|id|query>` — select a Zen Thread\n"
            "- `/status`, `/catchup [messages]`, `/history [turns] [--page N]` — read Zen\n"
            "- `/new` — clear this Conversation's binding\n"
            "- `/delete` — explicit unsupported Thread deletion check\n"
            "- `/respond` and `/answer` — use SDK request actions"
        )


class ImZenRequestPresenter(MarkdownRequestPresenter):
    """Keep SDK request safety while exposing IMZen approval aliases."""

    def present_request(
        self,
        request,
        *,
        conversation_ref,
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
        aliases = [
            f"`/{command} {handle}`"
            for choice, command in (
                ("accept", "approve"),
                ("decline", "deny"),
                ("cancel", "cancel"),
            )
            if choice in choices
        ]
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

    async def present_failure(
        self,
        phase: InboundFailurePhase,
        *,
        conversation_ref,
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
            content=(TextContent(f"**Error:** {prefix}.", TextFormat.MARKDOWN),),
            created_at=datetime.now(UTC),
            reply_to=reply_to_message_id,
        )


def _first_command_name(message: InboundMessage) -> str | None:
    for part in message.content:
        if not isinstance(part, TextContent):
            continue
        for line in part.text.splitlines():
            candidate = line.strip()
            if candidate:
                if not candidate.startswith("/"):
                    return None
                return candidate[1:].split(maxsplit=1)[0].casefold()
    return None


def _operation_id(message: InboundMessage, operation: str) -> str:
    return (
        f"imzen:operation:{message.conversation_ref.native_conversation_id}:"
        f"{message.message_id}:{operation}"
    )


def _action_id(invocation: CommandInvocation, operation: str) -> str:
    return f"imzen:command:{invocation.invocation_id}:{operation}"


def _require_action(result):
    if isinstance(result, Succeeded):
        return result.value
    if isinstance(result, Partial):
        raise RuntimeError(f"Action completed only partially: {result.error}")
    if isinstance(result, OutcomeUnknown):
        raise RuntimeError(f"Action outcome is unknown: {result.error}")
    if isinstance(result, Failed):
        raise RuntimeError(str(result.error))
    raise RuntimeError("Action returned an incompatible result.")


def _require_read(result):
    if isinstance(result, Succeeded):
        return result.value
    if isinstance(result, Failed):
        raise RuntimeError(str(result.error))
    raise RuntimeError("Read returned an incompatible result.")


def _zen_error_code(error: Exception) -> str | None:
    if not isinstance(error, AppServerError) or not isinstance(error.data, dict):
        return None
    code = error.data.get("zenCode")
    return code if isinstance(code, str) else None


__all__ = [
    "ImZenContentTransformer",
    "ImZenController",
    "ImZenFailurePresenter",
    "ImZenRequestPresenter",
    "adapt_inbound_content",
    "thread_start_options",
]
