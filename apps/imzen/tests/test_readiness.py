from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

# Loading the stdlib-only probe must not import imzen.__init__ or SDK adapters.
SCRIPT = Path(__file__).parents[1] / "src" / "imzen" / "readiness.py"
spec = importlib.util.spec_from_file_location("imzen_readiness_probe", SCRIPT)
assert spec is not None and spec.loader is not None
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)
SECRET = "private-credential-must-never-leave-probe"


@pytest.fixture
def deployment(tmp_path, monkeypatch):
    credential_file = tmp_path / "qq.json"
    credential_file.write_text(json.dumps({"appid": "12345", "appsecret": SECRET}))
    credential_file.chmod(0o600)
    config_file = tmp_path / "channels.json"
    config_file.write_text(
        json.dumps(
            {"qq": {"enabled": True, "credentials_file": "qq.json", "allowed_user_ids": ["123"]}}
        )
    )

    class Distribution:
        def read_text(self, filename):
            assert filename == "direct_url.json"
            return json.dumps(
                {
                    "url": readiness.SDK_REPOSITORY,
                    "vcs_info": {"vcs": "git", "commit_id": readiness.SDK_REVISION},
                }
            )

    monkeypatch.setattr(readiness.importlib.metadata, "distribution", lambda name: Distribution())
    monkeypatch.setattr(readiness.sys, "version_info", (3, 13, 5))
    return {
        "cwd": str(tmp_path),
        "channelsConfigFile": str(config_file),
        "permissionMode": "approval-required",
    }


def test_owned_config_and_relative_qq_reference_are_checked_without_secret_output(deployment):
    result = readiness.inspect(deployment)
    assert result == {
        "codes": [
            "python_ready",
            "sdk_ready",
            "workspace_ready",
            "channels_ready",
            "allowlist_ready",
            "credentials_ready",
        ],
        "enabledChannels": ["qq"],
    }
    assert SECRET not in json.dumps(result)
    assert "12345" not in json.dumps(result)


def test_only_explicit_owned_files_are_opened(deployment, monkeypatch):
    opened = []
    original = Path.open

    def tracked_open(path, *args, **kwargs):
        opened.append(path)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", tracked_open)
    readiness.inspect(deployment)
    root = Path(deployment["cwd"])
    assert opened == [root / "channels.json", root / "qq.json"]


def test_absolute_qq_reference_remains_supported(deployment):
    file = Path(deployment["channelsConfigFile"])
    value = json.loads(file.read_text())
    value["qq"]["credentials_file"] = str(file.parent / "qq.json")
    file.write_text(json.dumps(value))
    assert "credentials_ready" in readiness.inspect(deployment)["codes"]


@pytest.mark.parametrize("allowlist", [[], ["*"], "*,\n", None])
def test_wildcard_or_empty_allowlist_blocks_unopted_full_access(deployment, allowlist):
    file = Path(deployment["channelsConfigFile"])
    value = json.loads(file.read_text())
    value["qq"]["allowed_user_ids"] = allowlist
    file.write_text(json.dumps(value))
    deployment["permissionMode"] = "full-access"
    assert "allowlist_required" in readiness.inspect(deployment)["codes"]
    deployment["allowUnrestrictedFullAccess"] = True
    assert "allowlist_unrestricted" in readiness.inspect(deployment)["codes"]


def test_user_and_conversation_allowlist_match_existing_contract(deployment):
    file = Path(deployment["channelsConfigFile"])
    value = json.loads(file.read_text())
    value["qq"].pop("allowed_user_ids")
    value["qq"]["allowed_conversation_ids"] = "conversation-id"
    file.write_text(json.dumps(value))
    deployment["permissionMode"] = "full-access"
    assert "allowlist_ready" in readiness.inspect(deployment)["codes"]


@pytest.mark.parametrize(
    "payload", [[], {"legacy-secret-channel": {}}, {"qq": []}, {"qq": {"enabled": "true"}}]
)
def test_invalid_selected_config_never_returns_parser_or_file_contents(deployment, payload):
    Path(deployment["channelsConfigFile"]).write_text(json.dumps(payload))
    result = readiness.inspect(deployment)
    assert "channels_invalid" in result["codes"]
    assert "legacy-secret-channel" not in json.dumps(result)


def test_invalid_private_credentials_remain_a_fixed_error(deployment):
    file = Path(deployment["cwd"]) / "qq.json"
    file.write_text('{"appid":' + SECRET)
    result = readiness.inspect(deployment)
    assert "credentials_invalid" in result["codes"]
    assert SECRET not in json.dumps(result)


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission evidence")
def test_private_credential_file_permissions_are_checked(deployment):
    (Path(deployment["cwd"]) / "qq.json").chmod(0o644)
    assert "credentials_private_file_required" in readiness.inspect(deployment)["codes"]


def test_qq_credential_symlink_is_rejected(deployment):
    root = Path(deployment["cwd"])
    credential = root / "qq.json"
    credential.rename(root / "target.json")
    credential.symlink_to(root / "target.json")
    assert "credentials_private_file_required" in readiness.inspect(deployment)["codes"]


