from __future__ import annotations

import asyncio
import signal

from imagent import Gateway, GatewayExtensions, GatewayLimits, ProjectionPolicy, SQLiteGatewayStore
from imagent.applications import ZenApplicationAdapter
from imagent.applications.adapters.appserver.client import AppServerClient, AppServerSupervisor

from .channels import build_channels
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
    client = _build_app_server_client(resolved)
    application = ZenApplicationAdapter(
        application_instance_id="zen-main",
        client=client,
        workspace_id="imzen-workspace",
        cwd=str(resolved.cwd),
        shared_filesystem_root=resolved.app_server_shared_filesystem_root,
        thread_start_options=thread_start_options(resolved.permission_mode),
    )
    controller = ImZenController(
        application=application,
        client=client,
        default_permission_mode=resolved.permission_mode,
    )
    gateway = Gateway(
        gateway_id="imzen",
        channels=build_channels(
            resolved.channels_config_file,
            permission_mode=resolved.permission_mode,
            allow_unrestricted_full_access=resolved.allow_unrestricted_full_access,
        ),
        applications=[application],
        store=SQLiteGatewayStore(resolved.gateway_state_file),
        controller=controller,
        projection_policy=ProjectionPolicy.FOREGROUND_ONLY,
        limits=GatewayLimits(
            delivery_submission_max_records=4096,
            conversation_serialization_max_active_keys=4096,
            idempotency_max_records=4096,
            projection_max_active_threads=4096,
        ),
        extensions=GatewayExtensions(
            inbound_content_transformer=ImZenContentTransformer(),
            inbound_failure_presenter=ImZenFailurePresenter(),
            request_presenter=ImZenRequestPresenter(),
        ),
    )
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
        if gateway_started:
            await gateway.stop()


def _build_app_server_client(settings: Settings) -> AppServerClient:
    supervisor = AppServerSupervisor(
        app_server_url=settings.app_server_url,
        app_server_auth_token_file=settings.app_server_auth_token_file,
    )
    return AppServerClient(
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
