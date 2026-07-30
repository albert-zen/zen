from __future__ import annotations

import pytest

from imzen.config import ConfigurationError, Settings


def test_settings_accept_loopback_websocket(tmp_path):
    settings = Settings.from_env(
        {
            "IMZEN_APP_SERVER_URL": "ws://127.0.0.1:4500",
            "IMZEN_CWD": str(tmp_path),
        }
    )

    assert settings.app_server_url == "ws://127.0.0.1:4500"
    assert settings.cwd == tmp_path.resolve()
    assert settings.permission_mode == "full-access"
    assert settings.allow_unrestricted_full_access is False


def test_settings_accept_approval_required_permission_mode(tmp_path):
    settings = Settings.from_env(
        {
            "IMZEN_APP_SERVER_URL": "ws://127.0.0.1:4500",
            "IMZEN_CWD": str(tmp_path),
            "IMZEN_PERMISSION_MODE": "approval-required",
        }
    )

    assert settings.permission_mode == "approval-required"


def test_settings_reject_unknown_permission_mode(tmp_path):
    with pytest.raises(ConfigurationError, match="IMZEN_PERMISSION_MODE"):
        Settings.from_env(
            {
                "IMZEN_APP_SERVER_URL": "ws://127.0.0.1:4500",
                "IMZEN_CWD": str(tmp_path),
                "IMZEN_PERMISSION_MODE": "unsafe",
            }
        )


def test_settings_accept_explicit_unrestricted_full_access_opt_in(tmp_path):
    settings = Settings.from_env(
        {
            "IMZEN_APP_SERVER_URL": "ws://127.0.0.1:4500",
            "IMZEN_CWD": str(tmp_path),
            "IMZEN_ALLOW_UNRESTRICTED_FULL_ACCESS": "true",
        }
    )

    assert settings.allow_unrestricted_full_access is True


def test_settings_reject_ambiguous_unrestricted_full_access_opt_in(tmp_path):
    with pytest.raises(
        ConfigurationError,
        match="IMZEN_ALLOW_UNRESTRICTED_FULL_ACCESS",
    ):
        Settings.from_env(
            {
                "IMZEN_APP_SERVER_URL": "ws://127.0.0.1:4500",
                "IMZEN_CWD": str(tmp_path),
                "IMZEN_ALLOW_UNRESTRICTED_FULL_ACCESS": "yes",
            }
        )


def test_settings_reject_remote_cleartext_websocket(tmp_path):
    with pytest.raises(ConfigurationError, match="loopback"):
        Settings.from_env(
            {
                "IMZEN_APP_SERVER_URL": "ws://example.com/app-server",
                "IMZEN_CWD": str(tmp_path),
            }
        )


def test_settings_reject_credentials_in_url(tmp_path):
    with pytest.raises(ConfigurationError, match="must not contain credentials"):
        Settings.from_env(
            {
                "IMZEN_APP_SERVER_URL": "wss://user:secret@example.com/app-server",
                "IMZEN_CWD": str(tmp_path),
            }
        )
