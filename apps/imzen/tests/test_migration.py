# Filesystem assertions are intentional, single-process offline test evidence.
# ruff: noqa: ASYNC240
from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest
from imagent import SQLiteGatewayStore
from imagent.applications import ProjectRef, ThreadRef
from imagent.gateway.persistence import IdempotencyClaimStatus
from imagent.interaction.messages import ConversationRef
from imagent.testing import FakeChannelAdapter

from imzen.migration import (
    GatewayStateMigrationError,
    assert_gateway_state_ready,
    prepare_gateway_state,
)


@pytest.fixture
def legacy_database(tmp_path):
    path = tmp_path / "gateway.sqlite3"
    dump = (Path(__file__).parent / "fixtures" / "gateway-v0.sql").read_text()
    with sqlite3.connect(path) as connection:
        connection.executescript(dump)
    return path


async def native_thread(thread_id):
    return {"thread": {"id": thread_id, "cwd": "/legacy/workspace"}}


async def test_genuine_legacy_rows_preserve_binding_generation_and_unknown_claims(legacy_database):
    before = legacy_database.read_bytes()
    with pytest.raises(GatewayStateMigrationError, match="prepare"):
        assert_gateway_state_ready(legacy_database)
    result = await prepare_gateway_state(
        legacy_database,
        workspace_id="workspace-stable",
        workspace_root="/legacy/workspace",
        read_thread=native_thread,
    )
    assert result.migrated
    assert result.backup_path.read_bytes() == before
    assert_gateway_state_ready(legacy_database)
    store = SQLiteGatewayStore(legacy_database, stale_claim_after_seconds=0)
    session = await store.acquire_runtime(
        gateway_id="imzen", owner_token="new-runtime", lease_duration_seconds=30
    )
    try:
        conversation = ConversationRef("fake-channel", "legacy-chat")
        binding = await session.get(conversation)
        assert binding.generation == 2
        assert binding.thread_ref == ThreadRef(
            ProjectRef("zen-main", "workspace-stable"), "thread-1"
        )
        assert await session.get_binding_generation(conversation) == 2
        assert await session.claim("inbound:fake-channel", "legacy-chat:completed-input") is (
            IdempotencyClaimStatus.ALREADY_COMPLETED
        )
        assert await session.claim("inbound:fake-channel", "legacy-chat:uncertain-input") is (
            IdempotencyClaimStatus.IN_FLIGHT
        )
    finally:
        await session.release_runtime()
        await store.close()


async def test_projection_checkpoints_and_request_reply_routing_survive(legacy_database):
    await prepare_gateway_state(
        legacy_database,
        workspace_id="workspace-stable",
        workspace_root="/legacy/workspace",
        read_thread=native_thread,
    )
    store = SQLiteGatewayStore(legacy_database)
    session = await store.acquire_runtime(
        gateway_id="imzen", owner_token="inspector", lease_duration_seconds=30
    )
    try:
        from imagent.applications import TurnRef
        from imagent.gateway.projection.request_correlation import derive_turn_reply_correlation_id
        from imagent.gateway.routing.projection_routes import derive_projection_route_id

        thread = ThreadRef(ProjectRef("zen-main", "workspace-stable"), "thread-1")
        conversation = ConversationRef("fake-channel", "legacy-chat")
        routes = await session.list_projection_routes(thread_ref=thread)
        assert len(routes) == 1
        route = routes[0]
        assert route.route_id == derive_projection_route_id(thread, conversation)
        assert route.checkpoint_agent_item_id == "canonical-item-7"
        assert route.reply_to_message_id == "topic"
        reply = await session.get_turn_reply_correlation(thread, "legacy-turn")
        assert reply.correlation_id == derive_turn_reply_correlation_id(
            TurnRef(thread, "legacy-turn")
        )
        assert reply.reply_to_message_id == "message-7"
        requests = await session.list_request_correlations(thread_ref=thread)
        assert {request.state.value for request in requests} == {"open", "responded"}
        assert all(request.response_shape.choice_ids == ("approve", "deny") for request in requests)
        with pytest.raises(Exception, match="generation"):
            await session.put(await session.get(conversation), expected_generation=1)
        await session.delete(conversation, expected_generation=2)
        assert await session.get_binding_generation(conversation) >= 2
    finally:
        await session.release_runtime()
        await store.close()


