"""Generate frontend API TypeScript types from the FastAPI OpenAPI schema."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

OUTPUT_PATH = REPO_ROOT / "agora-web" / "src" / "lib" / "api.generated.ts"
SCHEMA_NAMES = [
    "ReasoningPresetOverrides",
    "ReasoningPresets",
    "TaskCreateRequest",
    "TaskEvent",
    "DeliberationResultResponse",
    "TaskStatusResponse",
    "PrincipalResponse",
    "WorkspaceResponse",
    "FeatureFlagsResponse",
    "AuthMeResponse",
    "ApiKeyMetadataResponse",
    "ApiKeyCreateResponse",
    "TaskCreateResponse",
    "BenchmarkRunRequest",
    "BenchmarkRunResponse",
    "BenchmarkRunStatusResponse",
    "BenchmarkCatalogResponse",
    "BenchmarkDetailResponse",
    "BenchmarkPromptTemplatesResponse",
]


def _collect_schema_refs(value: Any, refs: set[str]) -> None:
    if isinstance(value, dict):
        ref = value.get("$ref")
        if isinstance(ref, str):
            refs.add(ref.rsplit("/", 1)[-1])
        for nested in value.values():
            _collect_schema_refs(nested, refs)
        return

    if isinstance(value, list):
        for item in value:
            _collect_schema_refs(item, refs)


def _schema_names_with_dependencies(schemas: dict[str, dict[str, Any]]) -> list[str]:
    ordered: list[str] = []
    visited: set[str] = set()

    def visit(name: str) -> None:
        if name in visited or name not in schemas:
            return
        visited.add(name)
        ordered.append(name)

        refs: set[str] = set()
        _collect_schema_refs(schemas[name], refs)
        for ref_name in sorted(refs):
            visit(ref_name)

    for root_name in SCHEMA_NAMES:
        visit(root_name)

    return ordered


def _schema_ref_name(schema: dict[str, Any]) -> str:
    ref = schema["$ref"]
    return ref.rsplit("/", 1)[-1]


def _render_union(values: list[str]) -> str:
    return " | ".join(f'"{value}"' for value in values)


def _nonnull_any_of(schema: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    variants = schema.get("anyOf", [])
    nonnull = [variant for variant in variants if variant.get("type") != "null"]
    nullable = len(nonnull) != len(variants)
    return nonnull, nullable


def _ts_type(schema: dict[str, Any]) -> str:
    if "$ref" in schema:
        return _schema_ref_name(schema)

    variants, nullable = _nonnull_any_of(schema)
    if variants:
        rendered = " | ".join(_ts_type(variant) for variant in variants)
        return f"{rendered} | null" if nullable else rendered

    if "enum" in schema:
        return _render_union([str(item) for item in schema["enum"]])

    if "const" in schema:
        return f'"{schema["const"]}"'

    schema_type = schema.get("type")
    if schema_type == "string":
        return "string"
    if schema_type in {"integer", "number"}:
        return "number"
    if schema_type == "boolean":
        return "boolean"
    if schema_type == "array":
        item_type = _ts_type(schema.get("items", {}))
        return f"Array<{item_type}>"
    if schema_type == "object":
        additional = schema.get("additionalProperties")
        if additional is True:
            return "Record<string, unknown>"
        if isinstance(additional, dict):
            return f"Record<string, {_ts_type(additional)}>"
        properties = schema.get("properties")
        if isinstance(properties, dict) and properties:
            inline = [f"{key}: {_ts_type(value)};" for key, value in properties.items()]
            return "{ " + " ".join(inline) + " }"
        return "Record<string, unknown>"
    if schema_type == "null":
        return "null"

    return "unknown"


def _extract_aliases(schemas: dict[str, dict[str, Any]]) -> list[str]:
    task_create = schemas["TaskCreateResponse"]["properties"]
    task_status = schemas["TaskStatusResponse"]["properties"]
    principal = schemas["PrincipalResponse"]["properties"]
    return [
        f"export type MechanismName = {_ts_type(task_create['mechanism'])};",
        f"export type TaskStatusName = {_ts_type(task_create['status'])};",
        f"export type PaymentStatusName = {_ts_type(task_status['payment_status'])};",
        f"export type AuthMethodName = {_ts_type(principal['auth_method'])};",
        (
            "export type ApiKeyScopeName = "
            f"{_ts_type(principal['scopes']['items'])};"
        ),
    ]


def _render_interface(name: str, schema: dict[str, Any]) -> str:
    properties = schema.get("properties", {})
    lines = [f"export interface {name} {{"]
    for field_name, field_schema in properties.items():
        lines.append(f"  {field_name}: {_ts_type(field_schema)};")
    lines.append("}")
    return "\n".join(lines)


def generate_typescript() -> str:
    from api.main import app

    openapi = app.openapi()
    schemas = openapi["components"]["schemas"]

    parts = [
        "// This file is generated by scripts/generate_frontend_api_types.py.",
        "// Do not edit by hand.",
        "",
    ]
    parts.extend(_extract_aliases(schemas))
    parts.append("")

    schema_names = _schema_names_with_dependencies(schemas)

    for name in schema_names:
        parts.append(_render_interface(name, schemas[name]))
        parts.append("")

    return "\n".join(parts).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if the generated file is stale.")
    args = parser.parse_args()

    rendered = generate_typescript()
    if args.check:
        current = OUTPUT_PATH.read_text(encoding="utf-8") if OUTPUT_PATH.exists() else ""
        if current != rendered:
            print(f"{OUTPUT_PATH} is out of date. Run scripts/generate_frontend_api_types.py.")
            return 1
        return 0

    OUTPUT_PATH.write_text(rendered, encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
