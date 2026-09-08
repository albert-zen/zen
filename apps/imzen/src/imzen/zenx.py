"""Plugin-owned process entry; the IM Agent SDK owns all bridge semantics."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import sys
import urllib.request

from .config import Settings
from .main import create_gateway


def normalize_proxy_exclusions() -> None:
    """HTTPX rejects macOS's IPv6 host /128 exclusion; keep equivalent routing."""
    proxies = urllib.request.getproxies()
    exclusions = proxies.get("no", "")
    hosts = exclusions.split(",")
    normalized = []
    for host in hosts:
        candidate = host.strip()
        if candidate.endswith("/128"):
            try:
                candidate = str(ipaddress.IPv6Address(candidate[:-4]))
            except ValueError:
                pass
        normalized.append(candidate)
    value = ",".join(normalized)
    if value != exclusions:
        # getproxies() may originate in macOS System Configuration. Setting only
        # no_proxy would suppress that fallback, so preserve its proxy endpoints.
        for scheme in ("http", "https", "all"):
            if scheme in proxies:
                os.environ[f"{scheme}_proxy"] = proxies[scheme]
        os.environ["no_proxy"] = value


async def run() -> None:
    normalize_proxy_exclusions()
    # Only paths and Host connection coordinates cross this private pipe.
    settings = Settings.from_env(json.loads(sys.stdin.readline()))
    gateway, state = create_gateway(settings, persistent_subscriptions=True)
    try:
        await gateway.start()
        print(json.dumps({"type": "ready"}), flush=True)
        # Parent closes stdin on disable/uninstall/Quit. This also terminates us
        # if the Host dies, without an orphan service or a recovery daemon.
        await asyncio.to_thread(sys.stdin.read)
    finally:
        try:
            await gateway.stop()
        finally:
            await state.close()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except Exception:
        # Do not promote transport errors containing credentials into tool output.
        print(
            json.dumps(
                {
                    "type": "failed",
                    "message": (
                        "IM Gateway startup or connection failed. "
                        "Check the channel configuration and SDK environment."
                    ),
                }
            ),
            flush=True,
        )
        sys.exit(1)
