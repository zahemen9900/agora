from __future__ import annotations

from pathlib import Path

import tomllib


ROOT = Path(__file__).resolve().parents[1]


def test_sdk_packaging_uses_repo_root_source_tree() -> None:
    sdk_pyproject = tomllib.loads((ROOT / "sdk" / "pyproject.toml").read_text(encoding="utf-8"))
    build_system = sdk_pyproject["build-system"]

    assert build_system["build-backend"] == "build_backend"
    assert build_system["backend-path"] == ["."]
    assert "setuptools>=69" in build_system["requires"]
    assert "wheel" in build_system["requires"]


def test_sdk_directory_does_not_contain_agora_source_tree() -> None:
    sdk_agora = ROOT / "sdk" / "agora"

    assert not sdk_agora.exists()
    assert not sdk_agora.is_symlink()
