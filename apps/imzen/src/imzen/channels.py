from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import ConfigurationError


class ChannelRuntime:
    def __init__(self, adapters: list[Any], middleware: Any) -> None:
        self.adapters = adapters
        self.middleware = middleware
        for adapter in adapters:
            middleware.register_adapter(adapter)

    async def start(self) -> None:
        started: list[Any] = []
        try:
            for adapter in self.adapters:
                adapter.validate_startup_configuration()
                await adapter.start()
                started.append(adapter)
        except BaseException:
            for adapter in reversed(started):
                try:
                    await adapter.stop()
                except BaseException:
                    pass
            raise

    async def stop(self) -> None:
        errors: list[BaseException] = []
        for adapter in reversed(self.adapters):
            try:
                await adapter.stop()
            except BaseException as exc:
                errors.append(exc)
        if errors:
            raise BaseExceptionGroup("one or more IM channels failed to stop", errors)


def build_channel_runtime(
    config_file: Path | None,
    middleware: Any,
    *,
    registry: dict[str, type] | None = None,
) -> ChannelRuntime:
    if config_file is None:
        return ChannelRuntime([], middleware)
    adapters_by_id = registry or _default_registry()
    config = _load_config(config_file)
    unknown = sorted(set(config) - set(adapters_by_id))
    if unknown:
        raise ConfigurationError(f"unknown IM channel: {', '.join(unknown)}")

    adapters: list[Any] = []
    for channel_id, adapter_type in adapters_by_id.items():
        channel_config = config.get(channel_id)
        if not isinstance(channel_config, dict) or channel_config.get("enabled") is not True:
            continue
        adapters.append(adapter_type.from_config(config=channel_config, middleware=middleware))
    return ChannelRuntime(adapters, middleware)


def _default_registry() -> dict[str, type]:
    try:
        from imcodex.channels import (
            FeishuChannelAdapter,
            QQChannelAdapter,
            TelegramChannelAdapter,
            WeixinChannelAdapter,
        )
    except ImportError as exc:
        raise ConfigurationError(
            "the pinned imcodex dependency is required to enable real IM channels"
        ) from exc
    return {
        "qq": QQChannelAdapter,
        "telegram": TelegramChannelAdapter,
        "feishu": FeishuChannelAdapter,
        "weixin": WeixinChannelAdapter,
    }


def _load_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigurationError(f"unable to read channel config: {path}") from exc
    if not isinstance(value, dict):
        raise ConfigurationError("channel config must be a JSON object")
    return value
