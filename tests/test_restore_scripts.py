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
    assert "FROM docker:28-cli AS docker_cli" in runner_dockerfile
    assert "COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker" in runner_dockerfile
    assert "runtime-requirements.txt" in runner_dockerfile
    assert "uvicorn" in runner_dockerfile
    assert "-e AGORA_SANDBOX_IMAGE=${image_uri}" in restore_script
    assert "-v /tmp/agora-sandbox:/tmp/agora-sandbox" in restore_script
    assert 'RUNNER_MACHINE_TYPE="${RUNNER_MACHINE_TYPE:-e2-standard-4}"' in restore_script
    assert "set-machine-type" in restore_script
    assert "--no-cpu-throttling" in restore_script
    assert "--min-instances 1" in restore_script
    assert "--max-instances 6" in restore_script
    assert "AGORA_FLASH_MODEL=gemini-2.5-flash-lite" in restore_script
    assert "AGORA_PRO_MODEL=gemini-2.5-flash" in restore_script
    assert "AGORA_CLAUDE_MODEL=anthropic/claude-sonnet-4.6" in restore_script
    assert "AGORA_WORKSPACE_CONCURRENT_TASK_RUNS=2" in restore_script


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
