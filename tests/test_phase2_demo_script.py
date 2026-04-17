from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import pytest


def _load_phase2_demo_module():
    module_path = Path("scripts/phase2_demo.py").resolve()
    spec = importlib.util.spec_from_file_location("phase2_demo_module", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_phase2_demo_defaults_to_hosted_target(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_phase2_demo_module()

    monkeypatch.delenv("AGORA_PHASE2_TARGET", raising=False)
    monkeypatch.delenv("AGORA_API_URL", raising=False)

    args = module._parse_args([])

    assert args.target == "hosted"
    assert args.api_url == module.DEFAULT_HOSTED_API_URL


def test_resolve_hosted_auth_token_requires_value(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_phase2_demo_module()

    monkeypatch.delenv("AGORA_TEST_API_KEY", raising=False)
    monkeypatch.delenv("AGORA_PHASE2_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("AGORA_TEST_API_KEY_SECRET_NAME", raising=False)
    monkeypatch.delenv("AGORA_HOSTED_AUTH_TOKEN_SECRET_NAME", raising=False)
    monkeypatch.delenv("AGORA_TEST_API_KEY_SECRET_PROJECT", raising=False)
    monkeypatch.delenv("AGORA_HOSTED_AUTH_TOKEN_SECRET_PROJECT", raising=False)
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    monkeypatch.setattr(module, "_load_secret_via_gcloud", lambda **_: None)

    with pytest.raises(RuntimeError, match="requires an auth token"):
        module._resolve_hosted_auth_token(argparse.Namespace(auth_token=""))


def test_resolve_hosted_auth_token_uses_secret_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_phase2_demo_module()

    monkeypatch.delenv("AGORA_TEST_API_KEY", raising=False)
    monkeypatch.delenv("AGORA_PHASE2_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "demo-project")
    monkeypatch.setenv("AGORA_TEST_API_KEY_SECRET_NAME", "agora-test-api-key")

    expected = "agora_test_public.secret"

    def _fake_loader(*, secret_name: str, project_id: str, version: str) -> str | None:
        assert secret_name == "agora-test-api-key"
        assert project_id == "demo-project"
        assert version == "latest"
        return expected

    monkeypatch.setattr(module, "_load_secret_via_gcloud", _fake_loader)

    token = module._resolve_hosted_auth_token(argparse.Namespace(auth_token=""))

    assert token == expected
    assert module.os.getenv("AGORA_TEST_API_KEY") == expected
    assert module.os.getenv("AGORA_PHASE2_AUTH_TOKEN") == expected


def test_resolve_hosted_auth_context_uses_jwt_bootstrap_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_phase2_demo_module()

    monkeypatch.delenv("AGORA_TEST_API_KEY", raising=False)
    monkeypatch.delenv("AGORA_PHASE2_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(module, "_resolve_hosted_auth_token_from_secret", lambda: None)

    def _fake_bootstrap(args: argparse.Namespace) -> tuple[str, dict[str, object]]:
        assert args.bootstrap_jwt_token == "jwt-token"
        return "agora_test_bootstrap.secret", {"mode": "jwt"}

    monkeypatch.setattr(module, "_bootstrap_hosted_auth_token", _fake_bootstrap)

    token, source, summary = module._resolve_hosted_auth_context(
        argparse.Namespace(
            auth_token="",
            bootstrap_if_missing_token=True,
            bootstrap_jwt_token="jwt-token",
        )
    )

    assert token == "agora_test_bootstrap.secret"
    assert source == "jwt-bootstrap"
    assert summary == {"mode": "jwt"}


def test_resolve_hosted_auth_context_does_not_bootstrap_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_phase2_demo_module()

    monkeypatch.delenv("AGORA_TEST_API_KEY", raising=False)
    monkeypatch.delenv("AGORA_PHASE2_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(module, "_resolve_hosted_auth_token_from_secret", lambda: None)

    def _unexpected_bootstrap(_args: argparse.Namespace) -> tuple[str, dict[str, object]]:
        raise AssertionError("bootstrap should not be called")

    monkeypatch.setattr(module, "_bootstrap_hosted_auth_token", _unexpected_bootstrap)

    with pytest.raises(RuntimeError, match="requires an auth token"):
        module._resolve_hosted_auth_context(
            argparse.Namespace(
                auth_token="",
                bootstrap_if_missing_token=False,
                bootstrap_jwt_token="jwt-token",
            )
        )


def test_preflight_hosted_returns_auth_source_and_bootstrap_summary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_phase2_demo_module()

    monkeypatch.setenv("HELIUS_RPC_URL", "https://devnet.helius-rpc.com/?api-key=test")

    monkeypatch.setattr(
        module,
        "_resolve_hosted_auth_context",
        lambda _args: ("agora_test_bootstrap.secret", "jwt-bootstrap", {"mode": "jwt"}),
    )

    preflight, token, bootstrap = module._preflight_hosted(
        argparse.Namespace(api_url="https://example.com")
    )

    assert token == "agora_test_bootstrap.secret"
    assert preflight["auth_token_source"] == "jwt-bootstrap"
    assert preflight["auth_token_hint"] == "agora_test_bootstrap"
    assert bootstrap == {"mode": "jwt"}


def test_phase2_demo_http_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_phase2_demo_module()

    monkeypatch.delenv("AGORA_PHASE2_HTTP_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("AGORA_PHASE2_HTTP_RETRIES", raising=False)

    args = module._parse_args([])

    assert args.http_timeout_seconds == module.DEFAULT_HTTP_TIMEOUT_SECONDS
    assert args.http_retries == module.DEFAULT_HTTP_RETRIES


def test_build_run_summary_includes_core_fields() -> None:
    module = _load_phase2_demo_module()
    sdk_flow = {
        "status_after_create": {"task_id": "task-1", "solana_tx_hash": "init-hash"},
        "status_after_run": {
            "mechanism": "vote",
            "solana_tx_hash": "receipt-hash",
            "result": {
                "final_answer": "AGORA_DEMO_OK",
                "confidence": 0.91,
                "round_count": 1,
                "mechanism_switches": 0,
                "total_tokens_used": 123,
                "latency_ms": 456.7,
                "agent_models_used": ["m1", "m2", "m3", "m4"],
                "transcript_hashes": ["a", "b"],
            },
        },
        "status_after_pay": {
            "status": "paid",
            "payment_status": "released",
            "solana_tx_hash": "pay-hash",
        },
        "receipt_verification": {
            "merkle_match": True,
            "hosted_metadata_match": True,
        },
    }

    summary = module._build_run_summary(sdk_flow)

    assert summary["task_id"] == "task-1"
    assert summary["mechanism"] == "vote"
    assert summary["final_answer"] == "AGORA_DEMO_OK"
    assert summary["transcript_hash_count"] == 2
    assert summary["event_count"] == 0
    assert summary["event_type_count"] == 0
    assert summary["event_types"] == []
    assert summary["acceptance_checks"]["initialize_tx_present"] is True
    assert summary["acceptance_checks"]["receipt_tx_present"] is True
    assert summary["acceptance_checks"]["payment_tx_present"] is True
    assert summary["acceptance_checks"]["final_status_paid"] is True
    assert summary["acceptance_checks"]["payment_status_released"] is True
    assert summary["receipt_verification"]["merkle_match"] is True


def test_build_event_timeline_deduplicates_and_summarizes_events() -> None:
    module = _load_phase2_demo_module()
    sdk_flow = {
        "status_after_create": {
            "events": [
                {
                    "event": "task_created",
                    "timestamp": "2026-04-16T10:00:00Z",
                    "data": {"status": "pending"},
                },
                {
                    "event": "mechanism_selected",
                    "timestamp": "2026-04-16T10:00:01Z",
                    "data": {"mechanism": "vote"},
                },
            ]
        },
        "status_after_run": {
            "events": [
                {
                    "event": "task_created",
                    "timestamp": "2026-04-16T10:00:00Z",
                    "data": {"status": "pending"},
                },
                {
                    "event": "mechanism_selected",
                    "timestamp": "2026-04-16T10:00:01Z",
                    "data": {"mechanism": "vote"},
                },
                {
                    "event": "agent_output",
                    "timestamp": "2026-04-16T10:00:02Z",
                    "data": {"agent_id": "agent-1", "confidence": 0.9},
                },
                {
                    "event": "complete",
                    "timestamp": "2026-04-16T10:00:03Z",
                    "data": {"status": "completed"},
                },
            ]
        },
        "status_after_pay": {
            "events": [
                {
                    "event": "task_created",
                    "timestamp": "2026-04-16T10:00:00Z",
                    "data": {"status": "pending"},
                },
                {
                    "event": "mechanism_selected",
                    "timestamp": "2026-04-16T10:00:01Z",
                    "data": {"mechanism": "vote"},
                },
                {
                    "event": "agent_output",
                    "timestamp": "2026-04-16T10:00:02Z",
                    "data": {"agent_id": "agent-1", "confidence": 0.9},
                },
                {
                    "event": "complete",
                    "timestamp": "2026-04-16T10:00:03Z",
                    "data": {"status": "completed"},
                },
                {
                    "event": "payment_released",
                    "timestamp": "2026-04-16T10:00:04Z",
                    "data": {"status": "paid", "payment_status": "released"},
                },
            ]
        },
    }

    timeline = module._build_event_timeline(sdk_flow, excerpt_size=2)

    assert timeline["event_count"] == 5
    assert timeline["unique_event_types"] == 5
    assert timeline["event_counts"]["task_created"] == 1
    assert timeline["event_counts"]["payment_released"] == 1
    assert timeline["first_timestamp"] == "2026-04-16T10:00:00Z"
    assert timeline["last_timestamp"] == "2026-04-16T10:00:04Z"
    assert timeline["event_span_seconds"] == 4.0
    assert timeline["first_events"][0]["event"] == "task_created"
    assert timeline["last_events"][-1]["event"] == "payment_released"
