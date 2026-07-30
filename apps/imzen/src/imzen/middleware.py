from __future__ import annotations

import asyncio
import time
from typing import Any

from imcodex.channels.base import ChannelRouteContext
from imcodex.models import InboundMessage, OutboundMessage

from .config import PermissionMode
from .gateway import AppServerClient, ImZenGateway


class ImZenMiddleware:
    """The small adapter-facing surface that IMCodex channels require."""

    def __init__(
        self,
        *,
        client: AppServerClient,
        default_cwd: str,
        default_permission_mode: PermissionMode = "full-access",
    ) -> None:
        self._adapters: dict[str, Any] = {}
        self._route_contexts: dict[tuple[str, str], ChannelRouteContext] = {}
        self._conversation_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self.gateway = ImZenGateway(
            client=client,
            default_cwd=default_cwd,
            default_permission_mode=default_permission_mode,
            deliver=self._deliver,
        )

    def register_adapter(self, adapter: Any) -> None:
        channel_id = str(getattr(adapter, "channel_id", "") or "")
        if not channel_id:
            raise ValueError("channel adapter must expose channel_id")
        if channel_id in self._adapters and self._adapters[channel_id] is not adapter:
            raise ValueError(f"duplicate channel adapter: {channel_id}")
        self._adapters[channel_id] = adapter

    async def start(self) -> None:
        await self.gateway.start()

    async def stop(self) -> None:
        await self.gateway.close()

    async def handle_inbound(
        self,
        adapter: Any,
        inbound: InboundMessage,
        *,
        reply_to_message_id: str | None = None,
        prepare_inbound: Any = None,
        pending_attachment_count: int = 0,
    ) -> None:
        del pending_attachment_count
        self.register_adapter(adapter)
        key = (str(inbound.channel_id), str(inbound.conversation_id))
        lock = self._conversation_locks.setdefault(key, asyncio.Lock())
        async with lock:
            try:
                if prepare_inbound is not None:
                    inbound = await prepare_inbound(inbound)
                self._route_contexts[key] = ChannelRouteContext(
                    admitted_user_id=str(inbound.user_id),
                    last_inbound_message_id=str(
                        reply_to_message_id or inbound.reply_to_message_id or inbound.message_id
                    ),
                    last_inbound_seen_at=time.time(),
                )
                await self.gateway.handle_inbound(inbound)
            except Exception as exc:
                await self._deliver(
                    OutboundMessage(
                        channel_id=key[0],
                        conversation_id=key[1],
                        message_type="error",
                        text=f"Zen could not process this message: {exc}",
                        metadata={
                            "delivery_id": (f"imzen:error:{key[0]}:{key[1]}:{inbound.message_id}")
                        },
                    )
                )

    def get_route_context(self, channel_id: str, conversation_id: str) -> ChannelRouteContext:
        return self._route_contexts.get(
            (channel_id, conversation_id),
            ChannelRouteContext(),
        )

    async def _deliver(self, message: OutboundMessage) -> None:
        adapter = self._adapters.get(message.channel_id)
        if adapter is None:
            raise RuntimeError(f"no active adapter for channel {message.channel_id}")
        context = self.get_route_context(message.channel_id, message.conversation_id)
        if context.last_inbound_message_id:
            message.metadata.setdefault(
                "reply_to_message_id",
                context.last_inbound_message_id,
            )
        await adapter.send_message(message)
