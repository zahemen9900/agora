from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT / "scripts" / "phase2_sdk_smoke"


def _load_module():
    module_path = SCRIPT_DIR / "run_phase2_sdk_smoke.py"
    spec = importlib.util.spec_from_file_location("phase2_sdk_smoke", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_sdk_smoke_parses_agora_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_module()
    monkeypatch.setenv("AGORA_API_KEY", "agora_live_public.secret")
    monkeypatch.setenv("AGORA_PHASE2_SMOKE_PROMPT", "   Should we use X or Y?   ")
    monkeypatch.setenv("AGORA_PHASE2_SMOKE_MECHANISM", "vote")
    monkeypatch.setenv("AGORA_PHASE2_SMOKE_AGENT_COUNT", "2")
    monkeypatch.setenv("AGORA_PHASE2_ALLOW_MECHANISM_SWITCH", "false")
    monkeypatch.setenv("AGORA_PHASE2_ALLOW_OFFLINE_FALLBACK", "true")
    monkeypatch.setenv("AGORA_PHASE2_QUORUM_THRESHOLD", "0.75")

    config = module._parse_args([])

    assert config.auth_token == "agora_live_public.secret"
    assert config.prompt == "Should we use X or Y?"
    assert config.mechanism == "vote"
    assert config.agent_count == 2
    assert config.allow_mechanism_switch is False
    assert config.allow_offline_fallback is True
    assert config.quorum_threshold == 0.75


def test_sdk_smoke_rejects_invalid_agent_count_env(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_module()
    monkeypatch.setenv("AGORA_PHASE2_SMOKE_AGENT_COUNT", "not-a-number")

    with pytest.raises(ValueError, match="AGORA_PHASE2_SMOKE_AGENT_COUNT must be a valid integer"):
        module._int_env("AGORA_PHASE2_SMOKE_AGENT_COUNT", 4)


def test_sdk_smoke_rejects_invalid_quorum_threshold_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_module()
    monkeypatch.setenv("AGORA_PHASE2_QUORUM_THRESHOLD", "not-a-float")

    with pytest.raises(ValueError, match="AGORA_PHASE2_QUORUM_THRESHOLD must be a valid float"):
        module._float_env("AGORA_PHASE2_QUORUM_THRESHOLD", 0.6)


def test_sdk_smoke_missing_auth_token_message_is_generic(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_module()
    monkeypatch.delenv("AGORA_API_KEY", raising=False)

    with pytest.raises(RuntimeError) as exc_info:
        module._parse_args([])

    message = str(exc_info.value)
    assert "AGORA_API_KEY is required" in message
    assert "/home/zahemen/projects/dl-lib/agora/.env" not in message


def test_sdk_smoke_build_report_includes_summary() -> None:
    module = _load_module()
    config = module.SmokeConfig(
        auth_token="agora_live_public.secret",
        prompt="Should we use a monolith or microservices?",
        mechanism="vote",
        agent_count=3,
        allow_mechanism_switch=True,
        allow_offline_fallback=False,
        quorum_threshold=0.6,
    )

    class _FakeResult:
        def model_dump(self, *, mode: str, exclude_none: bool) -> dict[str, object]:
            assert mode == "json"
            assert exclude_none is True
            return {
                "mechanism_used": "vote",
                "final_answer": "Use a modular monolith",
                "confidence": 0.91,
                "merkle_root": "abc123",
                "decision_hash": "def456",
                "total_tokens_used": 42,
                "total_latency_ms": 12.5,
                "agent_models_used": ["model-a", "model-b"],
                "model_telemetry": {
                    "model-a": {"total_tokens": 21},
                    "model-b": {"total_tokens": 21},
                },
            }

    report = module._build_report(
        config=config,
        result=_FakeResult(),
        verification={
            "valid": True,
            "merkle_match": True,
            "hosted_metadata_match": True,
            "on_chain_match": None,
        },
    )

    assert report["summary"]["mechanism_used"] == "vote"
    assert report["summary"]["final_answer"] == "Use a modular monolith"
    assert report["summary"]["model_count"] == 2
    assert report["summary"]["model_telemetry_models"] == ["model-a", "model-b"]
    assert report["request"]["mechanism"] == "vote"
    assert report["receipt_verification"]["valid"] is True


def test_sdk_smoke_formats_stream_events() -> None:
    module = _load_module()

    agent_event = module._format_stream_event(
        {
            "event": "agent_output_delta",
            "data": {"content": "hello world", "role": "proponent"},
            "timestamp": "2026-04-20T10:00:00Z",
        }
    )
    generic_event = module._format_stream_event(
        {
            "event": "usage_delta",
            "data": {"total_tokens": 7},
            "timestamp": "2026-04-20T10:00:01Z",
        }
    )

    assert "agent_output_delta" in agent_event
    assert "hello world" in agent_event
    assert "usage_delta" in generic_event
    assert '"total_tokens": 7' in generic_event


def test_sdk_smoke_wrapper_installs_before_run() -> None:
    script = (SCRIPT_DIR / "run.sh").read_text(encoding="utf-8")
    install_line = 'pip install "$ROOT_DIR/sdk"'
    run_line = 'run_phase2_sdk_smoke.py'

    assert install_line in script
    assert run_line in script
    assert "AGORA_API_URL" not in script
    assert script.index(install_line) < script.index(run_line)


def test_sdk_smoke_runner_streams_before_final_json() -> None:
    script = (SCRIPT_DIR / "run_phase2_sdk_smoke.py").read_text(encoding="utf-8")

    assert "stream_task_events" in script
    assert "start_task_run" in script
    assert "final json payload" in script
    assert "--api-url" not in script


@pytest.mark.paid_integration
@pytest.mark.skipif(
    os.getenv("RUN_PAID_PROVIDER_TESTS", "").lower() not in {"1", "true", "yes", "on"},
    reason="Hosted SDK smoke is opt-in.",
)
def test_sdk_smoke_script_live() -> None:
    import subprocess

    env = os.environ.copy()
    env.setdefault(
        "AGORA_PHASE2_SMOKE_PROMPT",
        "Should we use a monolith or microservices for a small internal tool?",
    )
    env.setdefault("AGORA_PHASE2_SMOKE_AGENT_COUNT", "2")
    env.setdefault("AGORA_PHASE2_ALLOW_OFFLINE_FALLBACK", "false")
    env.setdefault("AGORA_PHASE2_ALLOW_MECHANISM_SWITCH", "true")
    env.setdefault("AGORA_PHASE2_QUORUM_THRESHOLD", "0.6")

    completed = subprocess.run(
        [str(SCRIPT_DIR / "run.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=1800,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + "\n" + completed.stderr
    assert '"final_answer"' in completed.stdout
    assert '"receipt_verification"' in completed.stdout
    marker = "[sdk] final json payload:\n"
    assert marker in completed.stdout
    json.loads(completed.stdout.split(marker, 1)[1])
