"""Plugin-owned process entry; the IM Agent SDK owns all bridge semantics."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import sys
import traceback
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager

from .channel_status import report_channel_status
from .config import Settings
from .main import prepare_gateway, resolve_channels
from .migration import GatewayStateMigrationError
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
        channels, channel_config = resolve_channels(settings, channel_config=channel_config)
        host = PawHostClient(reader, lambda line: print(line, flush=True))
        room_state = PawState(settings.gateway_state_file.with_suffix(".paw.sqlite3"))
        paw = PawController(
            host,
            room_state,
            channel_instance_ids=frozenset(channel.channel_instance_id for channel in channels),
        )
        gateway, state = await prepare_gateway(
            settings,
            channels=channels,
            channel_config=channel_config,
            # ZenX launches this child alongside its own local App Server and
            # supplies that server's private connection descriptor over the pipe.
            local_app_server=True,
            persistent_subscriptions=True,
            controller_factory=paw.wrap,
            delivery_authorizer=paw,
            outbound_presentation=paw,
            startup_preparations=paw.startup_preparations(),
            on_state_preparation=lambda: print(json.dumps({"type": "preparing-state"}), flush=True),
        )
        paw.attach(gateway)
        tasks.append(asyncio.create_task(host.read_responses(), name="imzenx-paw-pipe"))
        await gateway.start()
        print(json.dumps({"type": "ready"}), flush=True)
        tasks.append(
            asyncio.create_task(
                report_channel_status(
                    gateway,
                    (channel.channel_instance_id for channel in channels),
                    lambda frame: print(json.dumps(frame), flush=True),
                ),
                name="imzenx-channel-status",
            )
        )
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
    except GatewayStateMigrationError:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"type": "failed", "code": "state_migration_blocked"}), flush=True)
        sys.exit(1)
    except PawRoutingError as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"type": "failed", "message": str(error)}), flush=True)
        sys.exit(1)
    except Exception:
        traceback.print_exc(file=sys.stderr)
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