async def test_v1_gateway_replays_unknown_and_accepted_delivery_without_sending(legacy_database):
    from datetime import UTC, datetime

    from imagent import Gateway
    from imagent.gateway.delivery import (
        ConversationDeliveryTarget,
        DeliveryIntent,
        DeliveryPrincipal,
        ScopedDeliveryAuthorizer,
        ThreadRouteDeliveryTarget,
    )
    from imagent.gateway.routing.projection_routes import derive_projection_route_id
    from imagent.interaction.messages import TextContent
    from imagent.testing import FakeAgentApplicationAdapter, FakeChannelAdapter

    await prepare_gateway_state(
        legacy_database,
        workspace_id="workspace-stable",
        workspace_root="/legacy/workspace",
        read_thread=native_thread,
    )
    # A real v1 Gateway runs the delivery service and channel. No private runtime
    # shortcut can hide a changed submission hash or accidentally resend a notice.
    channel = FakeChannelAdapter("fake-channel")
    application = FakeAgentApplicationAdapter("zen-main")
    conversation = ConversationRef("fake-channel", "legacy-chat")
    thread = ThreadRef(ProjectRef("zen-main", "workspace-stable"), "thread-1")
    authorizer = ScopedDeliveryAuthorizer()
    token = await authorizer.issue(
        DeliveryPrincipal(
            "rotated-principal", allowed_conversations=(conversation,), allowed_threads=(thread,)
        )
    )
    original_token = await authorizer.issue(
        DeliveryPrincipal("legacy-principal", allowed_conversations=(conversation,))
    )
    store = SQLiteGatewayStore(legacy_database)
    gateway = Gateway(
        gateway_id="imzen",
        channels=[channel],
        applications=[application],
        store=store,
        delivery_authorizer=authorizer,
    )
    await gateway.start()
    try:
        for state in ("unknown", "accepted", "in_flight"):
            result = await gateway.deliver_proactively(
                DeliveryIntent(
                    delivery_id="notice-" + state,
                    target=ConversationDeliveryTarget(conversation),
                    content=(TextContent("legacy proactive notice"),),
                    created_at=datetime.now(UTC),
                ),
                credential=original_token if state == "in_flight" else token,
            )
            assert result.state.value == state
            assert result.destinations[0].replayed
            if state == "accepted":
                assert result.destinations[0].receipt.native_message_id == "native-42"
        route_id = derive_projection_route_id(thread, conversation)
        thread_result = await gateway.deliver_proactively(
            DeliveryIntent(
                delivery_id="thread-notice",
                target=ThreadRouteDeliveryTarget(thread, route_id),
                content=(TextContent("legacy proactive notice"),),
                created_at=datetime.now(UTC),
            ),
            credential=token,
        )
        assert thread_result.state.value == "unknown"
        assert thread_result.destinations[0].replayed
        assert channel.sent == []
    finally:
        await gateway.stop()
        await store.close()


async def test_no_network_for_fresh_and_already_migrated_databases(legacy_database, tmp_path):
    async def no_network(_thread):
        pytest.fail("Fresh/current database must not connect to a native host")

    missing = tmp_path / "new.sqlite3"
    assert not (
        await prepare_gateway_state(
            missing,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=no_network,
        )
    ).migrated
    assert not missing.exists()
    await prepare_gateway_state(
        legacy_database,
        workspace_id="workspace-stable",
        workspace_root="/legacy/workspace",
        read_thread=native_thread,
    )
    before = legacy_database.read_bytes()
    assert not (
        await prepare_gateway_state(
            legacy_database,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=no_network,
        )
    ).migrated
    assert legacy_database.read_bytes() == before


@pytest.mark.parametrize(
    "native",
    [
        None,
        {"thread": {"id": "wrong-thread", "cwd": "/legacy/workspace"}},
        {"thread": {"id": "thread-1", "cwd": "/another/workspace"}},
        {"thread": {"id": "thread-1"}},
        {"thread": {"id": "thread-1", "cwd": "relative/root"}},
    ],
)
async def test_missing_or_unproven_ancestry_never_modifies_original(legacy_database, native):
    before = legacy_database.read_bytes()

    async def reader(_thread):
        return native

    with pytest.raises(GatewayStateMigrationError) as raised:
        await prepare_gateway_state(
            legacy_database,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=reader if native else None,
        )
    assert legacy_database.read_bytes() == before
    assert raised.value.backup_path.read_bytes() == before
    assert not list(legacy_database.parent.glob(".imzen-migration-*"))


