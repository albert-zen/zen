"""Offline, fail-closed migration of IMZen's v0 bridge state, never Agent history.

The SDK store constructor writes before validating legacy rows. Keep it away from
an original v0 file: inspect, back up, resolve ancestry, upgrade a disposable copy,
validate through a fenced v1 session, then atomically install that copy.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
from collections.abc import Awaitable, Callable, Mapping
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from imagent import SQLiteGatewayStore
from imagent.applications import ProjectRef, WorkspaceIdentity
from imagent.applications.contract import fingerprint_canonical_workspace_root
from imagent.interaction.messages import ConversationRef

ThreadReader = Callable[[str], Awaitable[Mapping[str, object]]]

# This is the schema actually emitted by the pinned v0 SDK, not a best-effort
# decoder for arbitrary historical databases. Unknown versions require review.
_LEGACY_COLUMNS = {
    "conversation_bindings": "channel_instance_id native_conversation_id application_instance_id "
    "project_id thread_id revision updated_at",
    "idempotency_records": "scope record_key status owner_token updated_at",
    "thread_projection_routes": "route_id application_instance_id project_id thread_id "
    "channel_instance_id native_conversation_id reply_to_message_id checkpoint_agent_item_id "
    "checkpointed_at updated_at",
    "turn_reply_correlations": "correlation_id application_instance_id project_id thread_id "
    "turn_id client_message_id channel_instance_id native_conversation_id reply_to_message_id "
    "created_at",
    "request_route_correlations": "correlation_id application_instance_id native_request_id "
    "project_id thread_id turn_id channel_instance_id native_conversation_id delivery_id "
    "response_shape_json state created_at updated_at expires_at",
    "delivery_submissions": "submission_id delivery_id origin principal_id target_fingerprint "
    "payload_fingerprint created_at updated_at",
    "delivery_submission_destinations": "root_submission_id destination_delivery_id "
    "channel_instance_id native_conversation_id application_instance_id project_id thread_id "
    "route_id route_updated_at reply_to_message_id state receipt_json error updated_at",
}
_THREAD_TABLES = (
    "conversation_bindings",
    "thread_projection_routes",
    "turn_reply_correlations",
    "request_route_correlations",
    "delivery_submission_destinations",
)


class GatewayStateMigrationError(RuntimeError):
    """Startup is blocked; the original database must not be opened by the SDK."""

    def __init__(self, message: str, *, backup_path: Path | None = None):
        super().__init__(message)
        self.backup_path = backup_path


@dataclass(frozen=True, slots=True)
class MigrationResult:
    migrated: bool = False
    backup_path: Path | None = None
    thread_count: int = 0


def _offline(path: Path) -> None:
    if path.is_symlink():
        raise GatewayStateMigrationError(
            "State file is a symlink; select the actual database file."
        )
    if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise GatewayStateMigrationError(
            "Stop all IMZen processes and cleanly close/checkpoint the SQLite database before "
            "startup migration. SQLite sidecars remain; do not delete them or reset the database."
        )


def _read_only(path: Path, *, immutable: bool = True) -> sqlite3.Connection:
    # Offline v0 inspection must not create sidecars. Existing v1 WAL state must
    # instead be read through SQLite so crash recovery/runtime fencing can run.
    suffix = "?mode=ro&immutable=1" if immutable else "?mode=ro"
    connection = sqlite3.connect(path.absolute().as_uri() + suffix, uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}


def _kind(path: Path) -> str:
    if path.is_symlink():
        raise GatewayStateMigrationError(
            "State file is a symlink; select the actual database file."
        )
    if not path.exists():
        return "new"
    sidecars = any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal"))
    try:
        with closing(_read_only(path, immutable=not sidecars)) as connection:
            tables = _tables(connection)
            if not tables:
                return "new"
            if "conversation_bindings" not in tables:
                raise GatewayStateMigrationError("Unrecognized state schema; keep it for review.")
            columns = _columns(connection, "conversation_bindings")
            if "revision" in columns:
                return "legacy"
            if (
                "generation" in columns
                and {
                    "gateway_namespace",
                    "gateway_workspace_identities",
                    "conversation_binding_generations",
                    "gateway_schema_metadata",
                }
                <= tables
            ):
                for table in _THREAD_TABLES:
                    if connection.execute(
                        f"SELECT 1 FROM {table} WHERE thread_id IS NOT NULL AND thread_id != ? "
                        "AND (project_id IS NULL OR project_id = ?) LIMIT 1",
                        ("", ""),
                    ).fetchone():
                        raise GatewayStateMigrationError(
                            "Partially upgraded state has missing Thread ancestry. Restore the "
                            "untouched v0 backup for a reviewed migration; do not reset state."
                        )
                return "current"
            raise GatewayStateMigrationError(
                "Unsupported or partially upgraded state schema; restore an untouched v0 backup "
                "for migration or request a schema-specific review. Do not reset state."
            )
    except sqlite3.DatabaseError as error:
        raise GatewayStateMigrationError(
            "Cannot inspect SQLite state; keep it for review."
        ) from error


def assert_gateway_state_ready(path: str | Path) -> None:
    """Synchronous composition guard, before constructing the SDK SQLite store."""
    if _kind(Path(path)) == "legacy":
        raise GatewayStateMigrationError(
            "Legacy SDK v0 state requires prepare_gateway_state before opening the v1 store. "
            "Use IMZen asynchronous startup with the original workspace and native thread reader."
        )


def _canonical_root(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def _digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _backup(path: Path, digest: str) -> Path:
    backup = path.with_name(f"{path.name}.v0-{digest[:16]}.bak")
    if backup.exists():
        if backup.is_symlink() or _digest(backup) != digest:
            raise GatewayStateMigrationError(
                "Existing migration backup conflicts; keep both files."
            )
        return backup
    # Exclusive create prevents overwriting a prior backup. Backups contain all
    # legacy bytes and are intentionally readable only by this OS user.
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as target, path.open("rb") as source:
        shutil.copyfileobj(source, target)
        target.flush()
        os.fsync(target.fileno())
    if _digest(backup) != digest:
        raise GatewayStateMigrationError("State changed during backup; stop its writer and retry.")
    return backup


def _legacy_rows(connection: sqlite3.Connection) -> dict[str, list[dict]]:
    if _tables(connection) != set(_LEGACY_COLUMNS):
        raise GatewayStateMigrationError(
            "Unsupported legacy tables; a schema-specific review is needed."
        )
    if connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('trigger', 'view') LIMIT 1"
    ).fetchone():
        raise GatewayStateMigrationError(
            "Unsupported legacy triggers/views require a reviewed migration."
        )
    for table, columns in _LEGACY_COLUMNS.items():
        if _columns(connection, table) != set(columns.split()):
            raise GatewayStateMigrationError(
                f"Unsupported legacy columns in {table}; a schema-specific review is needed."
            )
    return {
        table: [dict(row) for row in connection.execute(f"SELECT * FROM {table}")]
        for table in _LEGACY_COLUMNS
    }


async def _ancestry(rows, *, application_instance_id, workspace_id, workspace_root, read_thread):
    scopes: dict[str, set[str]] = {}
    missing: set[str] = set()
    for table in _THREAD_TABLES:
        for row in rows[table]:
            application, project, thread = (
                row["application_instance_id"],
                row["project_id"],
                row["thread_id"],
            )
            if application and application != application_instance_id:
                raise GatewayStateMigrationError(
                    "Legacy state contains another application; review its mapping."
                )
            if project and project != workspace_id:
                raise GatewayStateMigrationError(
                    "Configured workspace ID conflicts with persisted Project ancestry. Use the "
                    "original workspace ID or obtain a reviewed mapping; nothing was reset."
                )
            if not thread:
                continue
            if not application or not isinstance(thread, str):
                raise GatewayStateMigrationError(
                    "Malformed legacy Thread identity requires review."
                )
            scopes.setdefault(thread, set())
            if project:
                scopes[thread].add(project)
            else:
                missing.add(thread)
    for thread, projects in scopes.items():
        if len(projects) > 1:
            raise GatewayStateMigrationError(
                "Ambiguous legacy Thread ancestry requires explicit resolution."
            )
        if read_thread is None:
            raise GatewayStateMigrationError(
                "Legacy Thread workspace provenance is missing. Supply a native thread reader "
                "and the original workspace ID/root; the default alone is not evidence."
            )
        try:
            response = await read_thread(thread)
        except Exception as error:
            raise GatewayStateMigrationError(
                "Native Thread ancestry could not be verified. Reconnect the original Zen host "
                "and retry; the original database and backup are unchanged."
            ) from error
        native = response.get("thread") if isinstance(response, Mapping) else None
        if not isinstance(native, Mapping) or native.get("id") != thread:
            raise GatewayStateMigrationError(
                "Native reader did not return the exact legacy Thread identity."
            )
        root = native.get("cwd")
        if not isinstance(root, str) or not root or not Path(root).is_absolute():
            raise GatewayStateMigrationError(
                "Native Thread has no authoritative absolute workspace root."
            )
        if (await asyncio.to_thread(_canonical_root, root)) != workspace_root:
            raise GatewayStateMigrationError(
                "Native Thread belongs to another workspace root. Select its original workspace; "
                "migration will not redirect the Thread."
            )
    if missing:
        opaque = [row["record_key"] for row in rows["idempotency_records"]]
        opaque += [row["delivery_id"] for row in rows["delivery_submissions"]]
        if any(
            isinstance(key, str)
            and key.startswith(("imagent:delivery:sha256:", "imagent:delivery:live:sha256:"))
            for key in opaque
        ):
            raise GatewayStateMigrationError(
                "Legacy projection delivery hashes include missing Project ancestry. Original "
                "Agent-item identities cannot be recovered from this database. Keep the backup and "
                "request a journal-aware migration; automatic migration could duplicate a delivery."
            )
    return scopes


def _hash(label: str, identity: object) -> str:
    encoded = json.dumps(identity, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return f"imagent:{label}:sha256:{hashlib.sha256(encoded.encode()).hexdigest()}"


def _rewrite(rows, workspace_id: str) -> None:
    old_destinations = [dict(row) for row in rows["delivery_submission_destinations"]]
    route_ids: dict[str, str] = {}
    # Routes retained only in delivery snapshots also need a proven identity;
    # otherwise explicit route-target replay would silently change its meaning.
    for row in [*rows["thread_projection_routes"], *old_destinations]:
        if not row["thread_id"]:
            continue
        old_endpoint = [
            row["application_instance_id"],
            row["project_id"] or None,
            row["thread_id"],
            row["channel_instance_id"],
            row["native_conversation_id"],
        ]
        if row["route_id"] != _hash("projection", old_endpoint):
            raise GatewayStateMigrationError(
                "Nonstandard legacy projection route identity requires a reviewed mapping."
            )
        new_endpoint = [*old_endpoint]
        new_endpoint[1] = workspace_id
        route_ids[row["route_id"]] = _hash("projection", new_endpoint)
    for row in rows["turn_reply_correlations"]:
        old_turn = [
            row["application_instance_id"],
            row["project_id"] or None,
            row["thread_id"],
            row["turn_id"],
        ]
        if row["correlation_id"] != _hash("turn-reply", old_turn):
            raise GatewayStateMigrationError(
                "Nonstandard legacy turn-reply identity requires a reviewed mapping."
            )
    for table in _THREAD_TABLES:
        for row in rows[table]:
            if row["thread_id"]:
                row["project_id"] = workspace_id
    for row in rows["thread_projection_routes"]:
        new_id = _hash(
            "projection",
            [
                row[key]
                for key in (
                    "application_instance_id",
                    "project_id",
                    "thread_id",
                    "channel_instance_id",
                    "native_conversation_id",
                )
            ],
        )
        route_ids[row["route_id"]] = new_id
        row["route_id"] = new_id
    for row in rows["turn_reply_correlations"]:
        row["correlation_id"] = _hash(
            "turn-reply",
            [row[key] for key in ("application_instance_id", "project_id", "thread_id", "turn_id")],
        )
    for row in rows["delivery_submission_destinations"]:
        row["route_id"] = route_ids.get(row["route_id"], row["route_id"])
    new_submissions: set[str] = set()
    for row in rows["delivery_submissions"]:
        old_id = row["submission_id"]
        expected = _hash(
            "delivery-submission", [row["origin"], row["principal_id"], row["delivery_id"]]
        )
        if old_id != expected:
            raise GatewayStateMigrationError(
                "Nonstandard legacy submission identity requires review."
            )
        new_id = _hash("delivery-submission", [row["origin"], row["delivery_id"]])
        if new_id in new_submissions:
            raise GatewayStateMigrationError(
                "Multiple legacy principals reused one delivery ID. v1 shares that identity; "
                "resolve the collision explicitly before migration."
            )
        new_submissions.add(new_id)
        old_children = [
            child for child in old_destinations if child["root_submission_id"] == old_id
        ]
        candidates: dict[str, str] = {}
        for child in old_children:
            conversation = [child["channel_instance_id"], child["native_conversation_id"]]
            conversation_hash = _hash("delivery-target", ["conversation", *conversation])
            candidates[conversation_hash] = conversation_hash
            if child["thread_id"]:
                old_thread = [
                    child["application_instance_id"],
                    child["project_id"] or None,
                    child["thread_id"],
                ]
                new_thread = [child["application_instance_id"], workspace_id, child["thread_id"]]
                for route in (None, child["route_id"]):
                    candidates[_hash("delivery-target", ["thread_routes", old_thread, route])] = (
                        _hash(
                            "delivery-target",
                            ["thread_routes", new_thread, route_ids.get(route, route)],
                        )
                    )
        if row["target_fingerprint"] not in candidates:
            raise GatewayStateMigrationError(
                "Legacy delivery target cannot be reconstructed unambiguously."
            )
        row["target_fingerprint"] = candidates[row["target_fingerprint"]]
        row["submission_id"] = new_id
        for child in rows["delivery_submission_destinations"]:
            if child["root_submission_id"] != old_id:
                continue
            if child["state"] == "retryable":
                raise GatewayStateMigrationError(
                    "Retryable legacy delivery retains old native deduplication IDs. Resolve it "
                    "with the old runtime before migrating; do not resend it under new IDs."
                )
            old_root = row["delivery_id"] if row["origin"] == "gateway_internal" else old_id
            new_root = row["delivery_id"] if row["origin"] == "gateway_internal" else new_id
            conversation = [child["channel_instance_id"], child["native_conversation_id"]]
            old_destination = (
                old_root
                if len(old_children) == 1
                else _hash("delivery-destination", [old_root, *conversation])
            )
            if child["destination_delivery_id"] != old_destination:
                raise GatewayStateMigrationError(
                    "Nonstandard legacy destination identity requires review."
                )
            child["destination_delivery_id"] = (
                new_root
                if len(old_children) == 1
                else _hash("delivery-destination", [new_root, *conversation])
            )
            child["root_submission_id"] = new_id
    for row in rows["idempotency_records"]:
        if any(
            not isinstance(row[key], str) or not row[key]
            for key in ("scope", "record_key", "updated_at")
        ):
            raise GatewayStateMigrationError(
                "Malformed legacy idempotency identity requires review."
            )
        timestamp = datetime.fromisoformat(row["updated_at"])
        if timestamp.tzinfo is None or timestamp.utcoffset() is None:
            raise GatewayStateMigrationError("Legacy idempotency timestamps require a timezone.")
        if row["status"] not in {"completed", "side_effect_started", "in_flight"}:
            raise GatewayStateMigrationError("Unknown legacy idempotency state requires review.")
    for row in rows["delivery_submission_destinations"]:
        receipt = json.loads(row["receipt_json"]) if row["receipt_json"] is not None else None
        details = [] if receipt is None else [receipt, *receipt["items"], *receipt["segments"]]
        if row["error"] is not None or any(item.get("detail") is not None for item in details):
            raise GatewayStateMigrationError(
                "Legacy delivery diagnostics would be scrubbed by v1. An archival/redaction "
                "decision is required; the original state and full backup have been preserved."
            )


async def _validate_staged(
    path: Path, rows, *, application_instance_id, workspace_id, workspace_root
):
    store = SQLiteGatewayStore(path)
    session = None
    try:
        session = await store.acquire_runtime(
            gateway_id="imzen", owner_token="imzen-v0-migration", lease_duration_seconds=300
        )
        await session.check_workspace_identities(
            (
                WorkspaceIdentity(
                    ProjectRef(application_instance_id, workspace_id),
                    fingerprint_canonical_workspace_root(str(workspace_root)),
                ),
            )
        )
        for row in rows["conversation_bindings"]:
            await session.get(
                ConversationRef(row["channel_instance_id"], row["native_conversation_id"])
            )
        await session.list_projection_routes()
        await session.list_turn_reply_correlations()
        await session.list_request_correlations()
        for row in rows["delivery_submissions"]:
            await session.get_delivery_submission(row["submission_id"])
    finally:
        if session is not None:
            await session.release_runtime()
        await store.close()
    with closing(_read_only(path)) as connection:
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise GatewayStateMigrationError("Staged SQLite validation failed.")
        if connection.execute("PRAGMA foreign_key_check").fetchone():
            raise GatewayStateMigrationError("Staged legacy references are inconsistent.")
        for table, expected in rows.items():
            actual = [dict(row) for row in connection.execute(f"SELECT * FROM {table}")]
            if table == "conversation_bindings":
                expected = [dict(row, generation=row["revision"]) for row in expected]
                for row in expected:
                    del row["revision"]

            def canonical(values):
                return sorted(json.dumps(value, sort_keys=True) for value in values)

            if canonical(actual) != canonical(expected):
                raise GatewayStateMigrationError(
                    f"v1 changed preserved {table} data; migration stopped."
                )


async def prepare_gateway_state(
    path: str | Path,
    *,
    workspace_id: str,
    workspace_root: str | Path,
    read_thread: ThreadReader | None = None,
    application_instance_id: str = "zen-main",
) -> MigrationResult:
    """Upgrade only verified v0 state; preserve original bytes on every failure.

    Call after the old process has stopped. This performs no model/channel work;
    the optional reader performs only exact native Thread reads as needed.
    """
    path = Path(path)
    if _kind(path) != "legacy":
        return MigrationResult()
    if not workspace_id.strip() or not application_instance_id.strip():
        raise GatewayStateMigrationError(
            "Explicit workspace/application identity must be nonempty."
        )
    _offline(path)
    root = await asyncio.to_thread(_canonical_root, workspace_root)
    original_identity = path.stat()
    digest = _digest(path)
    backup = _backup(path, digest)
    try:
        with closing(_read_only(backup)) as connection:
            rows = _legacy_rows(connection)
        threads = await _ancestry(
            rows,
            application_instance_id=application_instance_id,
            workspace_id=workspace_id,
            workspace_root=root,
            read_thread=read_thread,
        )
        _rewrite(rows, workspace_id)
        with tempfile.TemporaryDirectory(prefix=".imzen-migration-", dir=path.parent) as directory:
            staged = Path(directory) / "state.sqlite3"
            shutil.copyfile(backup, staged)
            with closing(sqlite3.connect(staged)) as connection:
                for table, values in rows.items():
                    connection.execute(f"DELETE FROM {table}")
                    columns = _LEGACY_COLUMNS[table].split()
                    for row in values:
                        connection.execute(
                            f"INSERT INTO {table} ({', '.join(columns)}) "
                            f"VALUES ({', '.join('?' for _ in columns)})",
                            tuple(row[column] for column in columns),
                        )
                connection.commit()
            await _validate_staged(
                staged,
                rows,
                application_instance_id=application_instance_id,
                workspace_id=workspace_id,
                workspace_root=root,
            )
            _offline(path)
            current_identity = path.stat()
            if (current_identity.st_dev, current_identity.st_ino, current_identity.st_mtime_ns) != (
                original_identity.st_dev,
                original_identity.st_ino,
                original_identity.st_mtime_ns,
            ) or _digest(path) != digest:
                raise GatewayStateMigrationError(
                    "Original state changed; stop its writer and retry."
                )
            os.chmod(staged, path.stat().st_mode & 0o777)
            with staged.open("rb") as source:
                os.fsync(source.fileno())
            try:
                os.replace(staged, path)
            except OSError as error:
                raise GatewayStateMigrationError(
                    "Cannot install the staged migration. Original and backup are unchanged; "
                    "check directory permissions and available storage before retrying."
                ) from error
        return MigrationResult(migrated=True, backup_path=backup, thread_count=len(threads))
    except GatewayStateMigrationError as error:
        error.backup_path = backup
        raise
    except (ValueError, TypeError, KeyError, sqlite3.DatabaseError) as error:
        raise GatewayStateMigrationError(
            "Legacy state is incompatible with v1 validation. Original and backup are unchanged; "
            "request a schema-specific migration review.",
            backup_path=backup,
        ) from error
