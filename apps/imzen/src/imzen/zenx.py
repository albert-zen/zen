"""Plugin-owned process entry; the IM Agent SDK owns all bridge semantics."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import sys
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager

from .config import Settings
from .main import create_gateway
from .paw import PawController, PawRoutingError, PawState
from .paw_pipe import MAX_LINE_BYTES, PawHostClient, ThreadedPipeReader


@contextmanager
def isolate_child_stdin() -> Iterator[None]:
    """Keep the private pipe in this process; give Windows children NUL stdin.

    A blocked read on the inherited synchronous pipe can stall Windows child
    initialization. Preserve sys.stdin for PAW, changing only the Win32 standard
    handle slot used by subprocesses. No interactive child stdin is supported.
    """
    if sys.platform != "win32":
        yield
        return
    import ctypes
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetStdHandle.argtypes = [ctypes.c_ulong]
    kernel.GetStdHandle.restype = ctypes.c_void_p
    kernel.SetStdHandle.argtypes = [ctypes.c_ulong, ctypes.c_void_p]
    kernel.SetStdHandle.restype = ctypes.c_int
    stdin_id = -10 & 0xFFFFFFFF
    previous = kernel.GetStdHandle(stdin_id)
    with open(os.devnull, "rb") as sink:
        if not kernel.SetStdHandle(stdin_id, msvcrt.get_osfhandle(sink.fileno())):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            yield
        finally:
            if not kernel.SetStdHandle(stdin_id, previous):
                raise ctypes.WinError(ctypes.get_last_error())


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
    # The existing private child pipe carries paths plus bounded Room requests.
    # Inherited Windows stdin is not an asyncio overlapped PipeHandle. A bounded
    # daemon reader also avoids joining a blocked default-executor worker on exit.
    reader = ThreadedPipeReader(sys.stdin.buffer)
    gateway = state = room_state = None
    tasks = []
    try:
        line = await reader.readline()
        if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
            raise ValueError("Invalid IMZenX configuration line")
        deployment = json.loads(line)
        if not isinstance(deployment, dict):
            raise ValueError("Invalid IMZenX configuration line")
        channel_config = deployment.pop("IMZEN_CHANNELS_CONFIG", None)
        if channel_config is not None and not isinstance(channel_config, dict):
            raise ValueError("Invalid managed IM channel configuration")
        settings = Settings.from_env(deployment)
        host = PawHostClient(reader, lambda line: print(line, flush=True))
        room_state = PawState(settings.gateway_state_file.with_suffix(".paw.sqlite3"))
        paw = PawController(host, room_state)
        gateway, state = create_gateway(
            settings,
            channel_config=channel_config,
            persistent_subscriptions=True,
            controller_factory=paw.wrap,
            delivery_authorizer=paw,
            outbound_presentation=paw,
        )
        paw.attach(gateway)
        tasks.append(asyncio.create_task(host.read_responses(), name="imzenx-paw-pipe"))
        await paw.restore()
        await gateway.start()
        print(json.dumps({"type": "ready"}), flush=True)
        tasks.append(asyncio.create_task(paw.poll(), name="imzenx-paw-room-poll"))
        # EOF on disable/uninstall/Quit/Host death stops both the poll and SDK.
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        reader.close()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await reader.wait_closed()
        try:
            if gateway is not None:
                await gateway.stop()
        finally:
            try:
                if state is not None:
                    await state.close()
            finally:
                if room_state is not None:
                    room_state.close()


if __name__ == "__main__":
    try:
        with isolate_child_stdin():
            asyncio.run(run())
    except PawRoutingError as error:
        print(json.dumps({"type": "failed", "message": str(error)}), flush=True)
        sys.exit(1)
    except Exception:
        # Do not promote transport errors containing credentials into tool output.
        print(
            json.dumps(
                {
                    "type": "failed",
                    "message": (
                        "IM Gateway or PAW Room delivery failed. "
                        "Check the channel configuration and Room route; "
                        "a missing history checkpoint requires selecting the PAW again."
                    ),
                }
            ),
            flush=True,
        )
        sys.exit(1)