def change_database(path, sql, parameters=()):
    with sqlite3.connect(path) as connection:
        connection.execute(sql, parameters)


async def test_existing_project_ancestry_still_requires_native_root_evidence(legacy_database):
    change_database(
        legacy_database, "UPDATE conversation_bindings SET project_id = 'workspace-stable'"
    )
    with pytest.raises(GatewayStateMigrationError, match="provenance"):
        await prepare_gateway_state(
            legacy_database, workspace_id="workspace-stable", workspace_root="/legacy/workspace"
        )
    result = await prepare_gateway_state(
        legacy_database,
        workspace_id="workspace-stable",
        workspace_root="/legacy/workspace",
        read_thread=native_thread,
    )
    assert result.migrated
    assert result.thread_count == 1


@pytest.mark.parametrize(
    "sql, expected",
    [
        ("UPDATE conversation_bindings SET project_id = 'another-project'", "conflicts"),
        ("ALTER TABLE thread_projection_routes DROP COLUMN checkpoint_agent_item_id", "columns"),
        ("CREATE TABLE future_state (value TEXT)", "tables"),
        ("UPDATE delivery_submission_destinations SET error = 'legacy diagnostic'", "scrubbed"),
        ("UPDATE delivery_submission_destinations SET state = 'retryable'", "Retryable"),
        (
            "INSERT INTO idempotency_records VALUES ('outbound:fake-channel', "
            "'imagent:delivery:sha256:opaque', 'side_effect_started', 'owner', "
            "'2026-10-13T00:00:00+00:00')",
            "projection delivery hashes",
        ),
        ("UPDATE idempotency_records SET status = 'future-state'", "idempotency state"),
        ("UPDATE delivery_submissions SET target_fingerprint = 'opaque-target'", "target"),
        ("UPDATE request_route_correlations SET response_shape_json = '{}'", "validation"),
        ("UPDATE conversation_bindings SET revision = -1", "validation"),
    ],
)
async def test_unsupported_legacy_state_blocks_without_loss(legacy_database, sql, expected):
    change_database(legacy_database, sql)
    before = legacy_database.read_bytes()
    with pytest.raises(GatewayStateMigrationError, match=expected) as raised:
        await prepare_gateway_state(
            legacy_database,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=native_thread,
        )
    assert legacy_database.read_bytes() == before
    assert raised.value.backup_path.read_bytes() == before


async def test_native_reader_failure_keeps_original_and_backup(legacy_database):
    async def disconnected(_thread):
        raise ConnectionError("synthetic host unavailable")

    before = legacy_database.read_bytes()
    with pytest.raises(GatewayStateMigrationError, match="Reconnect") as raised:
        await prepare_gateway_state(
            legacy_database,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=disconnected,
        )
    assert legacy_database.read_bytes() == before
    assert raised.value.backup_path.read_bytes() == before


async def test_detects_concurrent_source_change_before_atomic_install(legacy_database):
    before = legacy_database.read_bytes()

    async def changed(thread_id):
        change_database(legacy_database, "UPDATE conversation_bindings SET revision=3")
        return await native_thread(thread_id)

    with pytest.raises(GatewayStateMigrationError, match="changed") as raised:
        await prepare_gateway_state(
            legacy_database,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=changed,
        )
    with sqlite3.connect(legacy_database) as connection:
        assert connection.execute("SELECT revision FROM conversation_bindings").fetchone() == (3,)
    assert raised.value.backup_path.read_bytes() == before


async def test_live_or_unclean_database_is_never_snapshotted_without_wal(legacy_database):
    connection = sqlite3.connect(legacy_database)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("UPDATE conversation_bindings SET revision=3")
    connection.commit()
    before = legacy_database.read_bytes()
    wal = Path(str(legacy_database) + "-wal")
    wal_before = wal.read_bytes()
    try:
        with pytest.raises(GatewayStateMigrationError, match="Stop all IMZen"):
            await prepare_gateway_state(
                legacy_database,
                workspace_id="workspace-stable",
                workspace_root="/legacy/workspace",
                read_thread=native_thread,
            )
        assert legacy_database.read_bytes() == before
        assert wal.read_bytes() == wal_before
        assert not list(legacy_database.parent.glob("*.bak"))
    finally:
        connection.close()


