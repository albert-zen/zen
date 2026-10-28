"""Exercise the real entry-point failure handlers without loading channel SDKs."""

import ast
import asyncio
import contextlib
import io
import json
import sys
import traceback
import unittest
from pathlib import Path


class GatewayStateMigrationError(Exception):
    pass


class PawRoutingError(Exception):
    pass


class EntryDiagnosticsTest(unittest.TestCase):
    def test_failure_tracebacks_stay_on_private_stderr(self):
        source = Path(__file__).parents[1] / "src" / "imzen" / "zenx.py"
        entry = ast.parse(source.read_text()).body[-1]
        for error_type in (GatewayStateMigrationError, RuntimeError):
            with self.subTest(error=error_type.__name__):

                async def run(error_type=error_type):
                    _local_secret_not_logged = "synthetic-local-variable-secret"
                    try:
                        raise ValueError("synthetic migration column mismatch")
                    except ValueError as cause:
                        raise error_type("synthetic startup failure") from cause

                stdout, stderr = io.StringIO(), io.StringIO()
                namespace = {
                    "__name__": "__main__",
                    "run": run,
                    "isolate_child_stdin": contextlib.nullcontext,
                    "asyncio": asyncio,
                    "sys": sys,
                    "json": json,
                    "traceback": traceback,
                    "GatewayStateMigrationError": GatewayStateMigrationError,
                    "PawRoutingError": PawRoutingError,
                }
                with (
                    contextlib.redirect_stdout(stdout),
                    contextlib.redirect_stderr(stderr),
                ):
                    with self.assertRaises(SystemExit) as stopped:
                        exec(
                            compile(ast.Module(body=[entry], type_ignores=[]), str(source), "exec"),
                            namespace,
                        )
                self.assertEqual(stopped.exception.code, 1)
                self.assertEqual(json.loads(stdout.getvalue())["type"], "failed")
                self.assertNotIn("synthetic migration column mismatch", stdout.getvalue())
                self.assertIn("synthetic migration column mismatch", stderr.getvalue())
                self.assertIn("synthetic startup failure", stderr.getvalue())
                self.assertNotIn("synthetic-local-variable-secret", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
