from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit


class ConfigurationError(ValueError):
    pass


PermissionMode = Literal["full-access", "approval-required"]


@dataclass(frozen=True, slots=True)
class Settings:
    app_server_url: str
    cwd: Path
    permission_mode: PermissionMode = "full-access"
    channels_config_file: Path | None = None
    app_server_auth_token_file: Path | None = None

    @classmethod
    def from_env(
        cls,
        env: dict[str, str] | None = None,
        *,
        process_cwd: Path | None = None,
    ) -> Settings:
        values = os.environ if env is None else env
        app_server_url = _validate_app_server_url(
            _required(values.get("IMZEN_APP_SERVER_URL"), "IMZEN_APP_SERVER_URL")
        )
        cwd = Path(values.get("IMZEN_CWD") or process_cwd or Path.cwd()).expanduser()
        try:
            cwd = cwd.resolve(strict=True)
        except OSError as exc:
            raise ConfigurationError(f"IMZEN_CWD does not exist: {cwd}") from exc
        if not cwd.is_dir():
            raise ConfigurationError(f"IMZEN_CWD is not a directory: {cwd}")

        channels_file = _optional_path(values.get("IMZEN_CHANNELS_CONFIG_FILE"))
        token_file = _optional_path(values.get("IMZEN_APP_SERVER_AUTH_TOKEN_FILE"))
        permission_mode = _permission_mode(values.get("IMZEN_PERMISSION_MODE"))
        return cls(
            app_server_url=app_server_url,
            cwd=cwd,
            permission_mode=permission_mode,
            channels_config_file=channels_file,
            app_server_auth_token_file=token_file,
        )


def _required(value: str | None, name: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ConfigurationError(f"{name} is required")
    return normalized


def _optional_path(value: str | None) -> Path | None:
    normalized = str(value or "").strip()
    return Path(normalized).expanduser().resolve() if normalized else None


def _permission_mode(value: str | None) -> PermissionMode:
    normalized = str(value or "full-access").strip().casefold()
    if normalized not in {"full-access", "approval-required"}:
        raise ConfigurationError("IMZEN_PERMISSION_MODE must be full-access or approval-required")
    return normalized  # type: ignore[return-value]


def _validate_app_server_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"ws", "wss"} or not parsed.netloc:
        raise ConfigurationError("IMZEN_APP_SERVER_URL must use ws:// or wss://")
    if parsed.username is not None or parsed.password is not None:
        raise ConfigurationError(
            "IMZEN_APP_SERVER_URL must not contain credentials; use the token file"
        )
    if parsed.query or parsed.fragment:
        raise ConfigurationError("IMZEN_APP_SERVER_URL must not contain a query or fragment")
    if parsed.scheme == "ws" and not _is_loopback(parsed.hostname or ""):
        raise ConfigurationError("unencrypted ws:// is allowed only on loopback")
    return value


def _is_loopback(host: str) -> bool:
    if host.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False