async def test_legacy_principal_collision_is_not_collapsed(legacy_database):
    import hashlib
    import json

    new_id = (
        "imagent:delivery-submission:sha256:"
        + hashlib.sha256(
            json.dumps(
                ["external", "different-principal", "notice-unknown"], separators=(",", ":")
            ).encode()
        ).hexdigest()
    )
    change_database(
        legacy_database,
        "INSERT INTO delivery_submissions SELECT ?, delivery_id, origin, ?, target_fingerprint, "
        "payload_fingerprint, created_at, updated_at FROM delivery_submissions "
        "WHERE delivery_id='notice-unknown'",
        (new_id, "different-principal"),
    )
    before = legacy_database.read_bytes()
    with pytest.raises(GatewayStateMigrationError, match="principals"):
        await prepare_gateway_state(
            legacy_database,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=native_thread,
        )
    assert legacy_database.read_bytes() == before


async def test_fresh_v0_sdk_subprocess_upgrade(tmp_path):
    """Optional live provenance check; frozen fixture tests above run everywhere.

    IMZEN_LEGACY_PYTHON must point to an already installed bb805505 v0 runtime.
    No installation or real state is used, and PYTHONPATH is deliberately removed.
    """
    import os
    import subprocess

    python = os.environ.get("IMZEN_LEGACY_PYTHON")
    if python is None:
        pytest.skip("Set IMZEN_LEGACY_PYTHON for genuine v0 writer subprocess validation")
    environment = dict(os.environ)
    environment.pop("PYTHONPATH", None)
    path = tmp_path / "fresh-v0.sqlite3"
    generator = Path(__file__).parent / "fixtures" / "generate_gateway_v0.py"
    await asyncio.to_thread(
        subprocess.run,
        [python, str(generator), str(path)],
        env=environment,
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    )
    result = await prepare_gateway_state(
        path,
        workspace_id="workspace-stable",
        workspace_root="/legacy/workspace",
        read_thread=native_thread,
    )
    assert result.migrated
    # Reuse the actual Gateway replay test, now on a fresh legacy SDK output.
    await test_v1_gateway_replays_unknown_and_accepted_delivery_without_sending(path)
    await test_v1_gateway_continues_legacy_thread_and_suppresses_duplicate_input(path)


async def test_current_v1_wal_is_read_without_blocking_sdk_runtime_fencing(tmp_path):
    from imagent.gateway.persistence import RuntimeLeaseUnavailable

    path = tmp_path / "current.sqlite3"
    first = SQLiteGatewayStore(path)
    session = await first.acquire_runtime(
        gateway_id="imzen", owner_token="active-owner", lease_duration_seconds=30
    )

    async def no_network(_thread):
        pytest.fail("Current v1 state must not trigger native migration calls")

    try:
        assert Path(str(path) + "-wal").exists()
        assert_gateway_state_ready(path)
        assert not (
            await prepare_gateway_state(
                path,
                workspace_id="workspace-stable",
                workspace_root="/legacy/workspace",
                read_thread=no_network,
            )
        ).migrated
        second = SQLiteGatewayStore(path)
        try:
            with pytest.raises(RuntimeLeaseUnavailable):
                await second.acquire_runtime(
                    gateway_id="imzen", owner_token="other-owner", lease_duration_seconds=30
                )
        finally:
            await second.close()
    finally:
        await session.release_runtime()
        await first.close()


async def test_current_v1_crash_wal_is_recovered_by_sdk(tmp_path):
    import os
    import subprocess
    import sys

    path = tmp_path / "crashed.sqlite3"
    script = """
import asyncio, os, sys
from imagent import SQLiteGatewayStore
from imagent.gateway.persistence import ConversationBinding
from imagent.interaction.messages import ConversationRef
from imagent.testing import FakeChannelAdapter
async def main():
    store = SQLiteGatewayStore(sys.argv[1])
    session = await store.acquire_runtime(gateway_id='imzen', owner_token='crashed-owner',
        lease_duration_seconds=30)
    await session.put(ConversationBinding(ConversationRef('channel', 'durable-conversation')))
    await session.release_runtime()
    os._exit(0)
asyncio.run(main())
"""
    await asyncio.to_thread(
        subprocess.run, [sys.executable, "-c", script, str(path)], check=True, env=dict(os.environ)
    )
    assert Path(str(path) + "-wal").exists()
    assert_gateway_state_ready(path)
    assert not (
        await prepare_gateway_state(
            path, workspace_id="workspace-stable", workspace_root="/legacy/workspace"
        )
    ).migrated
    store = SQLiteGatewayStore(path)
    session = await store.acquire_runtime(
        gateway_id="imzen", owner_token="recovered", lease_duration_seconds=30
    )
    try:
        assert await session.get(ConversationRef("channel", "durable-conversation")) is not None
    finally:
        await session.release_runtime()
        await store.close()


