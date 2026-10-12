from __future__ import annotations

import asyncio
import signal
from pathlib import Path

from imagent.applications import ZenApplicationAdapter
from imagent.applications.appserver_client import AppServerClient, AppServerSupervisor
from imagent.bindings import InMemoryBindingRepository
from imagent.contracts import ProjectionPolicy
from imagent.gateway import GatewayExtensions, GatewayRepositories, ImAgentGateway
from imagent.storage import SQLiteGatewayState

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
    gateway, gateway_state = create_gateway(resolved)
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


def create_gateway(
    resolved: Settings,
    *,
    client=None,
    channels=None,
    channel_config=None,
    persistent_subscriptions: bool = False,
    controller_factory=None,
    delivery_authorizer=None,
    outbound_presentation=None,
) -> tuple[ImAgentGateway, SQLiteGatewayState]:
    """Compose the same SDK bridge for standalone IMZen and the ZenX plugin."""
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
    shared_filesystem_root = resolved.app_server_shared_filesystem_root
    if shared_filesystem_root is None:
        # Unattested deployments still receive channel-downloaded images: attest
        # exactly the media directories the enabled channels already own. The
        # SDK resolves the attested root strictly, so create the declared media
        # directories the channels would create on first download anyway.
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
        client=client,
        cwd=str(resolved.cwd),
        shared_filesystem_root=shared_filesystem_root,
        thread_start_options=thread_start_options(resolved.permission_mode),
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
    gateway_state = SQLiteGatewayState(resolved.gateway_state_file)
    gateway = ImAgentGateway(
        channels=resolved_channels,
        applications=[application],
        repositories=GatewayRepositories(
            bindings=gateway_state if persistent_subscriptions else InMemoryBindingRepository(),
            projections=gateway_state if persistent_subscriptions else None,
            idempotency=gateway_state,
            delivery_submissions=gateway_state if persistent_subscriptions else None,
        ),
        projection_policy=ProjectionPolicy.FOREGROUND_ONLY,
        delivery_authorizer=delivery_authorizer,
        extensions=GatewayExtensions(
            controller=controller,
            outbound_presentation=outbound_presentation,
            inbound_content_transformer=ImZenContentTransformer(),
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
