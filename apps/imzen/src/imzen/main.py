from __future__ import annotations

import asyncio
import signal
from pathlib import Path

from imagent import Gateway, GatewayExtensions, ProjectionPolicy, SQLiteGatewayStore
from imagent.applications import ZenApplicationAdapter
from imagent.applications.adapters.appserver.client import AppServerClient, AppServerSupervisor

from .channels import build_channels, load_channel_config, shared_media_root
from .client import ImZenAppServerClient
from .config import Settings
from .controller import (
    ImZenContentTransformer,
    ImZenController,
    ImZenFailurePresenter,
    ImZenRequestPresenter,
    thread_start_options,
)


async def run(settings: Settings | None = None) -> None:
    resolved = settings or Settings.from_env()
    gateway, gateway_state = await prepare_gateway(resolved)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    registered_signals: list[signal.Signals] = []
    for name in ("SIGINT", "SIGTERM"):
        candidate = getattr(signal, name, None)
        if candidate is None:
            continue
        try:
            loop.add_signal_handler(candidate, stop.set)
        except (NotImplementedError, RuntimeError):
            continue
        registered_signals.append(candidate)

    gateway_started = False
    try:
        await gateway.start()
        gateway_started = True
        await stop.wait()
    finally:
        for registered in registered_signals:
            loop.remove_signal_handler(registered)
        try:
            if gateway_started:
                await gateway.stop()
        finally:
            await gateway_state.close()


async def prepare_gateway(
    resolved: Settings,
    *,
    client=None,
    migration_reader=None,
    on_state_preparation=None,
    **options,
):
    """Upgrade selected legacy state using a separate, short-lived read client."""
    from .migration import (
        GatewayStateMigrationError,
        assert_gateway_state_ready,
        prepare_gateway_state,
    )

    reader_client = None

    async def read_thread(thread_id):
        nonlocal reader_client
        if migration_reader is not None:
            return await migration_reader(thread_id)
        if reader_client is None:
            reader_client = _build_app_server_client(resolved)
            await reader_client.connect()
        return await reader_client.read_thread(thread_id, include_turns=False)

    try:
        try:
            assert_gateway_state_ready(resolved.gateway_state_file)
        except GatewayStateMigrationError:
            if on_state_preparation is not None:
                on_state_preparation()
        await prepare_gateway_state(
            resolved.gateway_state_file,
            workspace_id=resolved.workspace_id,
            workspace_root=resolved.cwd,
            read_thread=read_thread,
        )
    finally:
        if reader_client is not None:
            await reader_client.close()
    return create_gateway(resolved, client=client, **options)


def resolve_channels(resolved: Settings, *, channels=None, channel_config=None):
    """Resolve deployment channels once before building channel-scoped product routes."""
    loaded_channel_config = channel_config
    if (
        channels is None
        and loaded_channel_config is None
        and resolved.channels_config_file is not None
    ):
        loaded_channel_config = load_channel_config(resolved.channels_config_file)
    resolved_channels = (
        channels
        if channels is not None
        else build_channels(
            resolved.channels_config_file,
            channel_config=loaded_channel_config,
            permission_mode=resolved.permission_mode,
            allow_unrestricted_full_access=resolved.allow_unrestricted_full_access,
        )
    )
    return resolved_channels, loaded_channel_config


def create_gateway(
    resolved: Settings,
    *,
    client=None,
    channels=None,
    channel_config=None,
    local_app_server: bool = False,
    persistent_subscriptions: bool = False,
    controller_factory=None,
    delivery_authorizer=None,
    outbound_presentation=None,
    startup_preparations=(),
) -> tuple[Gateway, SQLiteGatewayStore]:
    """Compose the same SDK bridge for standalone IMZen and the ZenX plugin.

    Only a host that owns both local processes may set local_app_server. A
    loopback URL or locally existing directory alone cannot establish sharing.
    """
    from .migration import assert_gateway_state_ready

    assert_gateway_state_ready(resolved.gateway_state_file)
    resolved_channels, loaded_channel_config = resolve_channels(
        resolved, channels=channels, channel_config=channel_config
    )
    shared_filesystem_root = resolved.app_server_shared_filesystem_root
    if shared_filesystem_root is None and local_app_server:
        # The local Host owns both processes. Select only an explicitly declared
        # media root, never an undeclared common ancestor. The SDK resolves roots
        # strictly; create the selected directory as its materializer would.
        shared_filesystem_root = shared_media_root(
            loaded_channel_config,
            process_cwd=Path.cwd(),
        )
        if shared_filesystem_root is not None:
            shared_filesystem_root.mkdir(parents=True, exist_ok=True)
    client = client or _build_app_server_client(
        resolved,
        shared_filesystem_root=shared_filesystem_root,
    )
    application = ZenApplicationAdapter(
        application_instance_id="zen-main",
        workspace_id=resolved.workspace_id,
        client=client,
        cwd=str(resolved.cwd),
        shared_filesystem_root=shared_filesystem_root,
        thread_start_options=thread_start_options(resolved.permission_mode),
        thread_creation_profiles={
            mode: thread_start_options(mode) for mode in ("full-access", "approval-required")
        },
    )
    controller = ImZenController(
        application=application,
        client=client,
        default_permission_mode=resolved.permission_mode,
        subscription_commands=persistent_subscriptions,
        allow_unique_prefix=True,
    )
    if controller_factory is not None:
        controller = controller_factory(controller)
    if persistent_subscriptions and not resolved_channels:
        raise ValueError("IMZenX requires at least one enabled IM channel")
    gateway_state = SQLiteGatewayStore(resolved.gateway_state_file)
    gateway = Gateway(
        gateway_id="imzen",
        channels=resolved_channels,
        applications=[application],
        store=gateway_state,
        controller=controller,
        projection_policy=ProjectionPolicy.FOREGROUND_ONLY,
        delivery_authorizer=delivery_authorizer,
        extensions=GatewayExtensions(
            startup_preparations=startup_preparations,
            outbound_presentation=outbound_presentation,
            inbound_content_transformer=ImZenContentTransformer(shared_filesystem_root),
            inbound_failure_presenter=ImZenFailurePresenter(),
            request_presenter=ImZenRequestPresenter(),
        ),
    )
    return gateway, gateway_state


def _build_app_server_client(
    settings: Settings,
    *,
    shared_filesystem_root: Path | None = None,
) -> AppServerClient:
    supervisor = AppServerSupervisor(
        app_server_url=settings.app_server_url,
        app_server_auth_token_file=settings.app_server_auth_token_file,
    )
    return ImZenAppServerClient(
        supervisor=supervisor,
        client_info={
            "name": "imzen",
            "title": "IMZen",
            "version": "0.1.0",
        },
        shared_filesystem_verifier=(
            None if shared_filesystem_root is None else shared_filesystem_root.is_dir
        ),
    )
