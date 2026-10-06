from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows inherited pipe regression")


def test_media_workers_keep_host_pipe_responsive(tmp_path):
    source = Path(__file__).resolve().parents[1] / "src"
    # Match the Host's Node pipe and isolated Python -c entry. Keep stdin open
    # during media preparation, then exercise a second request and clean EOF.
    program = f"""
import asyncio,sys
from pathlib import Path
sys.path.insert(0,{str(source)!r})
from imzen.zenx import isolate_child_stdin,ThreadedPipeReader
from imagent.channels.native.media import ImageMediaMaterializer
async def unused(*args):
    raise AssertionError('No network expected')
async def run():
    reader=ThreadedPipeReader(sys.stdin.buffer)
    media=ImageMediaMaterializer(root=Path({str(tmp_path / "media")!r}),download=unused)
    try:
        assert await reader.readline()==b'config\\n'
        await media.prepare()
        print('ready',flush=True)
        assert await reader.readline()==b'response\\n'
        await media.prepare()
        assert await reader.readline()==b''
        print('response-and-eof',flush=True)
    finally:
        reader.close()
        await reader.wait_closed()
        await media.stop()
with isolate_child_stdin():
    asyncio.run(run())
"""
    host = f"""
const {{spawn}}=require('node:child_process');
const p=spawn({json.dumps(sys.executable)},['-I','-u','-c',{json.dumps(program)}],
  {{stdio:['pipe','pipe','pipe']}});
let output='';
p.stdin.on('error',()=>{{}});
p.stdin.write('config\\n');
p.stdout.on('data',chunk=>{{
  output+=chunk;
  if(output.includes('ready')&&!p.stdin.writableEnded)p.stdin.end('response\\n');
}});
p.stderr.pipe(process.stderr);
const timeout=setTimeout(()=>{{p.kill('SIGKILL');process.exitCode=1;}},12000);
p.on('exit',code=>{{clearTimeout(timeout);process.stdout.write(output);process.exitCode=code??1;}});
"""
    result = subprocess.run(["node", "-e", host], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["ready", "response-and-eof"]


@pytest.mark.parametrize("raises", [False, True])
def test_child_stdin_restores_original_handle(raises):
    import ctypes

    from imzen.zenx import isolate_child_stdin

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetStdHandle.argtypes = [ctypes.c_ulong]
    kernel.GetStdHandle.restype = ctypes.c_void_p
    original = kernel.GetStdHandle(-10 & 0xFFFFFFFF)
    try:
        with isolate_child_stdin():
            assert kernel.GetStdHandle(-10 & 0xFFFFFFFF) != original
            if raises:
                raise ValueError("fixture")
    except ValueError:
        assert raises
    assert kernel.GetStdHandle(-10 & 0xFFFFFFFF) == original
