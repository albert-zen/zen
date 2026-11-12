"""Allowlisted, transient channel connection facts for the local plugin UI."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterable

from imagent.interaction.diagnostics import ConnectionDiagnosticState

_CHANNEL_IDS = frozenset({"qq", "telegram", "feishu", "weixin"})


def channel_status(gateway, channel_ids: Iterable[str]) -> dict:
    states = dict.fromkeys((key for key in channel_ids if key in _CHANNEL_IDS), "unknown")
    try:
        for facts in gateway.diagnostics().channels:
            if facts.channel_instance_id not in states or facts.connection is None:
                continue
            connection = facts.connection
            if not isinstance(connection.state, ConnectionDiagnosticState):
                continue
            state = connection.state.value
            if state == "disconnected" and connection.last_failure_code is not None:
                state = "failed"
            states[facts.channel_instance_id] = state
    except Exception:
        # Observation must not affect the bridge. Never serialize raw SDK errors,
        # credentials, native session IDs, or message/queue contents.
        states = dict.fromkeys(states, "unknown")
    return {
        "type": "channel-status",
        "channels": [{"id": key, "state": value} for key, value in states.items()],
    }


async def report_channel_status(gateway, channel_ids: Iterable[str], emit: Callable[[dict], None]):
    selected = tuple(channel_ids)
    while True:
        emit(channel_status(gateway, selected))
        await asyncio.sleep(1)
