from __future__ import annotations

import asyncio
import signal

from .channels import build_channel_runtime
from .config import Settings
from .middleware import ImZenMiddleware


async def run(settings: Settings | None = None) -> None:
    resolved = settings or Settings.from_env()
    client = _build_app_server_client(resolved)
    middleware = ImZenMiddleware(client=client, default_cwd=str(resolved.cwd))
    channels = build_channel_runtime(resolved.channels_config_file, middleware)
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

    middleware_started = False
    channels_started = False
    try:
        middleware_started = True
        await middleware.start()
        await channels.start()
        channels_started = True
        await stop.wait()
    finally:
        for registered in registered_signals:
            loop.remove_signal_handler(registered)
        errors: list[BaseException] = []
        if channels_started:
            try:
                await channels.stop()
            except BaseException as exc:
                errors.append(exc)
        if middleware_started:
            try:
                await middleware.stop()
            except BaseException as exc:
                errors.append(exc)
        if errors:
            raise BaseExceptionGroup("IMZen shutdown failed", errors)


def _build_app_server_client(settings: Settings):
    try:
        from imcodex.appserver import AppServerClient, AppServerSupervisor
    except ImportError as exc:
        raise RuntimeError("the pinned imcodex dependency is not installed") from exc
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