def test_qq_file_contract_rejects_inline_credential_overlap(deployment):
    file = Path(deployment["channelsConfigFile"])
    value = json.loads(file.read_text())
    value["qq"]["client_secret"] = SECRET
    file.write_text(json.dumps(value))
    result = readiness.inspect(deployment)
    assert "credentials_invalid" in result["codes"]
    assert SECRET not in json.dumps(result)


def test_existing_native_qq_fields_are_checked_privately(deployment):
    file = Path(deployment["channelsConfigFile"])
    value = json.loads(file.read_text())
    value["qq"].pop("credentials_file")
    value["qq"].update(app_id="12345", client_secret=SECRET)
    file.write_text(json.dumps(value))
    assert "credentials_ready" in readiness.inspect(deployment)["codes"]


def test_sdk_missing_and_unverified_are_distinct(deployment, monkeypatch):
    def absent(name):
        raise importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(readiness.importlib.metadata, "distribution", absent)
    assert "sdk_missing" in readiness.inspect(deployment)["codes"]

    class UnknownDistribution:
        def read_text(self, filename):
            return json.dumps({"url": "https://untrusted.invalid/" + SECRET})

    monkeypatch.setattr(
        readiness.importlib.metadata, "distribution", lambda name: UnknownDistribution()
    )
    result = readiness.inspect(deployment)
    assert "sdk_unverified" in result["codes"]
    assert SECRET not in json.dumps(result)


def test_unsupported_python_missing_workspace_and_shared_root_are_reported(deployment, monkeypatch):
    monkeypatch.setattr(readiness.sys, "version_info", (3, 12, 0))
    deployment["cwd"] += "/missing"
    deployment["sharedFilesystemRoot"] = deployment["cwd"]
    codes = readiness.inspect(deployment)["codes"]
    assert "python_unsupported" in codes
    assert "workspace_missing" in codes
    assert "shared_filesystem_missing" in codes


def test_no_gateway_sdk_imports_or_transport_construction():
    source = SCRIPT.read_text()
    assert "from imagent" not in source
    assert "import imagent" not in source
    assert "build_channels(" not in source
    assert "create_gateway(" not in source
    assert "gateway.start(" not in source


def test_process_output_contains_only_fixed_codes_and_channel_names(deployment):
    result = subprocess.run(
        [sys.executable, "-I", "-B", str(SCRIPT)],
        input=json.dumps(deployment) + "\n",
        capture_output=True,
        text=True,
        check=True,
    )
    parsed = json.loads(result.stdout)
    assert set(parsed) == {"codes", "enabledChannels"}
    assert result.stderr == ""
    assert SECRET not in result.stdout
    assert "12345" not in result.stdout
    assert parsed["enabledChannels"] == ["qq"]


def test_malformed_process_request_has_no_exception_or_secret_diagnostics():
    result = subprocess.run(
        [sys.executable, "-I", "-B", str(SCRIPT)],
        input=SECRET + "\n",
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(result.stdout) == {"codes": ["probe_failed"], "enabledChannels": []}
    assert result.stderr == ""


def test_managed_summary_skips_marker_and_never_reads_channels_or_credentials(
    deployment, monkeypatch
):
    def unexpected_read(_path):
        raise AssertionError("Managed marker files must not be read by the runtime probe")

    monkeypatch.setattr(readiness, "_json_file", unexpected_read)
    deployment["skipChannelsInspection"] = True
    result = readiness.inspect(deployment)
    assert result == {
        "codes": ["python_ready", "sdk_ready", "workspace_ready"],
        "enabledChannels": [],
    }


def test_managed_feishu_runtime_extra_is_checked_without_credentials(deployment, monkeypatch):
    original = readiness.importlib.metadata.distribution

    def without_feishu(name):
        if name == "lark-channel-sdk":
            raise importlib.metadata.PackageNotFoundError(name)
        return original(name)

    monkeypatch.setattr(readiness.importlib.metadata, "distribution", without_feishu)
    deployment["skipChannelsInspection"] = True
    deployment["requiredChannels"] = ["feishu"]
    assert "feishu_missing" in readiness.inspect(deployment)["codes"]


def test_sdk_wildcard_dimension_semantics_are_used_in_file_readiness(deployment):
    file = Path(deployment["channelsConfigFile"])
    config = json.loads(file.read_text())
    config["qq"]["allowed_user_ids"] = ["*", "trusted"]
    deployment["permissionMode"] = "full-access"
    file.write_text(json.dumps(config))
    assert "allowlist_required" in readiness.inspect(deployment)["codes"]
    config["qq"]["allowed_user_ids"] = ["*"]
    config["qq"]["allowed_conversation_ids"] = ["chat:1"]
    config["qq"]["access_match"] = "any"
    file.write_text(json.dumps(config))
    assert "allowlist_ready" in readiness.inspect(deployment)["codes"]


@pytest.mark.parametrize(
    "policy", [{"access_match": "invalid"}, {"allowed_user_ids": ["none", "trusted"]}]
)
def test_invalid_access_policy_is_blocked_without_echoing_policy(deployment, policy):
    file = Path(deployment["channelsConfigFile"])
    config = json.loads(file.read_text())
    config["qq"].update(policy)
    file.write_text(json.dumps(config))
    result = readiness.inspect(deployment)
    assert "channels_invalid" in result["codes"]
    assert "channels_ready" not in result["codes"]
