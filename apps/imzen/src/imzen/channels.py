from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

from .config import ConfigurationError, PermissionMode


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
    permission_mode: PermissionMode = "full-access",
    allow_unrestricted_full_access: bool = False,
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
        if (
            permission_mode == "full-access"
            and not allow_unrestricted_full_access
            and not _has_access_restriction(channel_config)
        ):
            raise ConfigurationError(
                "IMZEN_ALLOW_UNRESTRICTED_FULL_ACCESS=true is required when "
                f"IMZEN_PERMISSION_MODE=full-access enables unrestricted channel: {channel_id}"
            )
        resolved_config = _resolve_channel_config(
            channel_id,
            channel_config,
            config_directory=config_file.parent,
        )
        adapters.append(adapter_type.from_config(config=resolved_config, middleware=middleware))
    return ChannelRuntime(adapters, middleware)


def _has_access_restriction(config: dict[str, Any]) -> bool:
    for key in ("allowed_user_ids", "allowed_conversation_ids"):
        value = config.get(key)
        if isinstance(value, str):
            candidates = value.replace("\n", ",").split(",")
        elif isinstance(value, (list, tuple, set, frozenset)):
            candidates = value
        elif value is None:
            candidates = ()
        else:
            candidates = (value,)
        if any(str(candidate).strip() not in {"", "*"} for candidate in candidates):
            return True
    return False


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


def _resolve_channel_config(
    channel_id: str,
    config: dict[str, Any],
    *,
    config_directory: Path,
) -> dict[str, Any]:
    resolved = dict(config)
    if channel_id != "qq" or "credentials_file" not in resolved:
        return resolved
    if "app_id" in resolved or "client_secret" in resolved:
        raise ConfigurationError(
            "qq credentials_file cannot be combined with app_id or client_secret"
        )
    raw_path = resolved.pop("credentials_file")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ConfigurationError("qq credentials_file must be a non-empty path")
    credential_path = Path(raw_path).expanduser()
    if not credential_path.is_absolute():
        credential_path = config_directory / credential_path
    credentials = _load_qq_credentials(credential_path)
    resolved["app_id"] = credentials["app_id"]
    resolved["client_secret"] = credentials["client_secret"]
    return resolved


def _load_qq_credentials(path: Path) -> dict[str, str]:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise ConfigurationError(f"unable to inspect QQ credentials file: {path}") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ConfigurationError("QQ credentials path must be a regular non-symlink file")
    if os.name != "nt" and metadata.st_mode & 0o077:
        raise ConfigurationError("QQ credentials file must not be readable by group or others")
    if os.name != "nt" and hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise ConfigurationError("QQ credentials file must be owned by the current user")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigurationError(f"unable to read QQ credentials file: {path}") from exc
    if not isinstance(value, dict) or set(value) != {"appid", "appsecret"}:
        raise ConfigurationError("QQ credentials file must contain only appid and appsecret")
    app_id = str(value.get("appid") or "").strip()
    client_secret = str(value.get("appsecret") or "").strip()
    if not app_id.isdecimal() or not client_secret:
        raise ConfigurationError(
            "QQ credentials file requires a decimal appid and non-empty appsecret"
        )
    return {"app_id": app_id, "client_secret": client_secret}
