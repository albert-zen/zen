from __future__ import annotations

import re
import time
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from imagent import (
    CommandArgumentContract,
    CommandDefinition,
    CommandExecutionSafety,
    CommandLimits,
    CommandRegistry,
    CommandResult,
    ConversationActions,
    Failed,
    OutcomeUnknown,
    Partial,
    Succeeded,
    include_common_commands,
)
from imagent.applications import ProjectRef, ThreadRef
from imagent.applications.adapters.appserver.client import AppServerError
from imagent.applications.requests import ApprovalRequest, ApprovalResponse, RequestRef
from imagent.gateway.input import InboundFailurePhase
from imagent.interaction.controllers import (
    MarkdownRequestPresenter,
    RequestPresentation,
    resolve_command_name,
)
from imagent.interaction.controllers.common import SlashCommand, parse_slash_command
from imagent.interaction.controllers.common_presentation import MarkdownSlashPresenter
from imagent.interaction.media import AttachmentContent, LocalPath
from imagent.interaction.messages import (
    Content,
    ConversationRef,
    InboundMessage,
    OutboundMessage,
    TextContent,
    TextFormat,
)

from .config import PermissionMode

_COMMAND_NAMES = {
    name: name
    for name in (
        "model",
        "permission",
        "status",
        "new",
        "approve",
        "deny",
        "cancel",
        "help",
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
}
_COMMAND_NAMES.update({"start": "help", "project": "use", "thread": "pick", "archive": "delete"})


def _replace_command_name(message: InboundMessage, name: str) -> InboundMessage:
    for index, part in enumerate(message.content):
        if not isinstance(part, TextContent) or not part.text.strip():
            continue
        match = re.match(r"(\s*)/\S+", part.text)
        if match is None:
            return message
        content = list(message.content)
        content[index] = replace(part, text=match[1] + "/" + name + part.text[match.end() :])
        return replace(message, content=tuple(content))
    return message


def thread_start_options(mode: PermissionMode) -> dict[str, object]:
    return {
        "sandbox": "danger-full-access",
        "approval_policy": "never" if mode == "full-access" else "on-request",
    }


def adapt_inbound_content(message: InboundMessage) -> tuple[Content, ...]:
    """Preserve rooted image bytes and encode staged generic files for Zen."""
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
    async def transform_content(self, message: InboundMessage) -> tuple[Content, ...]:
        return adapt_inbound_content(message)


class ImZenXSlashPresenter(MarkdownSlashPresenter):
    def threads(self, threads) -> str:
        if not threads:
            return "No threads found."
        lines = ["## Threads", ""]
        lines.extend(
            f"{index}. **{thread.title or 'Untitled'}** — {thread.status.value}"
            for index, thread in enumerate(threads, 1)
        )
        lines.extend(
            ["", "Use `/pick <number>` from this list to select and receive replies here."]
        )
        return "\n".join(lines)


class ImZenController:
    """Product commands over scoped v1 actions and one frozen registry."""

    def __init__(
        self,
        *,
        application,
        client,
        default_permission_mode="full-access",
        subscription_commands=False,
        allow_unique_prefix=False,
    ):
        if type(allow_unique_prefix) is not bool:
            raise ValueError("allow_unique_prefix must be a Boolean")
        self._application = application
        self._client = client
        identity = application.summary.workspace_identity
        if identity is None:
            raise ValueError("Zen requires a configured workspace identity")
        self._project = ProjectRef(
            application.summary.ref.application_instance_id, identity.project_ref.project_id
        )
        self._default_permission_mode = default_permission_mode
        self._subscription_commands = subscription_commands
        self._allow_unique_prefix = allow_unique_prefix
        self._permission_by_conversation = {}
        self._views = OrderedDict()
        self._command_names = dict(_COMMAND_NAMES)
        if subscription_commands:
            self._command_names.update({"subscribe": "pick", "unsubscribe": "new"})
        self._presenter = (
            ImZenXSlashPresenter() if subscription_commands else MarkdownSlashPresenter()
        )
        self._command_limits = CommandLimits()
        self._registry = CommandRegistry(
            allow_unique_prefix=allow_unique_prefix, limits=self._command_limits
        )
        include_common_commands(
            self._registry,
            presenter=self._presenter,
            names=(
                "apps",
                "app",
                "projects",
                "use",
                "delete",
                "catchup",
                "history",
                "respond",
                "answer",
            ),
        )
        aliases = {"help": ("start",), "pick": ("thread",), "new": ()}
        if subscription_commands:
            aliases["pick"] += ("subscribe",)
            aliases["new"] = ("unsubscribe",)
        for name in (
            "help",
            "new",
            "threads",
            "pick",
            "model",
            "permission",
            "status",
            "approve",
            "deny",
            "cancel",
        ):
            self._registry.register(
                CommandDefinition(
                    name=name,
                    aliases=aliases.get(name, ()),
                    handler=self._command,
                    arguments=CommandArgumentContract(0, 32),
                    safety=CommandExecutionSafety.EFFECTFUL,
                )
            )
        self._registry.freeze()

    def validate_startup(self):
        self._registry.validate_startup()

    async def close(self):
        await self._registry.close()

    def register_command_names(self, names):
        self._command_names.update(names)

    def resolve_command_name(self, name):
        return resolve_command_name(
            name, self._command_names, allow_unique_prefix=self._allow_unique_prefix
        )

    def present_response(self, message, text):
        return self._presenter.response(message, text)

    async def clear_thread(self, message, actions):
        return await self._clear_thread(message, actions)

    async def handle(self, message, actions):
        try:
            command = parse_slash_command(message)
            if command is None:
                await self._ensure_thread(message, actions)
                return None
            candidates = self.resolve_command_name(command.name)
            if len(candidates) > 1:
                choices = ", ".join("/" + name for name in candidates)
                return (
                    self._presenter.response(
                        message,
                        f"Ambiguous command /{command.name}: {choices}. Use a longer name.",
                        error=True,
                    ),
                )
            if len(candidates) == 1 and command.name not in self._command_names:
                message = _replace_command_name(message, candidates[0])
            # The single-application product chooses its configured workspace.
            # Selection uses fenced actions even when the next command is read-only.
            await self._ensure_project(message, actions)
            return await self._registry.handle(message, actions)
        except Exception as error:
            return (self._presenter.response(message, str(error), error=True),)

    async def _command(self, invocation, actions):
        message = InboundMessage(
            message_id=invocation.message_id,
            conversation_ref=invocation.conversation_ref,
            sender=invocation.actor,
            content=(),
            created_at=invocation.created_at,
        )
        command = SlashCommand(
            invocation.command_name, invocation.arguments, "/" + invocation.command_name
        )
        try:
            name = command.name
            if name == "new":
                text = await self._clear_thread(message, actions)
            elif name == "permission":
                text = await self._permission(message, command, actions)
            elif name == "model":
                text = await self._model(message, command, actions)
            elif name == "status":
                text = await self._status(message, actions)
            elif name == "threads":
                text = await self._threads(message, command, actions)
            elif name == "pick":
                text = await self._pick(message, command, actions)
            elif name in {"approve", "deny", "cancel"}:
                text = await self._approval(message, command, actions)
            else:
                text = self._help()
            return CommandResult.text(text)
        except Exception as error:
            return CommandResult.failure(str(error))

    async def _ensure_project(self, message, actions):
        binding = await actions.get_binding()
        if binding is not None and binding.application_ref not in (
            None,
            self._application.summary.ref,
        ):
            raise RuntimeError("The selected Agent application is not Zen.")
        if binding is None or binding.project_ref is None:
            _require_success(
                await actions.select_project(
                    self._project,
                    action_id=_operation_id(message, "project.select"),
                    expected_generation=binding.generation if binding else None,
                )
            )
            binding = await actions.get_binding()
        if binding is None or binding.project_ref != self._project:
            raise RuntimeError("The selected Zen workspace is not the configured workspace.")
        return binding

    async def _ensure_thread(self, message, actions):
        binding = await self._ensure_project(message, actions)
        if binding.thread_ref is not None:
            return binding
        mode = self._permission_by_conversation.get(
            message.conversation_ref, self._default_permission_mode
        )
        _require_success(
            await actions.create_and_bind_thread(
                self._project,
                action_id=_operation_id(message, "thread.create"),
                creation_profile=mode,
            )
        )
        binding = await actions.get_binding()
        if binding is None or binding.thread_ref is None:
            raise RuntimeError("Zen Thread creation did not produce a binding.")
        return binding

    async def _clear_thread(self, message, actions):
        binding = await actions.get_binding()
        if binding is not None and binding.thread_ref is not None:
            _require_success(
                await actions.clear_thread(
                    action_id=_operation_id(message, "thread.clear"),
                    expected_generation=binding.generation,
                )
            )
        self._views.pop(message.conversation_ref, None)
        return "The next message will start a new Zen thread."

    async def _permission(self, message, command, actions):
        current = self._permission_by_conversation.get(
            message.conversation_ref, self._default_permission_mode
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
        mode = command.arguments[0]
        if mode != current:
            await self._clear_thread(message, actions)
            self._permission_by_conversation[message.conversation_ref] = mode
        behavior = (
            "Commands run without approval prompts."
            if mode == "full-access"
            else "Commands require approval."
        )
        return f"Permission mode: {mode}. {behavior} The next message will start a new Zen thread."

    async def _threads(self, message, command, actions):
        page = _require_success(
            await actions.list_threads(self._project, query=" ".join(command.arguments) or None)
        )
        if page.next_cursor is not None:
            raise RuntimeError("Zen returned an incomplete Thread list; refresh before selecting.")
        text = self._presenter.threads(page.items)
        if len(text) > self._command_limits.max_result_text_characters:
            raise ValueError(
                "Thread list is too long. Use /threads <query> to narrow it; "
                "the previously displayed numbers are unchanged."
            )
        self._views[message.conversation_ref] = (time.monotonic(), page.items)
        self._views.move_to_end(message.conversation_ref)
        while len(self._views) > 128:
            self._views.popitem(last=False)
        return text

    async def _pick(self, message, command, actions):
        selector = " ".join(command.arguments)
        if not selector:
            raise ValueError("Use /threads first, then /pick <number or id>.")
        view = self._views.get(message.conversation_ref)
        threads = view[1] if view and time.monotonic() - view[0] < 900 else None
        if selector.isdigit():
            if threads is None:
                raise ValueError("Use /threads first, then /pick <number> from the displayed list.")
            if not 1 <= int(selector) <= len(threads):
                raise ValueError("Invalid thread number. Use /threads to refresh the list.")
            selected = threads[int(selector) - 1]
        else:
            selected = _match_thread_selector(threads or (), selector)
            if selected is None:
                # An exact native ID remains usable even when the bounded list
                # is too large. A failed read is not a binding or input effect.
                exact = await actions.get_thread(ThreadRef(self._project, selector))
                if isinstance(exact, Succeeded):
                    selected = exact.value
                else:
                    page = _require_success(
                        await actions.list_threads(self._project, query=selector)
                    )
                    if page.next_cursor is not None:
                        raise ValueError("Thread search is incomplete; narrow the query.")
                    selected = _match_thread_selector(page.items, selector)
                    if selected is None:
                        raise ValueError("No Thread matches that ID or query.")
            # Search lookup never replaces the conversation's displayed numbers.
        binding = await self._ensure_project(message, actions)
        _require_success(
            await actions.bind_thread(
                selected.ref,
                action_id=_operation_id(message, "thread.pick:" + selected.ref.thread_id),
                expected_generation=binding.generation,
            )
        )
        return (
            f"Selected thread **{selected.title or 'Untitled'}**. "
            "Its replies will arrive here, including desktop replies."
        )

    async def _model(
        self,
        message: InboundMessage,
        command: SlashCommand,
        actions: ConversationActions,
    ) -> str:
        if not command.arguments:
            return await self._model_catalog_markdown()
        model = " ".join(command.arguments)
        binding = await actions.get_binding()
        if binding is None or binding.thread_ref is None:
            raise RuntimeError(
                "No Zen thread is selected. Send a message or use `/threads` and `/pick`."
            )
        try:
            await self._client.call(
                "thread/settings/update",
                {"threadId": binding.thread_ref.thread_id, "model": model},
            )
        except Exception as error:
            if _zen_error_code(error) == "model_unavailable":
                text = f"Could not switch model to **{model}**: {error}"
                try:
                    text = f"{text}\n\n{await self._model_catalog_markdown()}"
                except Exception:
                    text = f"{text}\n\nUse `/model` to list available models."
                raise RuntimeError(text) from error
            raise RuntimeError(
                f"Model update to **{model}** did not complete cleanly; "
                "Zen may already have applied it. Retrying the same model is safe."
            ) from error
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

    async def _status(self, message, actions):
        binding = await actions.get_binding()
        if binding is None or binding.thread_ref is None:
            return "No Zen thread is selected. Send a message or use `/threads` and `/pick`."
        thread = _require_success(await actions.get_thread(binding.thread_ref))
        preview = str(thread.metadata.get("preview") or thread.title or "(empty thread)")
        workspace = str(thread.metadata.get("cwd") or "")
        return (
            "## Zen thread\n"
            + f"- Status: **{thread.status.value}**\n- Preview: {preview}\n"
            + ("" if self._subscription_commands else f"- ID: `{thread.ref.thread_id}`\n")
            + f"- Workspace: `{workspace}`"
        )

    async def _approval(self, message, command, actions):
        if len(command.arguments) != 1:
            raise ValueError(f"Use /{command.name} <request-id>.")
        request_ref = RequestRef(
            application_ref=self._application.summary.ref, native_request_id=command.arguments[0]
        )
        choice = {"approve": "accept", "deny": "decline", "cancel": "cancel"}[command.name]
        _require_success(
            await actions.respond_request(
                request_ref,
                ApprovalResponse(choice),
                action_id=_operation_id(
                    message, "request.respond:" + command.arguments[0] + ":" + choice
                ),
            )
        )
        return f"Approval {command.arguments[0]}: {choice}."

    def _help(self):
        text = (
            f"{self._presenter.help()}\n"
            "- `/model [name]` — list or switch Zen models\n"
            "- `/permission [full-access|approval-required]` — choose the next Thread preset\n"
            "- `/approve|/deny|/cancel <request-id>` — approval response shortcuts"
        )
        if self._subscription_commands:
            text += (
                "\n\nUse /threads then /pick <number> to select and receive replies here, "
                "including replies started on desktop. The selection survives plugin restarts. "
                "/new clears this selection; the next message starts a new thread."
            )
        if self._allow_unique_prefix:
            text += "\nUnique command prefixes are accepted; ambiguous names require more letters."
        return text


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

    async def present_failure(
        self,
        phase: InboundFailurePhase,
        *,
        conversation_ref: ConversationRef,
        delivery_id: str,
        reply_to_message_id: str,
    ) -> OutboundMessage:
        if phase is InboundFailurePhase.TURN_ENDED:
            prefix = (
                "The turn has ended; this message was not sent. Send it again to start a new turn"
            )
        elif phase is InboundFailurePhase.THREAD_BUSY:
            prefix = "A turn is still running; this message was not sent. Try again later"
        elif phase is InboundFailurePhase.OUTCOME_UNKNOWN:
            prefix = (
                "Zen may have accepted this message; its outcome is unknown. "
                "Check the thread before resending"
            )
        elif phase is InboundFailurePhase.POST_ACCEPTANCE:
            prefix = (
                "Zen accepted this message, but IM projection failed. "
                "Check the thread for the result"
            )
        else:
            prefix = "Zen could not process this message; it was not accepted"
        return OutboundMessage(
            delivery_id=delivery_id,
            conversation_ref=conversation_ref,
            content=(TextContent(f"Error: {prefix}.", TextFormat.PLAIN),),
            created_at=datetime.now(UTC),
            reply_to=reply_to_message_id,
        )


def _match_thread_selector(threads, selector):
    normalized = selector.casefold()
    exact = [
        thread
        for thread in threads
        if normalized in {thread.ref.thread_id.casefold(), (thread.title or "").casefold()}
    ]
    matches = exact or [
        thread
        for thread in threads
        if normalized in thread.ref.thread_id.casefold()
        or normalized in (thread.title or "").casefold()
    ]
    if len(matches) > 1:
        raise ValueError("Thread selector is ambiguous. Use /threads to choose its number.")
    return matches[0] if matches else None


def _require_success(result):
    if isinstance(result, Succeeded):
        return result.value
    if isinstance(result, OutcomeUnknown):
        raise RuntimeError("Action outcome is unknown; check Zen before retrying.")
    if isinstance(result, Partial):
        raise RuntimeError("Action completed only partially; check Zen before retrying.")
    if isinstance(result, Failed):
        code = result.error.operation_error_code or result.error.code
        raise RuntimeError(code.value.replace("_", " "))
    raise RuntimeError("Action returned an incompatible result.")


def _operation_id(message: InboundMessage, operation: str) -> str:
    return f"imzen:operation:{message.message_id}:{operation}"


def _zen_error_code(error: Exception) -> str | None:
    if not isinstance(error, AppServerError) or not isinstance(error.data, dict):
        return None
    code = error.data.get("zenCode")
    return code if isinstance(code, str) else None
