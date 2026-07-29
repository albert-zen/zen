from __future__ import annotations

import json

import pytest

from imzen.channels import build_channel_runtime
from imzen.config import ConfigurationError


class FakeMiddleware:
    def __init__(self) -> None:
        self.adapters = []

    def register_adapter(self, adapter) -> None:
        self.adapters.append(adapter)


class FakeChannel:
    channel_id = "fake"

    def __init__(self, config, middleware) -> None:
        self.config = config
        self.middleware = middleware
        self.validated = False
        self.started = False
        self.stopped = False

    @classmethod
    def from_config(cls, *, config, middleware):
        return cls(config, middleware)

    def validate_startup_configuration(self) -> None:
        self.validated = True

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True


@pytest.mark.asyncio
async def test_enabled_channel_is_built_started_and_stopped_without_network(tmp_path):
    config = tmp_path / "channels.json"
    config.write_text(
        json.dumps({"fake": {"enabled": True, "credential": "not-used"}}),
        encoding="utf-8",
    )
    middleware = FakeMiddleware()

    runtime = build_channel_runtime(
        config,
        middleware,
        registry={"fake": FakeChannel},
    )
    await runtime.start()

    assert len(runtime.adapters) == 1
    adapter = runtime.adapters[0]
    assert adapter.config["credential"] == "not-used"
    assert adapter.validated is True
    assert adapter.started is True
    assert middleware.adapters == [adapter]

    await runtime.stop()
    assert adapter.stopped is True


def test_unknown_channel_fails_explicitly(tmp_path):
    config = tmp_path / "channels.json"
    config.write_text('{"unknown": {"enabled": true}}', encoding="utf-8")

    with pytest.raises(ConfigurationError, match="unknown IM channel"):
        build_channel_runtime(
            config,
            FakeMiddleware(),
            registry={"fake": FakeChannel},
        )


def test_no_config_creates_empty_runtime():
    middleware = FakeMiddleware()

    runtime = build_channel_runtime(None, middleware, registry={"fake": FakeChannel})

    assert runtime.adapters == []
    assert middleware.adapters == []
