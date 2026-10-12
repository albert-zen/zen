"""PAW Room routing; SQLite holds adapter addresses and checkpoints, never chat."""

from __future__ import annotations

import asyncio
import json
import secrets
import sqlite3
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from imagent.contracts import (
    ClearConversationThread,
    ConversationBound,
    ConversationDeliveryTarget,
    ConversationRef,
    DeliveryIntent,
    DeliveryPrincipal,
    DeliverySubmissionState,
    TextContent,
    TextFormat,
)
from imagent.controllers.slash import parse_slash_command

from .controller import _replace_command_name


class PawRoutingError(RuntimeError):
    """Safe actionable routing/delivery failure for the plugin lifecycle view."""


@dataclass(frozen=True, slots=True)
class PawBinding:
    conversation: ConversationRef
    room_id: str
    name: str
    operation_epoch: str
    checkpoint: str | None
    generation: str


class PawState:
    """Durable routing and mutation/delivery facts, with no Room transcript."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS paw_bindings (
              channel TEXT NOT NULL, conversation TEXT NOT NULL,
              room_id TEXT NOT NULL, name TEXT NOT NULL, epoch TEXT NOT NULL,
              checkpoint TEXT, generation TEXT NOT NULL,
              PRIMARY KEY(channel, conversation)
            );
            CREATE TABLE IF NOT EXISTS paw_inbound (
              client_id TEXT PRIMARY KEY, state TEXT NOT NULL, message_id TEXT
            );
            """
        )
        self._db.commit()

    def bindings(self) -> tuple[PawBinding, ...]:
        return tuple(
            PawBinding(ConversationRef(row[0], row[1]), *row[2:])
            for row in self._db.execute("SELECT * FROM paw_bindings ORDER BY channel, conversation")
        )

    def get(self, conversation: ConversationRef) -> PawBinding | None:
        row = self._db.execute(
            "SELECT * FROM paw_bindings WHERE channel=? AND conversation=?",
            (conversation.channel_instance_id, conversation.native_conversation_id),
        ).fetchone()
        return PawBinding(ConversationRef(row[0], row[1]), *row[2:]) if row else None

    def bind(self, conversation, room, checkpoint) -> None:
        with self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO paw_bindings VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    conversation.channel_instance_id,
                    conversation.native_conversation_id,
                    room["id"],
                    room["name"],
                    room["operationEpoch"],
                    checkpoint,
                    str(uuid4()),
                ),
            )

    def clear(self, conversation) -> None:
        with self._db:
            self._db.execute(
                "DELETE FROM paw_bindings WHERE channel=? AND conversation=?",
                (conversation.channel_instance_id, conversation.native_conversation_id),
            )

    def checkpoint(self, binding, message_id) -> None:
        with self._db:
            self._db.execute(
                "UPDATE paw_bindings SET checkpoint=? WHERE channel=? AND conversation=? "
                "AND generation=?",
                (
                    message_id,
                    binding.conversation.channel_instance_id,
                    binding.conversation.native_conversation_id,
                    binding.generation,
                ),
            )

    def claim_post(self, client_id) -> str | None:
        row = self._db.execute(
            "SELECT state FROM paw_inbound WHERE client_id=?", (client_id,)
        ).fetchone()
        if row is not None:
            return row[0]
        with self._db:
            self._db.execute("INSERT INTO paw_inbound VALUES (?, 'unknown', NULL)", (client_id,))
        return None

    def accepted_post(self, client_id, message_id) -> None:
        with self._db:
            self._db.execute(
                "UPDATE paw_inbound SET state='accepted', message_id=? WHERE client_id=?",
                (message_id, client_id),
            )

    def close(self) -> None:
        self._db.close()


