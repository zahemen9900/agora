#!/usr/bin/env python3
"""Export Agora GCS data, rewrite only storage_uri values, and import to S3."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any

import boto3
from botocore.exceptions import ClientError

OLD_PREFIX = "gs://agora-ai-1190-agora-data/"
NEW_PREFIX = "s3://agora-866160682016-data/"


def _run_gcloud(args: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["gcloud", *args], capture_output=True, check=True)


def _list_gcs_objects(bucket: str) -> list[dict[str, Any]]:
    result = _run_gcloud(["storage", "ls", "--recursive", "--json", f"gs://{bucket}/"])
    payload = json.loads(result.stdout.decode("utf-8"))
    objects: list[dict[str, Any]] = []
    for item in payload:
        if item.get("type") != "cloud_object":
            continue
        metadata = item.get("metadata") or {}
        name = str(metadata.get("name") or "")
        if not name:
            continue
        _safe_relative_key(name)
        objects.append(
            {
                "key": name,
                "generation": str(metadata.get("generation") or ""),
                "size": int(metadata.get("size") or 0),
                "content_type": str(metadata.get("contentType") or "application/octet-stream"),
                "updated": str(metadata.get("updated") or ""),
            }
        )
    objects.sort(key=lambda item: item["key"])
    return objects


def _safe_relative_key(key: str) -> PurePosixPath:
    candidate = PurePosixPath(key)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise ValueError(f"Unsafe object key: {key!r}")
    return candidate


def _local_path(root: Path, area: str, key: str) -> Path:
    path = root / area / Path(*_safe_relative_key(key).parts)
    resolved_root = (root / area).resolve()
    resolved = path.resolve()
    if not resolved.is_relative_to(resolved_root):
        raise ValueError(f"Object key escapes the export root: {key!r}")
    return path


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    path.chmod(0o600)


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def export_data(*, source_bucket: str, root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    original = root / "original"
    if original.exists():
        shutil.rmtree(original)
    original.mkdir(parents=True)

    before = _list_gcs_objects(source_bucket)
    _run_gcloud(
        [
            "storage",
            "rsync",
            "--recursive",
            f"gs://{source_bucket}/",
            str(original) + "/",
        ]
    )
    after = _list_gcs_objects(source_bucket)

    before_keys = {(item["key"], item["generation"]) for item in before}
    after_keys = {(item["key"], item["generation"]) for item in after}
    if before_keys != after_keys:
        raise RuntimeError("GCS object set changed during export; rerun the export")

    for item in before:
        path = _local_path(root, "original", item["key"])
        if not path.is_file():
            raise RuntimeError(f"Export is missing object: {item['key']}")
        payload = path.read_bytes()
        if len(payload) != item["size"]:
            raise RuntimeError(f"Export size mismatch: {item['key']}")
        item["original_sha256"] = _sha256(payload)
        item["rewritten_sha256"] = None
        item["changed"] = False

    manifest = {
        "source_bucket": source_bucket,
        "objects": before,
    }
    _write_json(root / "manifest.json", manifest)
    print(f"exported {len(before)} objects to {original}")


def _is_record_path(key: str) -> bool:
    path = PurePosixPath(key)
    if path.suffix.lower() != ".json":
        return False
    text = key
    if text.startswith("agora/users/") and any(
        marker in text for marker in ("/tasks/", "/sources/", "/tests/", "/benchmarks/")
    ):
        return True
    if text.startswith("users/") and "/tasks/" in text:
        return True
    if text.startswith("agora/benchmarks/") or text.startswith("agora/runtime/"):
        return True
    if text.startswith("workspaces/") and (
        text.endswith("/profile.json") or "/api_keys/" in text
    ):
        return True
    if text.startswith("users/") and text.endswith("/profile.json"):
        return True
    if text.startswith("api_keys/by_public_id/"):
        return True
    return False


def _rewrite_object(value: Any, *, counter: list[int]) -> Any:
    if isinstance(value, dict):
        updated: dict[str, Any] = {}
        for key, item in value.items():
            if (
                key == "storage_uri"
                and isinstance(item, str)
                and item.startswith(OLD_PREFIX)
            ):
                updated[key] = NEW_PREFIX + item[len(OLD_PREFIX):]
                counter[0] += 1
            else:
                updated[key] = _rewrite_object(item, counter=counter)
        return updated
    if isinstance(value, list):
        return [_rewrite_object(item, counter=counter) for item in value]
    return value


def rewrite_data(*, root: Path) -> None:
    manifest = _read_json(root / "manifest.json")
    rewritten_root = root / "rewritten"
    if rewritten_root.exists():
        shutil.rmtree(rewritten_root)
    rewritten_root.mkdir(parents=True)

    total_changes = 0
    for item in manifest["objects"]:
        key = item["key"]
        original_path = _local_path(root, "original", key)
        rewritten_path = _local_path(root, "rewritten", key)
        payload = original_path.read_bytes()
        item["rewritten_sha256"] = _sha256(payload)
        item["changed"] = False

        if _is_record_path(key):
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                if OLD_PREFIX.encode("utf-8") in payload:
                    raise RuntimeError(
                        f"Record contains a storage URI but is not valid JSON: {key}"
                    ) from None
                rewritten_path.parent.mkdir(parents=True, exist_ok=True)
                rewritten_path.write_bytes(payload)
                continue
            counter = [0]
            updated = _rewrite_object(parsed, counter=counter)
            if counter[0]:
                rewritten = json.dumps(
                    updated,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
                if OLD_PREFIX.encode("utf-8") in rewritten:
                    raise RuntimeError(
                        f"Recognized record still contains the old storage prefix: {key}"
                    )
                rewritten_path.parent.mkdir(parents=True, exist_ok=True)
                rewritten_path.write_bytes(rewritten)
                rewritten_path.chmod(0o600)
                item["rewritten_sha256"] = _sha256(rewritten)
                item["changed"] = True
                total_changes += counter[0]
                continue

        rewritten_path.parent.mkdir(parents=True, exist_ok=True)
        rewritten_path.write_bytes(payload)

    _write_json(root / "manifest.json", manifest)
    print(f"rewrote {total_changes} storage_uri values")


def _s3_client(profile: str, region: str) -> Any:
    return boto3.Session(profile_name=profile, region_name=region).client("s3")


def import_data(
    *,
    root: Path,
    destination_bucket: str,
    profile: str,
    region: str,
    apply: bool,
) -> None:
    manifest = _read_json(root / "manifest.json")
    client = _s3_client(profile, region)
    created = skipped = 0

    for item in manifest["objects"]:
        key = item["key"]
        path = _local_path(root, "rewritten", key)
        payload = path.read_bytes()
        digest = _sha256(payload)
        if digest != item["rewritten_sha256"]:
            raise RuntimeError(f"Rewritten file changed after manifest: {key}")

        try:
            response = client.get_object(Bucket=destination_bucket, Key=key)
            existing = response["Body"].read()
            if existing != payload:
                raise RuntimeError(f"Destination object already exists with different bytes: {key}")
            skipped += 1
            continue
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code not in {"NoSuchKey", "404", "NotFound"}:
                raise

        if not apply:
            created += 1
            continue

        metadata = {"agora-original-updated-at": item["updated"]}
        client.put_object(
            Bucket=destination_bucket,
            Key=key,
            Body=payload,
            ContentType=item["content_type"],
            Metadata=metadata,
            IfNoneMatch="*",
        )
        created += 1

    print(f"import: {created} to create, {skipped} already present")
    if not apply:
        print("dry-run; rerun with --apply to write")


def verify_data(*, root: Path, destination_bucket: str, profile: str, region: str) -> None:
    manifest = _read_json(root / "manifest.json")
    client = _s3_client(profile, region)
    expected = {item["key"]: item for item in manifest["objects"]}

    listed: set[str] = set()
    continuation: str | None = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": destination_bucket}
        if continuation:
            kwargs["ContinuationToken"] = continuation
        response = client.list_objects_v2(**kwargs)
        for item in response.get("Contents", []) or []:
            key = str(item["Key"])
            if key.startswith("_deploy/"):
                continue
            listed.add(key)
        if not response.get("IsTruncated"):
            break
        continuation = response.get("NextContinuationToken")

    missing = sorted(set(expected) - listed)
    extra = sorted(listed - set(expected))
    if missing or extra:
        raise RuntimeError(f"verify key mismatch: missing={missing[:5]} extra={extra[:5]}")

    for key, item in expected.items():
        response = client.get_object(Bucket=destination_bucket, Key=key)
        payload = response["Body"].read()
        if _sha256(payload) != item["rewritten_sha256"]:
            raise RuntimeError(f"verify hash mismatch: {key}")
        if _is_record_path(key):
            parsed = json.loads(payload)
            for uri in _iter_storage_uris(parsed):
                if uri.startswith(OLD_PREFIX):
                    raise RuntimeError(f"verify found old storage URI: {key}")

    print(f"verified {len(expected)} objects, no old storage_uri values")


def _iter_storage_uris(value: Any) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "storage_uri" and isinstance(item, str):
                found.append(item)
            else:
                found.extend(_iter_storage_uris(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(_iter_storage_uris(item))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-bucket", default="agora-ai-1190-agora-data")
    parser.add_argument("--destination-bucket", default="agora-866160682016-data")
    parser.add_argument("--root", type=Path, default=Path("/tmp/opencode/agora-aws-migration"))
    parser.add_argument("--profile", default="gsl-admin")
    parser.add_argument("--region", default="us-east-1")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("export")
    sub.add_parser("rewrite")
    import_parser = sub.add_parser("import")
    import_parser.add_argument("--apply", action="store_true")
    sub.add_parser("verify")

    args = parser.parse_args()
    if args.command == "export":
        export_data(source_bucket=args.source_bucket, root=args.root)
    elif args.command == "rewrite":
        rewrite_data(root=args.root)
    elif args.command == "import":
        import_data(
            root=args.root,
            destination_bucket=args.destination_bucket,
            profile=args.profile,
            region=args.region,
            apply=args.apply,
        )
    elif args.command == "verify":
        verify_data(
            root=args.root,
            destination_bucket=args.destination_bucket,
            profile=args.profile,
            region=args.region,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
