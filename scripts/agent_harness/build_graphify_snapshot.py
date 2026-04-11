"""Build a lightweight architecture snapshot for the AGORA repository.

This script creates graph-style outputs under ``graphify-out/<scope>/``:

- ``GRAPH_REPORT.md``: human-readable architecture summary
- ``graph.json``: nodes, edges, and summary metadata
- ``extraction.json``: extracted module facts for downstream tooling
- ``graph.html``: simple HTML viewer for the current snapshot

It intentionally avoids a heavy dependency chain and works from the repository's
existing Python environment.
"""

from __future__ import annotations

import argparse
import ast
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SCOPE = "agora-runtime"


@dataclass(frozen=True)
class ModuleFact:
    module: str
    path: str
    line_count: int
    community: str


def _scope_roots(scope: str) -> list[Path]:
    if scope == "agora-runtime":
        return [REPO_ROOT / "agora", REPO_ROOT / "tests", REPO_ROOT / "benchmarks"]
    if scope == "repo":
        return [REPO_ROOT]
    raise ValueError(f"Unsupported scope: {scope}")


def _module_name(path: Path) -> str:
    relative = path.relative_to(REPO_ROOT).with_suffix("")
    return ".".join(relative.parts)


def _community_for_path(path: Path) -> str:
    parts = path.relative_to(REPO_ROOT).parts
    if not parts:
        return "root"
    if parts[0] != "agora":
        return parts[0]
    if len(parts) <= 2:
        return "agora.core"
    return f"agora.{parts[1]}"


def _iter_python_files(scope: str) -> list[Path]:
    roots = _scope_roots(scope)
    files: list[Path] = []
    for root in roots:
        if root.is_file() and root.suffix == ".py":
            files.append(root)
            continue
        if not root.exists():
            continue
        for path in root.rglob("*.py"):
            if ".venv" in path.parts or "__pycache__" in path.parts or "graphify-out" in path.parts:
                continue
            files.append(path)
    return sorted(set(files))


def _parse_import_edges(module_facts: dict[str, ModuleFact]) -> list[dict[str, str]]:
    edge_set: set[tuple[str, str, str]] = set()
    known_modules = set(module_facts)
    for module_name, fact in module_facts.items():
        path = REPO_ROOT / fact.path
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                target = node.module
                if target in known_modules or target.startswith("agora"):
                    edge_set.add((module_name, target, "import"))
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    target = alias.name
                    if target in known_modules or target.startswith("agora"):
                        edge_set.add((module_name, target, "import"))
    edges = [
        {"source": source, "target": target, "kind": kind}
        for source, target, kind in sorted(edge_set)
    ]
    return edges


def _community_summary(
    module_facts: dict[str, ModuleFact],
    edges: list[dict[str, str]],
) -> list[dict[str, Any]]:
    modules_by_community: dict[str, list[str]] = defaultdict(list)
    for module_name, fact in module_facts.items():
        modules_by_community[fact.community].append(module_name)

    edge_counter: Counter[tuple[str, str]] = Counter()
    for edge in edges:
        source_fact = module_facts.get(edge["source"], ModuleFact("", "", 0, "external"))
        target_fact = module_facts.get(edge["target"], ModuleFact("", "", 0, "external"))
        source_community = source_fact.community
        target_community = target_fact.community
        edge_counter[(source_community, target_community)] += 1

    communities: list[dict[str, Any]] = []
    for name, modules in sorted(modules_by_community.items()):
        communities.append(
            {
                "name": name,
                "module_count": len(modules),
                "modules": sorted(modules),
                "outbound_links": [
                    {"target": target, "count": count}
                    for (source, target), count in sorted(edge_counter.items())
                    if source == name and target != name
                ],
            }
        )
    return communities


def _build_snapshot(scope: str) -> dict[str, Any]:
    module_facts: dict[str, ModuleFact] = {}
    for path in _iter_python_files(scope):
        text = path.read_text(encoding="utf-8")
        module_name = _module_name(path)
        module_facts[module_name] = ModuleFact(
            module=module_name,
            path=str(path.relative_to(REPO_ROOT)).replace("\\", "/"),
            line_count=len(text.splitlines()),
            community=_community_for_path(path),
        )

    edges = _parse_import_edges(module_facts)
    indegree = Counter(edge["target"] for edge in edges)
    outdegree = Counter(edge["source"] for edge in edges)

    nodes = [
        {
            "id": fact.module,
            "path": fact.path,
            "line_count": fact.line_count,
            "community": fact.community,
            "inbound": indegree.get(fact.module, 0),
            "outbound": outdegree.get(fact.module, 0),
        }
        for fact in sorted(module_facts.values(), key=lambda item: item.module)
    ]

    summary = {
        "scope": scope,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "top_hubs": [
            {"module": module, "inbound": count}
            for module, count in indegree.most_common(10)
        ],
        "top_broadcasters": [
            {"module": module, "outbound": count}
            for module, count in outdegree.most_common(10)
        ],
        "communities": _community_summary(module_facts, edges),
    }

    return {
        "summary": summary,
        "nodes": nodes,
        "edges": edges,
    }


