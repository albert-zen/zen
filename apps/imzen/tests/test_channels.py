from __future__ import annotations

import json
import os
from pathlib import PureWindowsPath

import pytest

from imzen.channels import build_channels, shared_media_root
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


def test_qq_credentials_file_uses_platform_permission_evidence(tmp_path):
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

    if os.name == "nt":
        channels = build_channels(config, factory=factory, permission_mode="approval-required")
        assert channels[0].config["client_secret"] == "private-value"
    else:
        with pytest.raises(ConfigurationError, match="must not be readable"):
            build_channels(config, factory=factory, permission_mode="approval-required")


def test_no_config_creates_no_channels():
    assert build_channels(None, factory=factory) == []


def test_host_owned_in_memory_config_bypasses_file_read_and_uses_sdk_factory(tmp_path, monkeypatch):
    def unexpected_read(_path):
        raise AssertionError("Managed configuration must not read the marker file")

    monkeypatch.setattr("imzen.channels._load_config", unexpected_read)
    channels = build_channels(
        tmp_path / "owned-managed-reference.json",
        channel_config={
            "qq": {
                "enabled": True,
                "app_id": "12345",
                "client_secret": "host-private-value",
                "allowed_user_ids": ["trusted"],
            }
        },
        factory=factory,
    )
    assert len(channels) == 1
    assert channels[0].config["client_secret"] == "host-private-value"
    assert channels[0].channel_instance_id == "qq"


def test_managed_config_keeps_existing_full_access_guard(tmp_path):
    with pytest.raises(ConfigurationError, match="unrestricted channel"):
        build_channels(
            tmp_path / "marker.json",
            channel_config={"qq": {"enabled": True, "app_id": "123", "client_secret": "secret"}},
            factory=factory,
        )


def test_wildcard_with_real_ids_in_one_dimension_is_still_unrestricted(tmp_path):
    config = tmp_path / "channels.json"
    config.write_text(json.dumps({"qq": {"enabled": True, "allowed_user_ids": ["*", "trusted"]}}))
    with pytest.raises(ConfigurationError, match="unrestricted channel"):
        build_channels(config, factory=factory)


def test_wildcard_user_dimension_does_not_remove_conversation_restriction(tmp_path):
    config = tmp_path / "channels.json"
    config.write_text(
        json.dumps(
            {
                "qq": {
                    "enabled": True,
                    "allowed_user_ids": ["*"],
                    "allowed_conversation_ids": ["chat:1"],
                    "access_match": "any",
                }
            }
        )
    )
    assert len(build_channels(config, factory=factory)) == 1


def test_shared_media_root_does_not_attest_undeclared_common_ancestor(tmp_path):
    first = tmp_path / "one" / "inbound-media"
    second = tmp_path / "two" / "inbound-media"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    config = {
        "qq": {"enabled": True, "media_dir": str(first)},
        "telegram": {"enabled": True, "media_dir": str(second)},
    }

    derived = shared_media_root(config, process_cwd=tmp_path)

    assert derived is None


def test_shared_media_root_is_the_single_channel_media_directory(tmp_path):
    media = tmp_path / "inbound-media"
    media.mkdir()

    derived = shared_media_root(
        {"qq": {"enabled": True, "media_dir": str(media)}},
        process_cwd=tmp_path,
    )

    assert derived == media.resolve()


def test_shared_media_root_is_none_without_enabled_channels(tmp_path):
    assert shared_media_root(None, process_cwd=tmp_path) is None
    assert shared_media_root({}, process_cwd=tmp_path) is None
    assert shared_media_root({"qq": {"enabled": False}}, process_cwd=tmp_path) is None
    assert shared_media_root({"qq": {"enabled": True}}, process_cwd=tmp_path) is None


@pytest.mark.parametrize("name", [" inbound-media ", " "])
def test_shared_media_root_preserves_qq_path_whitespace(tmp_path, monkeypatch, name):
    from imagent.channels.native.qq import QQChannelAdapter

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("imagent.channels.native.qq.httpx.AsyncClient", lambda **kwargs: object())
    config = {"enabled": True, "media_dir": name, "app_id": "123", "client_secret": "synthetic"}
    native = QQChannelAdapter.from_config(config=config, middleware=None)

    assert shared_media_root({"qq": config}, process_cwd=tmp_path) == native.media_materializer.root


@pytest.mark.parametrize("reverse", [False, True])
def test_shared_media_root_selects_a_declared_parent(tmp_path, reverse):
    roots = [tmp_path / "media", tmp_path / "media" / "nested"]
    if reverse:
        roots.reverse()
    config = {
        channel: {"enabled": True, "media_dir": str(root)}
        for channel, root in zip(("qq", "telegram"), roots, strict=True)
    }
    assert shared_media_root(config, process_cwd=tmp_path) == tmp_path / "media"


def test_shared_media_root_does_not_attest_posix_root(tmp_path):
    if os.name == "nt":
        pytest.skip("POSIX path semantics")
    assert (
        shared_media_root(
            {
                "qq": {"enabled": True, "media_dir": "/tmp/qq-media"},
                "telegram": {"enabled": True, "media_dir": "/var/cache/tg-media"},
            },
            process_cwd=tmp_path,
        )
        is None
    )


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [
        ("C:/qq/media", "C:/telegram/media", None),
        ("C:/qq/media", "D:/qq/media", None),
        ("C:/qq/media", "C:/qq/media/nested", "C:/qq/media"),
        ("C:/qq/media", "c:/QQ/media", "C:/qq/media"),
        ("//host/share/qq", "//host/other/qq", None),
    ],
)
def test_shared_media_root_windows_path_semantics(monkeypatch, first, second, expected):
    # Exercise the selector with Windows canonical paths without claiming a
    # native Windows filesystem run on POSIX. No directory is accessed here.
    class ResolvedWindowsPath(PureWindowsPath):
        def expanduser(self):
            return self

        def resolve(self):
            return self

    monkeypatch.setattr("imzen.channels.Path", ResolvedWindowsPath)
    result = shared_media_root(
        {
            "qq": {"enabled": True, "media_dir": first},
            "telegram": {"enabled": True, "media_dir": second},
        },
        process_cwd=ResolvedWindowsPath("C:/workspace"),
    )
    assert result == (None if expected is None else ResolvedWindowsPath(expected))


def test_shared_media_root_resolves_aliases_without_widening(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    alias = tmp_path / "alias"
    try:
        alias.symlink_to(media, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks unavailable")
    assert (
        shared_media_root(
            {
                "qq": {"enabled": True, "media_dir": str(media)},
                "telegram": {"enabled": True, "media_dir": str(alias)},
            },
            process_cwd=tmp_path,
        )
        == media
    )


@pytest.mark.parametrize("name", [" inbound-media ", " "])
def test_shared_media_root_matches_telegram_path_normalization(tmp_path, monkeypatch, name):
    from imagent.channels.native.telegram import TelegramChannelAdapter

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        "imagent.channels.native.telegram.httpx.AsyncClient", lambda **kwargs: object()
    )
    config = {"enabled": True, "media_dir": name, "bot_token": "synthetic"}
    native = TelegramChannelAdapter.from_config(config=config, middleware=None)

    derived = shared_media_root({"telegram": config}, process_cwd=tmp_path)
    # An empty normalized value uses the SDK default, which is not attested.
    assert derived == (native.media_materializer.root if name.strip() else None)