class PawController:
    """Consume formal Room posts while retaining the SDK's legacy Thread mode."""

    def __init__(self, host, state: PawState):
        self._host = host
        self._state = state
        self._legacy = None
        self._gateway = None
        self._views = {}
        self._locks: dict[ConversationRef, asyncio.Lock] = {}
        self._credential = secrets.token_urlsafe(32)
        self._errors: dict[ConversationRef, tuple[str, str]] = {}

    def wrap(self, legacy):
        self._legacy = legacy
        legacy.register_command_names({"paw": "paw", "paws": "paws"})
        return self

    def attach(self, gateway) -> None:
        self._gateway = gateway

    def _lock(self, conversation):
        return self._locks.setdefault(conversation, asyncio.Lock())

    def route_error(self, conversation: ConversationRef) -> str | None:
        binding = self._state.get(conversation)
        error = self._errors.get(conversation)
        return error[1] if binding and error and error[0] == binding.generation else None

    async def authenticate(self, credential: str) -> DeliveryPrincipal:
        if not secrets.compare_digest(credential, self._credential):
            raise PermissionError("Invalid PAW delivery credential")
        return DeliveryPrincipal(
            principal_id="imzenx-paw",
            allowed_conversations=tuple(b.conversation for b in self._state.bindings()),
        )

    async def present(self, message, context):
        # This SDK seam handles Thread projections only. Command replies and
        # explicit Room delivery use their respective SDK public delivery paths.
        return None if self._state.get(message.conversation_ref) else message

    async def restore(self) -> None:
        """Fence any pre-existing Thread routes before SDK startup/recovery."""
        for room_binding in self._state.bindings():
            binding = await self._gateway.get_binding(room_binding.conversation)
            if binding is None or binding.thread_ref is None:
                continue
            result = await self._gateway.execute_gateway(
                ClearConversationThread(
                    operation_id=f"paw-restore:{room_binding.generation}",
                    conversation_ref=room_binding.conversation,
                    actor="imzenx-paw",
                    expected_revision=binding.revision,
                    created_at=datetime.now(UTC),
                )
            )
            if not isinstance(result, ConversationBound):
                raise RuntimeError("PAW could not clear the previous Thread route")

    async def handle(self, message, actions):
        async with self._lock(message.conversation_ref):
            return await self._handle(message, actions)

    async def _handle(self, message, actions):
        assert self._legacy is not None
        command = parse_slash_command(message)
        if command is not None:
            candidates = self._legacy.resolve_command_name(command.name)
            if len(candidates) > 1:
                return await self._legacy.handle(message, actions)
            canonical = candidates[0] if candidates else command.name
            if canonical != command.name:
                message = _replace_command_name(message, canonical)
                command = parse_slash_command(message)
            if canonical in {"paws", "paw"}:
                try:
                    text = await self._room_command(message, command, actions)
                except Exception as error:
                    text = f"PAW selection failed: {error}"
                return (self._legacy.present_response(message, text),)
            if canonical in {"new", "unsubscribe"}:
                # Keep Room routing until the native legacy clear has succeeded.
                try:
                    text = await self._legacy.clear_thread(message, actions)
                    self._state.clear(message.conversation_ref)
                    self._errors.pop(message.conversation_ref, None)
                    text += " PAW selection cleared."
                except Exception as error:
                    text = f"Could not leave PAW: {error}"
                return (self._legacy.present_response(message, text),)
            if canonical in {"pick", "thread", "subscribe"}:
                # The SDK handles its own selection errors; inspect its public
                # binding result before changing the durable Room address.
                result = await self._legacy.handle(message, actions)
                binding = await actions.get_binding(message.conversation_ref)
                if binding is not None and binding.thread_ref is not None:
                    self._state.clear(message.conversation_ref)
                    self._errors.pop(message.conversation_ref, None)
                return result
            if canonical in {"help", "start"}:
                result = await self._legacy.handle(message, actions)
                extra = (
                    "\n\nUse /paws to discover PAWs, /paw <id or number> to select a Room, "
                    "and /paw to check the route. PAW mode accepts text only and sends "
                    "formal Room replies. /new or /pick returns to normal Thread mode."
                )
                return tuple(
                    replace(out, content=out.content + (TextContent(extra),)) for out in result
                )
            if self._state.get(message.conversation_ref) and canonical != "threads":
                return (
                    self._legacy.present_response(
                        message,
                        "This conversation is in PAW Room mode. Use /paw to check the route, "
                        "/new or /pick to return to normal Thread mode.",
                    ),
                )
            return await self._legacy.handle(message, actions)
        binding = self._state.get(message.conversation_ref)
        if binding is None:
            return await self._legacy.handle(message, actions)
        paused = self.route_error(message.conversation_ref)
        if paused:
            return (
                self._legacy.present_response(
                    message, f"PAW route is paused: {paused}. Use /paw <id> to select it again."
                ),
            )
        if any(not isinstance(part, TextContent) for part in message.content):
            return (
                self._legacy.present_response(
                    message,
                    "PAW Room mode supports text only. This attachment was not sent.",
                ),
            )
        text = "\n".join(part.text for part in message.content).strip()
        if not text:
            return (self._legacy.present_response(message, "PAW message text is empty."),)
        client_id = (
            binding.operation_epoch
            + ":"
            + str(
                uuid5(
                    NAMESPACE_URL,
                    json.dumps(
                        [
                            message.conversation_ref.channel_instance_id,
                            message.conversation_ref.native_conversation_id,
                            binding.room_id,
                            message.message_id,
                        ]
                    ),
                )
            )
        )
        prior = self._state.claim_post(client_id)
        if prior == "accepted":
            return ()
        if prior == "unknown":
            return (
                self._legacy.present_response(
                    message,
                    "This PAW message's outcome is unknown. Check the Room before resending.",
                ),
            )
        try:
            posted = await self._host.request(
                "post",
                {
                    "roomId": binding.room_id,
                    "text": text,
                    "clientId": client_id,
                },
            )
            if not isinstance(posted, dict) or not isinstance(posted.get("messageId"), str):
                raise ValueError("Invalid Room admission response")
            self._state.accepted_post(client_id, posted["messageId"])
        except Exception as error:
            return (
                self._legacy.present_response(
                    message,
                    "PAW message admission failed or is unknown. Check the Room before resending; "
                    f"this message will not be retried automatically. Reason: {error}",
                ),
            )
        return ()

    async def _room_command(self, message, command, actions):
        conversation = message.conversation_ref
        if command.name == "paws":
            if command.arguments:
                raise ValueError("Use /paws without arguments.")
            result = await self._host.request("list", {})
            rooms = result.get("rooms") if isinstance(result, dict) else None
            if not isinstance(rooms, list):
                raise ValueError("Host did not return a PAW list")
            for room in rooms:
                if not isinstance(room, dict) or not all(
                    isinstance(room.get(key), str) for key in ("id", "name", "threadId")
                ):
                    raise ValueError("Host returned an invalid PAW")
            self._views[conversation] = rooms
            if not rooms:
                return "No PAWs found in the configured workspace."
            return (
                "PAWs\n"
                + "\n".join(
                    f"{index}. {room['name']} ({room['id']})" for index, room in enumerate(rooms, 1)
                )
                + "\nUse /paw <number or id> to route this conversation to its Room."
            )
        if not command.arguments:
            binding = self._state.get(conversation)
            route = (
                f"PAW Room: {binding.name} ({binding.room_id})."
                if binding
                else "Normal Thread mode."
            )
            paused = self.route_error(conversation)
            if paused:
                route += f" Route paused: {paused}."
            return route + (
                " Use /paws then /paw <number or id>; /new or /pick returns to normal Thread mode."
            )
        if len(command.arguments) != 1:
            raise ValueError("Use /paw <number or id>.")
        selector = command.arguments[0]
        if selector.isdigit():
            rooms = self._views.get(conversation)
            if rooms is None:
                raise ValueError("Use /paws first, then /paw <number> from that list.")
            if not 1 <= int(selector) <= len(rooms):
                raise ValueError("Invalid PAW number. Use /paws to refresh the list.")
            selector = rooms[int(selector) - 1]["id"]
        room, messages = await self._read(selector)
        binding = await actions.get_binding(conversation)
        if binding is not None and binding.thread_ref is not None:
            cleared = await actions.execute_gateway(
                ClearConversationThread(
                    operation_id=f"paw-select:{message.message_id}",
                    conversation_ref=conversation,
                    actor=message.sender,
                    expected_revision=binding.revision,
                    created_at=message.created_at,
                )
            )
            if not isinstance(cleared, ConversationBound):
                raise ValueError("Could not clear the previous Thread route")
        self._state.bind(conversation, room, messages[-1]["id"] if messages else None)
        self._errors.pop(conversation, None)
        return (
            f"Selected PAW {room['name']}. Text goes to its Room; "
            "new formal agent posts arrive here. "
            "Use /new or /pick to return to normal Thread mode."
        )

    async def _read(self, room_id):
        result = await self._host.request("read", {"roomId": room_id})
        room = result.get("room") if isinstance(result, dict) else None
        messages = result.get("messages") if isinstance(result, dict) else None
        if not isinstance(room, dict) or room.get("id") != room_id:
            raise ValueError("Host returned a different PAW Room")
        if not all(
            isinstance(room.get(key), str) for key in ("name", "threadId", "operationEpoch")
        ):
            raise ValueError("Host returned an invalid PAW Room")
        if str(UUID(room["operationEpoch"])) != room["operationEpoch"].lower():
            raise ValueError("Host returned an invalid Room operation epoch")
        if not isinstance(messages, list):
            raise ValueError("Host did not return Room messages")
        seen = set()
        for message in messages:
            if (
                not isinstance(message, dict)
                or message.get("roomId") != room_id
                or not isinstance(message.get("id"), str)
                or not message["id"]
                or message["id"] in seen
                or message.get("kind") not in {"human", "agent", "system"}
                or not isinstance(message.get("text"), str)
                or not isinstance(message.get("createdAt"), (int, float))
            ):
                raise ValueError("Host returned invalid formal Room messages")
            seen.add(message["id"])
        return room, messages

    async def poll_once(self) -> None:
        for selected in self._state.bindings():
            if self.route_error(selected.conversation):
                continue
            try:
                await self._poll_binding(selected)
            except PawRoutingError as error:
                await self._pause_route(selected, str(error))

    async def _pause_route(self, selected: PawBinding, reason: str) -> None:
        async with self._lock(selected.conversation):
            current = self._state.get(selected.conversation)
            if current is None or current.generation != selected.generation:
                return
            self._errors[selected.conversation] = (selected.generation, reason)
            # One durable, SDK-idempotent notice. A failing transport stays
            # visible in /paw without becoming an automatic retry loop.
            try:
                await self._gateway.deliver_proactively(
                    DeliveryIntent(
                        delivery_id=f"paw-route-error:{selected.generation}",
                        target=ConversationDeliveryTarget(selected.conversation),
                        content=(
                            TextContent(f"PAW route paused: {reason}. Use /paw to check it."),
                        ),
                        created_at=datetime.now(UTC),
                    ),
                    credential=self._credential,
                )
            except Exception:
                pass

    async def _poll_binding(self, selected: PawBinding) -> None:
        try:
            room, messages = await self._read(selected.room_id)
        except Exception as error:
            raise PawRoutingError(f"PAW Room read failed: {error}") from error
        async with self._lock(selected.conversation):
            binding = self._state.get(selected.conversation)
            if binding is None or binding.generation != selected.generation:
                return  # A route changed while the bounded read was in flight.
            if room["operationEpoch"] != binding.operation_epoch:
                raise PawRoutingError("PAW Room changed; select it again with /paw")
            ids = [message["id"] for message in messages]
            if binding.checkpoint is not None:
                if binding.checkpoint not in ids:
                    raise PawRoutingError(
                        "PAW Room checkpoint is outside the history window; "
                        "select it again with /paw"
                    )
                messages = messages[ids.index(binding.checkpoint) + 1 :]
            elif len(messages) >= 50:
                raise PawRoutingError(
                    "PAW Room history window may have skipped replies; select it again with /paw"
                )
            for message in messages:
                if message["kind"] == "agent" and message["text"].strip():
                    delivery_id = "paw-room:" + str(
                        uuid5(
                            NAMESPACE_URL,
                            json.dumps(
                                [
                                    selected.conversation.channel_instance_id,
                                    selected.conversation.native_conversation_id,
                                    selected.room_id,
                                    message["id"],
                                ]
                            ),
                        )
                    )
                    try:
                        result = await self._gateway.deliver_proactively(
                            DeliveryIntent(
                                delivery_id=delivery_id,
                                target=ConversationDeliveryTarget(selected.conversation),
                                content=(TextContent(message["text"], format=TextFormat.MARKDOWN),),
                                created_at=datetime.fromtimestamp(message["createdAt"] / 1000, UTC),
                            ),
                            credential=self._credential,
                        )
                    except Exception as error:
                        raise PawRoutingError(
                            "PAW Room reply delivery failed without a confirmed receipt; "
                            "check the channel before selecting the PAW again"
                        ) from error
                    if result.state is not DeliverySubmissionState.ACCEPTED:
                        raise PawRoutingError(
                            f"PAW Room reply delivery is {result.state.value}; "
                            "check the channel before selecting the PAW again"
                        )
                self._state.checkpoint(binding, message["id"])

    async def poll(self, interval: float = 2) -> None:
        while True:
            await self.poll_once()
            await asyncio.sleep(interval)
