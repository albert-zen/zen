from __future__ import annotations

import json

import pytest

from imzen.channels import build_channels
from imzen.config import ConfigurationError


class FakeChannel:
    def __init__(self, channel_id: str, config: dict, channel_instance_id: str) -> None:
        self.channel_id = channel_id
        self.config = config
        self.channel_instance_id = channel_instance_id


def factory(channel_id: str, *, config: dict, channel_instance_id: str) -> FakeChannel:
    return FakeChannel(channel_id, config, channel_instance_id)


def test_enabled_channel_is_built_by_the_sdk_factory(tmp_path):
    config = tmp_path / "channels.json"
    config.write_text(
        json.dumps(
            {
                "qq": {
                    "enabled": True,
                    "allowed_user_ids": ["trusted"],
                    "app_id": "123",
                    "client_secret": "secret",
                }
            }
        ),
        encoding="utf-8",
    )

    channels = build_channels(config, factory=factory)

    assert len(channels) == 1
    channel = channels[0]
    assert channel.channel_id == "qq"
    assert channel.channel_instance_id == "qq"
    assert channel.config["app_id"] == "123"


def test_unknown_channel_fails_explicitly(tmp_path):
    config = tmp_path / "channels.json"
    config.write_text('{"unknown": {"enabled": true}}', encoding="utf-8")

    with pytest.raises(ConfigurationError, match="unknown IM channel"):
        build_channels(config, factory=factory)


def test_unrestricted_full_access_requires_explicit_unsafe_opt_in(tmp_path):
    config = tmp_path / "channels.json"
    config.write_text(
        json.dumps({"qq": {"enabled": True, "app_id": "123"}}),
        encoding="utf-8",
    )

    with pytest.raises(
        ConfigurationError,
        match="IMZEN_ALLOW_UNRESTRICTED_FULL_ACCESS=true",
    ):
        build_channels(config, factory=factory, permission_mode="full-access")


def test_explicit_unsafe_opt_in_allows_unrestricted_full_access(tmp_path):
    config = tmp_path / "channels.json"
    config.write_text(
        json.dumps({"qq": {"enabled": True, "app_id": "123"}}),
        encoding="utf-8",
    )

    channels = build_channels(
        config,
        factory=factory,
        permission_mode="full-access",
        allow_unrestricted_full_access=True,
    )

    assert len(channels) == 1


@pytest.mark.parametrize("allowlist_key", ["allowed_user_ids", "allowed_conversation_ids"])
def test_access_allowlist_allows_full_access_without_unsafe_opt_in(tmp_path, allowlist_key):
    config = tmp_path / "channels.json"
    config.write_text(
        json.dumps(
            {
                "qq": {
                    "enabled": True,
                    "app_id": "123",
                    allowlist_key: ["trusted"],
                }
            }
        ),
        encoding="utf-8",
    )

    assert len(build_channels(config, factory=factory)) == 1


def test_wildcard_access_value_remains_unrestricted(tmp_path):
    config = tmp_path / "channels.json"
    config.write_text(
        json.dumps({"qq": {"enabled": True, "allowed_user_ids": ["*"]}}),
        encoding="utf-8",
    )

    with pytest.raises(ConfigurationError, match="unrestricted channel: qq"):
        build_channels(config, factory=factory)


def test_disabled_unrestricted_channel_does_not_require_unsafe_opt_in(tmp_path):
    config = tmp_path / "channels.json"
    config.write_text(
        json.dumps({"qq": {"enabled": False, "app_id": "123"}}),
        encoding="utf-8",
    )

    assert build_channels(config, factory=factory) == []


def test_qq_credentials_are_loaded_from_an_imzen_owned_private_file(tmp_path):
    credentials = tmp_path / "qq.json"
    credentials.write_text(
        json.dumps({"appid": 123456789, "appsecret": "private-value"}),
        encoding="utf-8",
    )
    credentials.chmod(0o600)
    config = tmp_path / "channels.json"
    config.write_text(
        json.dumps(
            {
                "qq": {
                    "enabled": True,
                    "credentials_file": str(credentials),
                    "allowed_user_ids": ["none"],
                    "markdown_enabled": True,
                }
            }
        ),
        encoding="utf-8",
    )

    channels = build_channels(config, factory=factory)

    resolved = channels[0].config
    assert resolved["app_id"] == "123456789"
    assert resolved["client_secret"] == "private-value"
    assert resolved["allowed_user_ids"] == ["none"]
    assert resolved["markdown_enabled"] is True
    assert "credentials_file" not in resolved


def test_qq_credentials_file_must_be_private(tmp_path):
    credentials = tmp_path / "qq.json"
    credentials.write_text(
        json.dumps({"appid": 123456789, "appsecret": "private-value"}),
        encoding="utf-8",
    )
    credentials.chmod(0o644)
    config = tmp_path / "channels.json"
    config.write_text(
        json.dumps({"qq": {"enabled": True, "credentials_file": str(credentials)}}),
        encoding="utf-8",
    )

    with pytest.raises(ConfigurationError, match="must not be readable"):
        build_channels(config, factory=factory, permission_mode="approval-required")


def test_no_config_creates_no_channels():
    assert build_channels(None, factory=factory) == []