def _suggested_questions(summary: dict[str, Any]) -> list[str]:
    questions = [
        (
            "Which interfaces must remain stable between the runtime core and the "
            "missing integration tracks?"
        ),
        "Which modules should own the runtime-to-chain receipt contract to avoid drift?",
        "Where does the current design rely on README intent rather than implemented behavior?",
    ]
    if any(hub["module"] == "agora.types" for hub in summary.get("top_hubs", [])):
        questions.append(
            "Should the shared type system be split into runtime contracts vs "
            "integration contracts?"
        )
    if any(
        hub["module"] == "agora.runtime.orchestrator"
        for hub in summary.get("top_broadcasters", [])
    ):
        questions.append(
            "Is the orchestrator the right place to coordinate settlement, or should "
            "submission live behind a service boundary?"
        )
    return questions


def _surprising_connections(edges: list[dict[str, str]]) -> list[str]:
    findings: list[str] = []
    normalized = {(edge["source"], edge["target"]) for edge in edges}
    if ("agora.runtime.orchestrator", "agora.runtime.hasher") in normalized:
        findings.append(
            "The orchestrator builds receipts directly instead of delegating to a "
            "settlement adapter."
        )
    if ("agora.engines.debate", "agora.runtime.monitor") in normalized:
        findings.append(
            "The debate engine owns adaptive control decisions through the shared "
            "monitor, making monitor semantics a system-wide risk point."
        )
    if ("agora.sdk.arbitrator", "agora.runtime.orchestrator") in normalized:
        findings.append(
            "The SDK is only a thin facade over the orchestrator, not yet a real "
            "integration boundary."
        )
    if ("agora.solana.__init__", "agora.solana.client") in normalized:
        findings.append(
            "The Solana package exists structurally, but its graph footprint confirms "
            "it is still an empty boundary."
        )
    return findings


def _write_report(snapshot: dict[str, Any], output_dir: Path) -> None:
    summary = snapshot["summary"]
    lines: list[str] = []
    lines.append(f"# GRAPH REPORT: {summary['scope']}")
    lines.append("")
    lines.append("## Overview")
    lines.append("")
    lines.append(f"- Nodes: {summary['node_count']}")
    lines.append(f"- Edges: {summary['edge_count']}")
    lines.append("")
    lines.append("## Community Labels")
    lines.append("")
    for community in summary["communities"]:
        lines.append(
            f"- `{community['name']}`: {community['module_count']} modules"
        )
    lines.append("")
    lines.append("## Hub Nodes")
    lines.append("")
    for hub in summary["top_hubs"]:
        lines.append(f"- `{hub['module']}`: {hub['inbound']} inbound imports")
    lines.append("")
    lines.append("## Broadcaster Nodes")
    lines.append("")
    for hub in summary["top_broadcasters"]:
        lines.append(f"- `{hub['module']}`: {hub['outbound']} outbound imports")
    lines.append("")
    lines.append("## Surprising Connections")
    lines.append("")
    for item in _surprising_connections(snapshot["edges"]):
        lines.append(f"- {item}")
    lines.append("")
    lines.append("## Suggested Questions")
    lines.append("")
    for question in _suggested_questions(summary):
        lines.append(f"- {question}")
    lines.append("")
    lines.append("## Nodes")
    lines.append("")
    for node in snapshot["nodes"]:
        lines.append(
            f"- `{node['id']}` [{node['community']}] "
            f"in={node['inbound']} out={node['outbound']} "
            f"lines={node['line_count']}"
        )
    lines.append("")
    lines.append("## Edges")
    lines.append("")
    for edge in snapshot["edges"]:
        lines.append(f"- `{edge['source']}` -> `{edge['target']}`")
    output_dir.joinpath("GRAPH_REPORT.md").write_text("\n".join(lines), encoding="utf-8")


def _write_html(snapshot: dict[str, Any], output_dir: Path) -> None:
    payload = json.dumps(snapshot, ensure_ascii=True)
    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AGORA Graph Snapshot</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; }}
    pre {{ white-space: pre-wrap; background: #f4f4f4; padding: 16px; border-radius: 8px; }}
  </style>
</head>
<body>
  <h1>AGORA Graph Snapshot</h1>
  <p>This is a lightweight viewer for the generated graph snapshot.</p>
  <pre id="payload"></pre>
  <script>
    const payload = {payload};
    document.getElementById("payload").textContent = JSON.stringify(payload, null, 2);
  </script>
</body>
</html>
"""
    output_dir.joinpath("graph.html").write_text(html, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scope", default=DEFAULT_SCOPE, choices=["agora-runtime", "repo"])
    args = parser.parse_args()

    snapshot = _build_snapshot(args.scope)
    output_dir = REPO_ROOT / "graphify-out" / args.scope
    output_dir.mkdir(parents=True, exist_ok=True)

    output_dir.joinpath("graph.json").write_text(
        json.dumps(snapshot, indent=2), encoding="utf-8"
    )
    extraction = {
        "scope": args.scope,
        "modules": snapshot["nodes"],
        "communities": snapshot["summary"]["communities"],
    }
    output_dir.joinpath("extraction.json").write_text(
        json.dumps(extraction, indent=2), encoding="utf-8"
    )
    _write_report(snapshot, output_dir)
    _write_html(snapshot, output_dir)


if __name__ == "__main__":
    main()
