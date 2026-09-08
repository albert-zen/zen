from __future__ import annotations

import asyncio
import signal

from imagent.applications import ZenApplicationAdapter
from imagent.applications.appserver_client import AppServerClient, AppServerSupervisor
from imagent.bindings import InMemoryBindingRepository
from imagent.contracts import ProjectionPolicy
from imagent.gateway import GatewayExtensions, GatewayRepositories, ImAgentGateway
from imagent.storage import SQLiteGatewayState

from .channels import build_channels
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
    persistent_subscriptions: bool = False,
) -> tuple[ImAgentGateway, SQLiteGatewayState]:
    """Compose the same SDK bridge for standalone IMZen and the ZenX plugin."""
    client = client or _build_app_server_client(resolved)
    application = ZenApplicationAdapter(
        application_instance_id="zen-main",
        client=client,
        cwd=str(resolved.cwd),
        shared_filesystem_root=resolved.app_server_shared_filesystem_root,
        thread_start_options=thread_start_options(resolved.permission_mode),
    )
    controller = ImZenController(
        application=application,
        client=client,
        default_permission_mode=resolved.permission_mode,
        subscription_commands=persistent_subscriptions,
    )
    resolved_channels = (
        channels
        if channels is not None
        else build_channels(
            resolved.channels_config_file,
            permission_mode=resolved.permission_mode,
            allow_unrestricted_full_access=resolved.allow_unrestricted_full_access,
        )
    )
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
        ),
        projection_policy=ProjectionPolicy.FOREGROUND_ONLY,
        extensions=GatewayExtensions(
            controller=controller,
            inbound_content_transformer=ImZenContentTransformer(),
            inbound_failure_presenter=ImZenFailurePresenter(),
            request_presenter=ImZenRequestPresenter(),
        ),
    )
    return gateway, gateway_state


def _build_app_server_client(settings: Settings) -> AppServerClient:
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
            None
            if settings.app_server_shared_filesystem_root is None
            else settings.app_server_shared_filesystem_root.is_dir
        ),
    )
