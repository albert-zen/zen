from __future__ import annotations

import pytest

from imzen.config import ConfigurationError, Settings


def test_settings_accept_loopback_websocket(tmp_path):
    settings = Settings.from_env(
        {
            "IMZEN_APP_SERVER_URL": "ws://127.0.0.1:8765",
            "IMZEN_CWD": str(tmp_path),
        }
    )

    assert settings.app_server_url == "ws://127.0.0.1:8765"
    assert settings.cwd == tmp_path.resolve()


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
