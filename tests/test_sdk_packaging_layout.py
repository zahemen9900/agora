from __future__ import annotations

from pathlib import Path

import tomllib

from agora.version import __version__ as AGORA_VERSION


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


def test_runtime_and_package_versions_stay_in_sync() -> None:
    root_pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    sdk_pyproject = tomllib.loads((ROOT / "sdk" / "pyproject.toml").read_text(encoding="utf-8"))

    assert root_pyproject["project"]["version"] == AGORA_VERSION
    assert sdk_pyproject["project"]["version"] == AGORA_VERSION


def test_sdk_release_workflow_runs_isolated_import_smoke() -> None:
    workflow = (ROOT / ".github" / "workflows" / "deploy-sdk.yml").read_text(encoding="utf-8")

    assert "Verify isolated wheel import" in workflow
    assert "from agora.sdk import AgoraArbitrator, AgoraNode, ReceiptVerificationError" in workflow
