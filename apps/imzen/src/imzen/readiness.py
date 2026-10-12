"""Read only explicitly selected IMZen deployment files, never start a transport.

Executed by absolute script path, not ``-m imzen``: importing the composition
package imports the SDK. Only fixed codes and supported channel names leave this
process. File contents, credential values and exception text never do.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

SDK_REVISION = "7d5f1179365679d0f95abd5cb2ce76547238d05f"
SDK_REPOSITORY = "https://github.com/albert-zen/im-agent-sdk.git"
CHANNELS = ("qq", "telegram", "feishu", "weixin")
MAX_FILE_BYTES = 1024 * 1024


def _json_file(path: Path) -> Any:
    # Read exactly the selected file or an explicit credential-file reference.
    # No globbing, home-directory fallback or legacy-app discovery.
    with path.open("rb") as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("file size limit")
    return json.loads(data)


def _access_ids(value: Any) -> set[str]:
    if isinstance(value, str):
        candidates = value.replace("\n", ",").split(",")
    elif isinstance(value, (list, tuple, set, frozenset, dict)):
        candidates = value
    elif value is None:
        candidates = ()
    else:
        candidates = (value,)
    return {text for candidate in candidates if (text := str(candidate).strip())}


def _restricted(config: dict[str, Any]) -> bool:
    # Verified against pinned imagent/channels/native/access.py. This stdlib
    # inspection deliberately does not import SDK modules or create adapters.
    match = str(config.get("access_match") or "any").strip().lower()
    if match not in {"any", "all"}:
        raise ValueError("invalid access match")
    users = _access_ids(config.get("allowed_user_ids"))
    conversations = _access_ids(config.get("allowed_conversation_ids"))
    all_ids = users | conversations
    if "none" in all_ids:
        if all_ids != {"none"}:
            raise ValueError("invalid deny-all policy")
        return True
    return (bool(users) and "*" not in users) or (bool(conversations) and "*" not in conversations)


def _qq_credentials(config: dict[str, Any], directory: Path) -> str:
    if "credentials_file" not in config:
        # Existing IMZen also accepts SDK-native QQ fields. They remain private.
        app_id = str(config.get("app_id") or "").strip()
        secret = str(config.get("client_secret") or "").strip()
        return "credentials_ready" if app_id and secret else "credentials_invalid"
    if "app_id" in config or "client_secret" in config:
        return "credentials_invalid"
    raw_path = config["credentials_file"]
    if not isinstance(raw_path, str) or not raw_path.strip():
        return "credentials_invalid"
    credential_path = Path(raw_path).expanduser()
    if not credential_path.is_absolute():
        credential_path = directory / credential_path
    try:
        metadata = credential_path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            return "credentials_private_file_required"
        if os.name != "nt" and (
            metadata.st_mode & 0o077 or (hasattr(os, "getuid") and metadata.st_uid != os.getuid())
        ):
            return "credentials_private_file_required"
        value = _json_file(credential_path)
        if not isinstance(value, dict) or set(value) != {"appid", "appsecret"}:
            return "credentials_invalid"
        app_id = str(value.get("appid") or "").strip()
        secret = str(value.get("appsecret") or "").strip()
        return "credentials_ready" if app_id.isdecimal() and secret else "credentials_invalid"
    except (OSError, ValueError, TypeError):
        return "credentials_invalid"


def _sdk() -> str:
    try:
        distribution = importlib.metadata.distribution("im-agent-sdk")
    except importlib.metadata.PackageNotFoundError:
        return "sdk_missing"
    try:
        direct = json.loads(distribution.read_text("direct_url.json") or "null")
        if (
            isinstance(direct, dict)
            and direct.get("url") == SDK_REPOSITORY
            and isinstance(direct.get("vcs_info"), dict)
            and direct["vcs_info"].get("vcs") == "git"
            and direct["vcs_info"].get("commit_id") == SDK_REVISION
        ):
            return "sdk_ready"
    except (OSError, ValueError, TypeError):
        pass
    return "sdk_unverified"


def _feishu_dependency() -> str:
    try:
        importlib.metadata.distribution("lark-channel-sdk")
        return "feishu_ready"
    except importlib.metadata.PackageNotFoundError:
        return "feishu_missing"


def inspect(configuration: dict[str, Any]) -> dict[str, Any]:
    codes = ["python_ready" if sys.version_info >= (3, 13) else "python_unsupported", _sdk()]
    try:
        workspace = Path(configuration["cwd"])
        codes.append("workspace_ready" if workspace.is_dir() else "workspace_missing")
    except (OSError, ValueError, TypeError, KeyError):
        codes.append("workspace_missing")
    if configuration.get("sharedFilesystemRoot"):
        try:
            shared = Path(configuration["sharedFilesystemRoot"])
            codes.append(
                "shared_filesystem_ready" if shared.is_dir() else "shared_filesystem_missing"
            )
        except (OSError, ValueError, TypeError):
            codes.append("shared_filesystem_missing")
    enabled: list[str] = []
    if configuration.get("skipChannelsInspection") is True:
        # Managed marker files are Host-owned references, not channel JSON.
        # The Host contributes safe flags; this process never decrypts them.
        if "feishu" in configuration.get("requiredChannels", []):
            codes.append(_feishu_dependency())
        return {"codes": codes, "enabledChannels": enabled}
    try:
        config_file = Path(configuration["channelsConfigFile"])
        channels = _json_file(config_file)
        if not isinstance(channels, dict) or set(channels) - set(CHANNELS):
            raise ValueError("unsupported config")
        if any(not isinstance(value, dict) for value in channels.values()):
            raise ValueError("invalid channel shape")
        if any(
            "enabled" in value and not isinstance(value["enabled"], bool)
            for value in channels.values()
        ):
            raise ValueError("invalid enabled field")
        enabled = [name for name in CHANNELS if channels.get(name, {}).get("enabled") is True]
        restrictions = [_restricted(channels[name]) for name in enabled]
        restricted = all(restrictions)
        codes.append("channels_ready" if enabled else "channels_none")
        if enabled:
            if restricted:
                codes.append("allowlist_ready")
            elif configuration.get(
                "permissionMode", "full-access"
            ) == "full-access" and not configuration.get("allowUnrestrictedFullAccess", False):
                codes.append("allowlist_required")
            else:
                codes.append("allowlist_unrestricted")
        if "qq" in enabled:
            codes.append(_qq_credentials(channels["qq"], config_file.parent))
        if any(name != "qq" for name in enabled):
            # The SDK owns those schemas. Do not guess them or instantiate adapters.
            codes.append("other_credentials_deferred")
        if "feishu" in enabled:
            codes.append(_feishu_dependency())
    except (OSError, ValueError, TypeError, KeyError):
        codes.append("channels_invalid")
    return {"codes": codes, "enabledChannels": enabled}


def main() -> None:
    try:
        line = sys.stdin.buffer.readline(MAX_FILE_BYTES + 1)
        if len(line) > MAX_FILE_BYTES or not line.endswith(b"\n"):
            raise ValueError("invalid request")
        configuration = json.loads(line)
        if not isinstance(configuration, dict):
            raise ValueError("invalid request")
        result = inspect(configuration)
    except Exception:
        result = {"codes": ["probe_failed"], "enabledChannels": []}
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
