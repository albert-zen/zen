from __future__ import annotations

import asyncio
import signal

from imagent.applications import ZenApplicationAdapter
from imagent.applications.appserver_client import AppServerClient, AppServerSupervisor
from imagent.bindings import InMemoryBindingRepository
from imagent.contracts import ProjectionPolicy
from imagent.gateway import ImAgentGateway

from .channels import build_channels
from .config import Settings
from .controller import (
    ImZenController,
    ImZenFailurePresenter,
    ImZenRequestPresenter,
    adapt_inbound_content,
    thread_start_options,
)


async def run(settings: Settings | None = None) -> None:
    resolved = settings or Settings.from_env()
    client = _build_app_server_client(resolved)
    application = ZenApplicationAdapter(
        application_instance_id="zen-main",
        client=client,
        cwd=str(resolved.cwd),
        shared_filesystem_root=resolved.cwd,
        thread_start_options=thread_start_options(resolved.permission_mode),
    )
    controller = ImZenController(
        application=application,
        client=client,
        default_permission_mode=resolved.permission_mode,
    )
    gateway = ImAgentGateway(
        channels=build_channels(
            resolved.channels_config_file,
            permission_mode=resolved.permission_mode,
            allow_unrestricted_full_access=resolved.allow_unrestricted_full_access,
        ),
        applications=[application],
        bindings=InMemoryBindingRepository(),
        projection_policy=ProjectionPolicy.FOREGROUND_ONLY,
        controller=controller,
        content_adapter=adapt_inbound_content,
        inbound_failure_presenter=ImZenFailurePresenter(),
        request_presenter=ImZenRequestPresenter(),
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
    )
