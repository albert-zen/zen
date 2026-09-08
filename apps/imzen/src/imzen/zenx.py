"""Plugin-owned process entry; the IM Agent SDK owns all bridge semantics."""

from __future__ import annotations

import asyncio
import json
import sys

from .config import Settings
from .main import create_gateway


async def run() -> None:
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
