from __future__ import annotations

from pathlib import Path


def test_imzen_does_not_import_imcodex_agent_or_persistence_layers():
    source_root = Path(__file__).parents[1] / "src" / "imzen"
    source = "\n".join(path.read_text(encoding="utf-8") for path in source_root.rglob("*.py"))
    forbidden = (
        "imcodex.bridge",
        "imcodex.store",
        "CodexBackend",
        "BridgeService",
        "ConversationStore",
    )

    for marker in forbidden:
        assert marker not in source
