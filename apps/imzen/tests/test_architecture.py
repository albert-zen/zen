from __future__ import annotations

from pathlib import Path


def test_imzen_uses_the_sdk_without_recreating_agent_or_bridge_layers():
    source_root = Path(__file__).parents[1] / "src" / "imzen"
    source = "\n".join(path.read_text(encoding="utf-8") for path in source_root.rglob("*.py"))
    forbidden = (
        "from imcodex",
        "import imcodex",
        "CodexBackend",
        "BridgeService",
        "ConversationStore",
        "class ImZenGateway",
        "class ImZenMiddleware",
    )

    for marker in forbidden:
        assert marker not in source


def test_imzen_keeps_only_product_composition_modules():
    source_root = Path(__file__).parents[1] / "src" / "imzen"
    modules = {path.name for path in source_root.glob("*.py")}

    assert modules == {
        "__init__.py",
        "__main__.py",
        "channels.py",
        "config.py",
        "controller.py",
        "main.py",
    }