async def test_v1_gateway_continues_legacy_thread_and_suppresses_duplicate_input(legacy_database):
    from datetime import UTC, datetime

    from imagent import Gateway
    from imagent.applications.capabilities import ProjectMode
    from imagent.interaction.messages import InboundMessage, TextContent
    from imagent.testing import FakeAgentApplicationAdapter, FakeChannelAdapter

    await prepare_gateway_state(
        legacy_database,
        workspace_id="workspace-stable",
        workspace_root="/legacy/workspace",
        read_thread=native_thread,
    )
    application = FakeAgentApplicationAdapter(
        "zen-main",
        project_mode=ProjectMode.FIXED,
        workspace_id="workspace-stable",
        workspace_root="/legacy/workspace",
    )
    native = await application.create_thread(application.default_project_ref)
    assert native.ref.thread_id == "thread-1"
    replied = asyncio.Event()

    class RecordingChannel(FakeChannelAdapter):
        async def send(self, message):
            receipt = await super().send(message)
            if any(
                isinstance(part, TextContent) and "fake final_answer" in part.text
                for part in message.content
            ):
                replied.set()
            return receipt

    channel = RecordingChannel("fake-channel")
    store = SQLiteGatewayStore(legacy_database)
    gateway = Gateway(
        gateway_id="imzen", channels=[channel], applications=[application], store=store
    )
    await gateway.start()
    try:
        for message_id in ("completed-input", "uncertain-input"):
            await channel.emit_message(
                InboundMessage(
                    message_id,
                    ConversationRef("fake-channel", "legacy-chat"),
                    "synthetic-user",
                    (TextContent("must not execute twice"),),
                    datetime.now(UTC),
                )
            )
        await asyncio.sleep(0)
        assert not channel.sent
        await channel.emit_message(
            InboundMessage(
                "new-input",
                ConversationRef("fake-channel", "legacy-chat"),
                "synthetic-user",
                (TextContent("continue original thread"),),
                datetime.now(UTC),
            )
        )

        await asyncio.wait_for(replied.wait(), timeout=3)
        assert any(
            "fake final_answer" in part.text
            for message in channel.sent
            for part in message.content
            if isinstance(part, TextContent)
        )
        assert len((await application.list_threads(application.default_project_ref)).items) == 1
        assert (await application.get_thread(native.ref)).status.value == "completed"
    finally:
        await gateway.stop()
        await store.close()


async def test_atomic_install_failure_preserves_original_and_backup(legacy_database, monkeypatch):
    from imzen import migration

    before = legacy_database.read_bytes()

    def cannot_replace(_source, _target):
        raise PermissionError("synthetic atomic replace failure")

    monkeypatch.setattr(migration.os, "replace", cannot_replace)
    with pytest.raises(GatewayStateMigrationError, match="Cannot install") as raised:
        await prepare_gateway_state(
            legacy_database,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=native_thread,
        )
    assert legacy_database.read_bytes() == before
    assert raised.value.backup_path.read_bytes() == before


