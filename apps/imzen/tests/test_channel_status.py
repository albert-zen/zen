from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from imagent.interaction.channels.diagnostics import ChannelDiagnosticFacts
from imagent.interaction.diagnostics import (
    ConnectionDiagnosticFacts,
    ConnectionDiagnosticState,
    DiagnosticFailureCode,
)

from imzen.channel_status import channel_status, report_channel_status


def gateway_with(state, failure=None):
    facts = ChannelDiagnosticFacts(
        "qq",
        "qq",
        ConnectionDiagnosticFacts(
            state=state,
            connection_epoch=1,
            reconnect_count=0,
            worker_running=True,
            worker_degraded=False,
            last_failure_code=failure,
        ),
    )
    return SimpleNamespace(diagnostics=lambda: SimpleNamespace(channels=(facts,)))


@pytest.mark.parametrize("state", list(ConnectionDiagnosticState))
def test_channel_status_uses_sdk_connection_facts_not_gateway_startup(state):
    assert channel_status(gateway_with(state), ("qq",)) == {
        "type": "channel-status",
        "channels": [{"id": "qq", "state": state.value}],
    }


def test_missing_or_failed_diagnostics_is_unknown_and_never_leaks_error_detail():
    def failed():
        raise RuntimeError("private-token-and-native-session")

    for gateway in (
        SimpleNamespace(diagnostics=failed),
        SimpleNamespace(diagnostics=lambda: SimpleNamespace(channels=())),
    ):
        result = channel_status(gateway, ("qq", "private-channel-name"))
        assert result == {"type": "channel-status", "channels": [{"id": "qq", "state": "unknown"}]}
        assert "private" not in json.dumps(result)


def test_failure_is_shown_only_while_disconnected_not_after_successful_reconnect():
    for state, expected in (
        (ConnectionDiagnosticState.DISCONNECTED, "failed"),
        (ConnectionDiagnosticState.READY, "ready"),
    ):
        gateway = gateway_with(state, DiagnosticFailureCode.CONNECT_FAILED)
        assert channel_status(gateway, ("qq",))["channels"] == [{"id": "qq", "state": expected}]


@pytest.mark.asyncio
async def test_status_reporter_emits_immediately_and_cancels_without_stopping_gateway():
    emitted = asyncio.Event()
    frames = []

    def emit(frame):
        frames.append(frame)
        emitted.set()

    task = asyncio.create_task(
        report_channel_status(gateway_with(ConnectionDiagnosticState.READY), ("qq",), emit)
    )
    await asyncio.wait_for(emitted.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert frames == [{"type": "channel-status", "channels": [{"id": "qq", "state": "ready"}]}]
