from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_restore_script_exposes_seed_and_verify_commands() -> None:
    script = (ROOT / "scripts" / "restore_agora_project.sh").read_text(encoding="utf-8")

    assert "seed-secrets" in script
    assert "verify-hosted" in script
    assert "RESTORE_REQUIRE_AUTHENTICATED_SMOKE" in script
    assert "AGORA_WORKOS_CLIENT_ID" in script
    assert "WORKOS_CLIENT_ID" in script


def test_restore_script_builds_runner_service_image() -> None:
    cloudbuild = (
        ROOT / "sandbox_runner_service" / "runtime-image.cloudbuild.yaml"
    ).read_text(encoding="utf-8")
    restore_script = (ROOT / "scripts" / "restore_agora_project.sh").read_text(
        encoding="utf-8"
    )
    runner_dockerfile = (ROOT / "sandbox_runner_service" / "Dockerfile").read_text(
        encoding="utf-8"
    )

    assert "sandbox_runner_service/Dockerfile" in cloudbuild
    assert "metadata.google.internal" in restore_script
    assert "Runner image tag" in restore_script
    assert "docker.io" in runner_dockerfile
    assert "uvicorn" in runner_dockerfile


def test_rwx_restore_validation_assets_are_present() -> None:
    rwx_task = (ROOT / ".rwx" / "ci.yml").read_text(encoding="utf-8")
    wrapper = (ROOT / "scripts" / "run_rwx_restore_validation.sh").read_text(
        encoding="utf-8"
    )

    assert "restore-validation" in rwx_task
    assert "tests/test_restore_scripts.py" in rwx_task
    assert "tests/test_auth_keys.py" in rwx_task
    assert "RWX_ACCESS_TOKEN" in wrapper
    assert "rwx run" in wrapper