async def test_cancelled_native_preflight_preserves_original_and_backup(legacy_database):
    before = legacy_database.read_bytes()

    async def cancelled(_thread):
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await prepare_gateway_state(
            legacy_database,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=cancelled,
        )
    assert legacy_database.read_bytes() == before
    backups = list(legacy_database.parent.glob("*.bak"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == before


async def test_identical_content_replaced_inode_is_detected(legacy_database):
    import os

    before = legacy_database.read_bytes()

    async def changed(thread_id):
        replacement = legacy_database.with_suffix(".replacement")
        replacement.write_bytes(before)
        os.replace(replacement, legacy_database)
        return await native_thread(thread_id)

    with pytest.raises(GatewayStateMigrationError, match="changed"):
        await prepare_gateway_state(
            legacy_database,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=changed,
        )
    assert legacy_database.read_bytes() == before


def test_partially_upgraded_schema_does_not_become_a_fresh_database(legacy_database):
    change_database(
        legacy_database, "ALTER TABLE conversation_bindings RENAME COLUMN revision TO generation"
    )
    before = legacy_database.read_bytes()
    with pytest.raises(GatewayStateMigrationError, match="partially upgraded"):
        assert_gateway_state_ready(legacy_database)
    assert legacy_database.read_bytes() == before


async def test_delivery_snapshot_survives_previously_deleted_route(legacy_database):
    change_database(legacy_database, "DELETE FROM thread_projection_routes")
    await test_v1_gateway_replays_unknown_and_accepted_delivery_without_sending(legacy_database)


@pytest.mark.parametrize(
    "sql",
    [
        "UPDATE thread_projection_routes SET route_id='custom-route'",
        "UPDATE turn_reply_correlations SET correlation_id='custom-turn-reply'",
        "INSERT INTO idempotency_records VALUES ('outbound:fake-channel', "
        "'imagent:delivery:live:sha256:opaque', 'side_effect_started', 'owner', "
        "'2026-10-13T00:00:00+00:00')",
    ],
)
async def test_nonstandard_or_opaque_route_identity_requires_review(legacy_database, sql):
    change_database(legacy_database, sql)
    before = legacy_database.read_bytes()
    with pytest.raises(GatewayStateMigrationError):
        await prepare_gateway_state(
            legacy_database,
            workspace_id="workspace-stable",
            workspace_root="/legacy/workspace",
            read_thread=native_thread,
        )
    assert legacy_database.read_bytes() == before


def test_dangling_symlink_is_not_treated_as_fresh_database(tmp_path):
    target = tmp_path / "not-created.sqlite3"
    link = tmp_path / "symlink.sqlite3"
    link.symlink_to(target)
    with pytest.raises(GatewayStateMigrationError, match="symlink"):
        assert_gateway_state_ready(link)
    assert not target.exists()


async def test_product_preparation_uses_separate_read_client_and_closes_it(
    legacy_database, monkeypatch, tmp_path
):
    from test_gateway import FakeAppServer

    import imzen.main as main
    from imzen.config import Settings

    settings = Settings("ws://127.0.0.1:4500", tmp_path, legacy_database)
    native = FakeAppServer()
    native.threads["thread-1"] = {"id": "thread-1", "cwd": str(tmp_path)}
    consumer = FakeAppServer()
    monkeypatch.setattr(main, "_build_app_server_client", lambda _: native)
    preparing = []
    gateway, store = await main.prepare_gateway(
        settings,
        client=consumer,
        channels=[FakeChannelAdapter("fake-channel")],
        on_state_preparation=lambda: preparing.append(True),
    )
    assert preparing == [True]
    assert native.connected and native.closed
    assert not consumer.connected and not consumer.closed
    assert_gateway_state_ready(legacy_database)
    await store.close()


async def test_product_preparation_failure_closes_reader_and_keeps_original(
    legacy_database, monkeypatch, tmp_path
):
    from test_gateway import FakeAppServer

    import imzen.main as main
    from imzen.config import Settings

    settings = Settings("ws://127.0.0.1:4500", tmp_path, legacy_database)
    native = FakeAppServer()
    native.threads["thread-1"] = {"id": "thread-1", "cwd": "/unrelated-workspace"}
    monkeypatch.setattr(main, "_build_app_server_client", lambda _: native)
    before = legacy_database.read_bytes()
    with pytest.raises(GatewayStateMigrationError, match="workspace"):
        await main.prepare_gateway(settings, client=FakeAppServer(), channels=[])
    assert native.connected and native.closed
    assert legacy_database.read_bytes() == before


async def test_product_preparation_of_fresh_state_never_opens_native_reader(tmp_path, monkeypatch):
    from test_gateway import FakeAppServer

    import imzen.main as main
    from imzen.config import Settings

    def unexpected_reader(_):
        raise AssertionError("fresh state must not open a migration connection")

    monkeypatch.setattr(main, "_build_app_server_client", unexpected_reader)
    preparing = []
    settings = Settings("ws://127.0.0.1:4500", tmp_path, tmp_path / "fresh.sqlite3")
    gateway, store = await main.prepare_gateway(
        settings,
        client=FakeAppServer(),
        channels=[FakeChannelAdapter("fake-channel")],
        on_state_preparation=lambda: preparing.append(True),
    )
    assert not preparing
    await store.close()
